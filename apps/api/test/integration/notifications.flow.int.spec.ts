import type { Prisma, PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import type { LegacyConnection, LegacyDbService, LogTouch } from '../../src/import/legacy-db.service';
import { LegacyImportService } from '../../src/import/legacy-import.service';
import { ItemsService } from '../../src/master-data/items/items.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrder,
  addSublot,
  emailProcessor,
  makePrisma,
  resetDb,
  seedActor,
  services,
} from './support';

// §17 notifications (vendor UG ch.22): the rule engine (resolution, recipients,
// queue-time rendering), the emitters at real mutation seams, the SMTP
// dispatcher over the FakeMailTransport seam, rules CRUD, and the import specs
// for the mirrored tables — all against real Postgres.

const NATIVE = 1_000_000_000;
let prisma: PrismaClient;
let actor: Actor;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  actor = await seedActor(prisma);
});

function itemsService() {
  const { audit, notifications } = services(prisma);
  return new ItemsService(prisma as unknown as PrismaService, audit, notifications);
}

// The engine accepts any client with the Prisma query surface; for direct
// emit tests the base client doubles as the "transaction".
const asTx = () => prisma as unknown as Prisma.TransactionClient;

async function addRule(data: {
  id?: number;
  code: string;
  group?: string;
  sendTo?: string | null;
  subject?: string;
  text?: string;
  listOnly?: boolean;
}) {
  return prisma.notification.create({
    data: {
      id: data.id ?? undefined,
      notificationCode: data.code,
      securityGroup: data.group ?? '*',
      sendTo: data.sendTo ?? null,
      subject: data.subject ?? `${data.code} happened for @ItemCode`,
      text: data.text ?? 'ItemCode: @ItemCode <br/>\nDescription: @Description <br/>',
      useSendtoListOnly: data.listOnly ?? false,
    },
  });
}

const allEmails = () => prisma.emailSent.findMany({ orderBy: { id: 'asc' } });

describe('NotificationEngineService.emit (rule resolution + recipients + rendering)', () => {
  it('queues a fully rendered e-mail from a real mutation (item create), native id, in the same transaction', async () => {
    await addRule({ code: 'New Item Notification', sendTo: 'ops@plant.local; qa@plant.local' });
    await itemsService().create({ itemCode: 'NEW-1', description: 'Fancy <Red> Ink', unit: 'lb' }, actor);

    const emails = await allEmails();
    expect(emails).toHaveLength(1);
    const e = emails[0];
    expect(e.id).toBeGreaterThan(NATIVE);
    expect(e.status).toBe('Not sent');
    expect(e.notificationCode).toBe('New Item Notification');
    // Rule send-to + the contextual creator address, deduped, joined.
    expect(e.sendTo).toBe('ops@plant.local; qa@plant.local; flow@test.local');
    expect(e.subject).toBe('New Item Notification happened for NEW-1');
    // Rendered at queue time: substituted, HTML-escaped, wrapped in the shell.
    expect(e.text).toContain('ItemCode: NEW-1');
    expect(e.text).toContain('Description: Fancy &lt;Red&gt; Ink');
    expect(e.text).toContain('<html');
  });

  it('resolves the exact security-group rule first, falls back to *, and skips without any rule', async () => {
    const { notifications } = services(prisma);
    await addRule({ code: 'New Item Notification', group: 'GRPA', sendTo: 'grpa@plant.local' });
    await addRule({ code: 'New Item Notification', group: '*', sendTo: 'star@plant.local' });

    const exact = await notifications.emit(asTx(), 'New Item Notification', {
      securityGroup: 'GRPA',
      params: { ItemCode: 'X', Description: 'x' },
    });
    expect(exact.queued).toBe(true);
    const fallback = await notifications.emit(asTx(), 'New Item Notification', {
      securityGroup: 'OTHER',
      params: { ItemCode: 'Y', Description: 'y' },
    });
    expect(fallback.queued).toBe(true);
    const none = await notifications.emit(asTx(), 'Purchase receipt', {
      params: { Item: 'Z' },
    });
    expect(none).toEqual({ queued: false, reason: 'no rule configured' });

    const emails = await allEmails();
    expect(emails.map((e) => e.sendTo)).toEqual(['grpa@plant.local', 'star@plant.local']);
  });

  it('Use Sendto List Only suppresses contextual recipients; no recipients at all -> not queued', async () => {
    const { notifications } = services(prisma);
    await addRule({ code: 'New Item Notification', sendTo: 'only@plant.local', listOnly: true });
    const r1 = await notifications.emit(asTx(), 'New Item Notification', {
      contextEmails: ['creator@plant.local'],
      params: { ItemCode: 'A', Description: 'a' },
    });
    expect(r1.queued).toBe(true);
    expect((await allEmails())[0].sendTo).toBe('only@plant.local');

    await prisma.notification.update({ where: { id: (await prisma.notification.findFirst())!.id }, data: { sendTo: null } });
    const r2 = await notifications.emit(asTx(), 'New Item Notification', {
      contextEmails: ['creator@plant.local'],
      params: { ItemCode: 'B', Description: 'b' },
    });
    expect(r2).toEqual({ queued: false, reason: 'no recipients' });
  });

  it('walks the owner hierarchy for NotificationDetail send-to additions (first level with entries wins)', async () => {
    const { notifications } = services(prisma);
    // CMS(1) <- site(4) <- area(9)
    await addEntity(prisma, { id: 1, code: 'CMS' });
    await prisma.entity.update({ where: { id: 1 }, data: {} });
    await addEntity(prisma, { id: 4, code: 'SITE' });
    await prisma.entity.update({ where: { id: 4 }, data: { parentId: 1 } });
    await addEntity(prisma, { id: 9, code: 'AREA' });
    await prisma.entity.update({ where: { id: 9 }, data: { parentId: 4 } });

    const rule = await addRule({ code: 'New Item Notification', sendTo: 'hdr@plant.local' });
    await prisma.notificationDetail.create({ data: { notificationId: rule.id, ownerId: 4, sendTo: 'site@plant.local' } });

    // Area has no entry -> the site's is used (added to the header list).
    const viaParent = await notifications.emit(asTx(), 'New Item Notification', {
      ownerId: 9,
      params: { ItemCode: 'C', Description: 'c' },
    });
    expect(viaParent.queued).toBe(true);
    expect((await allEmails())[0].sendTo).toBe('hdr@plant.local; site@plant.local');

    // Now the area gets its own entry — the walk stops there (site not added).
    await prisma.notificationDetail.create({ data: { notificationId: rule.id, ownerId: 9, sendTo: 'area@plant.local' } });
    await notifications.emit(asTx(), 'New Item Notification', {
      ownerId: 9,
      params: { ItemCode: 'D', Description: 'd' },
    });
    const emails = await allEmails();
    expect(emails[1].sendTo).toBe('hdr@plant.local; area@plant.local');
  });
});

describe('order lifecycle emitters', () => {
  it('release emits the released notification with order params and a deep link when baseUrl is set', async () => {
    const { orders, settings } = services(prisma);
    await settings.set('notifications.baseUrl', 'https://erp1.plant');
    await addEntity(prisma, { id: 4, code: 'PRECISION' });
    await addItem(prisma, { id: 10, code: 'E6193' });
    await prisma.item.update({ where: { id: 10 }, data: { description: 'WARM GRAY 10' } });
    await addOrder(prisma, { id: 600, context: 'MFBA', status: 'NST', ownerId: 4 });
    await addOrdDetail(prisma, { id: 700, ordrId: 600, context: 'PK', itemId: 10, qtyReqd: 100 });
    await addRule({
      code: 'Manufacturing Order Released Notification',
      sendTo: 'ops@plant.local',
      subject: 'Order @Ordr released',
      text: 'Area: @Area <br/>Ordr: @Ordr <br/>ItemCode: @ItemCode <br/>QtyReqd: @QtyReqd <br/>',
    });

    await orders.release(600, actor);

    const emails = await allEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('Order 600 released');
    expect(emails[0].text).toContain('Area: PRECISION');
    expect(emails[0].text).toContain('<a href="https://erp1.plant/orders?focus=600">600</a>');
    expect(emails[0].text).toContain('ItemCode: E6193');
    expect(emails[0].text).toContain('QtyReqd: 100');
  });

  it('a mutation with NO matching rule queues nothing (the normal case)', async () => {
    await addOrder(prisma, { id: 601, context: 'MFBA', status: 'NST' });
    const { orders } = services(prisma);
    await orders.release(601, actor);
    expect(await prisma.emailSent.count()).toBe(0);
  });
});

describe('purchase receipt emitter', () => {
  it('emits one notification per received lot with receipt params', async () => {
    const { purchasing } = services(prisma);
    await addEntity(prisma, { id: 50, code: 'ACME', isSupplier: true });
    await addItem(prisma, { id: 20, code: 'INGA' });
    await addOrder(prisma, { id: 3000, context: 'PO', entityId: 50, poNumber: 'PO-77' });
    await addOrdDetail(prisma, { id: 30001, ordrId: 3000, context: 'PO', itemId: 20, qtyReqd: 10 });
    await addRule({
      code: 'Purchase receipt',
      sendTo: 'recv@plant.local',
      subject: 'Received @Item',
      text: 'PONumber: @PONumber <br/>Receipt: @Receipt <br/>Item: @Item <br/>Lot: @Lot <br/>SupLot: @SupLot <br/>',
    });

    const res = await purchasing.receive(
      3000,
      { lines: [{ ordDetailId: 30001, lots: [{ qty: 4, manufacturerLot: 'MFR-1' }, { qty: 6, manufacturerLot: 'MFR-2' }] }] },
      actor,
    );

    const emails = await allEmails();
    expect(emails).toHaveLength(2);
    expect(emails[0].subject).toBe('Received INGA');
    expect(emails[0].text).toContain('PONumber: PO-77');
    expect(emails[0].text).toContain(`Lot: ${res.lots[0].lot}`);
    expect(emails[0].text).toContain('SupLot: MFR-1');
    expect(emails[1].text).toContain('SupLot: MFR-2');
    // Receipt param = the receipt's ChangeSet id (native range).
    expect(emails[0].text).toMatch(/Receipt: 10000000\d+/);
  });
});

describe('reweigh-outside-threshold emitter (inventory adjust)', () => {
  async function parcel(qty: number) {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 30, code: 'BULK1' });
    await addLot(prisma, { lot: 'L1', itemId: 30 });
    await addSublot(prisma, { id: 1, lot: 'L1' });
    return addInventory(prisma, { itemId: 30, sublotId: 1, locationId: 1, qty });
  }

  it('fires beyond the threshold percentage, stays quiet within it', async () => {
    const invId = await parcel(100);
    const { inventory } = services(prisma);
    await addRule({
      code: 'Reweigh Outside Threshold',
      sendTo: 'wh@plant.local',
      subject: 'Reweigh @ItemCode',
      text: 'Adjustment: @Adjustment <br/>MaxVariance: @MaxVariance <br/>OriginalQty: @OriginalQty <br/>Lot: @Lot <br/>',
    });

    // 3% move on a 5% default threshold: no e-mail.
    await inventory.adjust({ inventoryId: invId, newQty: 97, reason: 'count' }, actor);
    expect(await prisma.emailSent.count()).toBe(0);

    // 10.3% move (10/97): fires with the numbers.
    await inventory.adjust({ inventoryId: invId, newQty: 87, reason: 'count' }, actor);
    const emails = await allEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('Reweigh BULK1');
    expect(emails[0].text).toContain('Adjustment: -10');
    expect(emails[0].text).toContain('OriginalQty: 97');
    expect(emails[0].text).toContain('Lot: L1');
  });

  it('threshold 0 disables the check', async () => {
    const invId = await parcel(100);
    const { inventory, settings } = services(prisma);
    await settings.set('inventory.reweighThreshold', '0');
    await addRule({ code: 'Reweigh Outside Threshold', sendTo: 'wh@plant.local' });
    await inventory.adjust({ inventoryId: invId, newQty: 1, reason: 'count' }, actor);
    expect(await prisma.emailSent.count()).toBe(0);
  });
});

describe('EmailProcessorService (dispatch over the transport seam)', () => {
  async function queueNative(id: number, sendTo = 'ops@plant.local') {
    await prisma.emailSent.create({
      data: { id, sendTo, subject: `S${id}`, text: '<p>t</p>', notificationCode: 'New Item Notification' },
    });
  }
  async function smtpOn() {
    const { settings } = services(prisma);
    await settings.set('notifications.enabled', 'true');
    await settings.set('smtp.host', 'mail.plant.local');
    await settings.set('smtp.from', 'ERP1 <erp1@plant.local>');
  }

  it('skips when delivery is disabled or SMTP is unconfigured', async () => {
    const { processor } = emailProcessor(prisma);
    expect((await processor.processPending()).skipped).toBe('disabled');
    const { settings } = services(prisma);
    await settings.set('notifications.enabled', 'true');
    expect((await processor.processPending()).skipped).toBe('unconfigured');
  });

  it('sends pending NATIVE rows only — imported legacy history is never dispatched', async () => {
    await smtpOn();
    await queueNative(NATIVE + 1);
    // A 2022 legacy row imported as history (id in the legacy range).
    await prisma.emailSent.create({ data: { id: 516, sendTo: 'vmiller@precisioninkcorp.com', subject: 'old', text: 'x' } });

    const { processor, transport } = emailProcessor(prisma);
    const res = await processor.processPending();
    expect(res).toEqual({ sent: 1, failed: 0, recovered: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toEqual(['ops@plant.local']);
    expect(transport.sent[0].from).toBe('ERP1 <erp1@plant.local>');

    const native = await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } });
    expect(native!.status).toBe('Sent');
    expect(native!.sentAt).not.toBeNull();
    expect(native!.attempts).toBe(1);
    expect(native!.claimedAt).not.toBeNull();
    const legacy = await prisma.emailSent.findUnique({ where: { id: 516 } });
    expect(legacy!.status).toBe('Not sent');
    expect(legacy!.attempts).toBe(0);
  });

  it('retries transient failures and parks the e-mail as Failed at the attempt cap', async () => {
    await smtpOn();
    await queueNative(NATIVE + 1);
    const { processor, transport } = emailProcessor(prisma);
    transport.failWith = 'connect ECONNREFUSED';

    for (let i = 1; i <= 4; i++) {
      const res = await processor.processPending();
      expect(res).toEqual({ sent: 0, failed: 1, recovered: 0 });
      const row = await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } });
      expect(row!.status).toBe('Not sent');
      expect(row!.attempts).toBe(i);
      expect(row!.error).toContain('ECONNREFUSED');
    }
    await processor.processPending(); // 5th attempt -> parked
    const parked = await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } });
    expect(parked!.status).toBe('Failed');
    expect(parked!.attempts).toBe(5);

    // Nothing pending anymore.
    expect(await processor.processPending()).toEqual({ sent: 0, failed: 0, recovered: 0 });

    // Re-queue (operator action) -> sends once the transport recovers.
    const { notificationRules } = services(prisma);
    await notificationRules.requeue(NATIVE + 1, actor);
    transport.failWith = null;
    expect(await processor.processPending()).toEqual({ sent: 1, failed: 0, recovered: 0 });
    expect((await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } }))!.status).toBe('Sent');
  });

  it('parks rows without any valid recipient immediately', async () => {
    await smtpOn();
    await queueNative(NATIVE + 1, 'not-an-address');
    const { processor, transport } = emailProcessor(prisma);
    expect(await processor.processPending()).toEqual({ sent: 0, failed: 1, recovered: 0 });
    expect(transport.sent).toHaveLength(0);
    const row = await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } });
    expect(row!.status).toBe('Failed');
    expect(row!.error).toContain('No valid recipient');
  });

  it('the attempt count is durable at claim time and delivery happens OUTSIDE any tx: a crashed claim is recovered by the sweep, a fresh one is left in flight', async () => {
    await smtpOn();
    // A claim orphaned by a crash 11 minutes ago -> swept back and redelivered.
    await prisma.emailSent.create({
      data: { id: NATIVE + 1, sendTo: 'ops@plant.local', subject: 'crashed', text: 'x', status: 'Sending', attempts: 1, claimedAt: new Date(Date.now() - 11 * 60_000) },
    });
    // A crash-looped claim already at the cap -> swept to Failed, not resent.
    await prisma.emailSent.create({
      data: { id: NATIVE + 2, sendTo: 'ops@plant.local', subject: 'looped', text: 'x', status: 'Sending', attempts: 5, claimedAt: new Date(Date.now() - 11 * 60_000) },
    });
    // A live in-flight claim (30s old) -> untouched.
    await prisma.emailSent.create({
      data: { id: NATIVE + 3, sendTo: 'ops@plant.local', subject: 'in flight', text: 'x', status: 'Sending', attempts: 1, claimedAt: new Date(Date.now() - 30_000) },
    });

    const { processor, transport } = emailProcessor(prisma);
    const res = await processor.processPending();
    expect(res).toEqual({ sent: 1, failed: 0, recovered: 2 });
    expect(transport.sent.map((m) => m.subject)).toEqual(['crashed']);
    expect((await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } }))!.status).toBe('Sent');
    expect((await prisma.emailSent.findUnique({ where: { id: NATIVE + 1 } }))!.attempts).toBe(2);
    expect((await prisma.emailSent.findUnique({ where: { id: NATIVE + 2 } }))!.status).toBe('Failed');
    const inFlight = await prisma.emailSent.findUnique({ where: { id: NATIVE + 3 } });
    expect(inFlight!.status).toBe('Sending');
    expect(inFlight!.attempts).toBe(1);
  });
});

describe('Tests Completed emitter (transition-only)', () => {
  it('fires when the LAST open result is filled, not on later corrections', async () => {
    const { releases } = services(prisma);
    await addLocation(prisma, { id: 1, code: 'LAB' });
    await addItem(prisma, { id: 60, code: 'QCITEM' });
    await addLot(prisma, { lot: 'QL1', itemId: 60 });
    await addSublot(prisma, { id: 1, lot: 'QL1' });
    await prisma.release.create({ data: { id: 1, sublotId: 1, sampleSetId: 77, status: 'Hold' } });
    await prisma.locationSampleTest.createMany({
      data: [
        { id: 1, locationId: 1, test: 'pH', sampleSetId: 77 },
        { id: 2, locationId: 1, test: 'Visc', sampleSetId: 77 },
      ],
    });
    await addRule({
      code: 'Tests Completed Notification',
      sendTo: 'qa@plant.local',
      subject: 'Tests done for @ItemCode',
      text: 'Release: @Release <br/>Lot: @Lot <br/>',
    });

    // First result only -> set still incomplete, no e-mail.
    await releases.enterResults(1, { results: [{ id: 1, result: '7.1' }] }, actor);
    expect(await prisma.emailSent.count()).toBe(0);

    // Last open result filled -> the transition fires exactly one e-mail.
    await releases.enterResults(1, { results: [{ id: 2, result: '250' }] }, actor);
    const emails = await allEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe('Tests done for QCITEM');
    expect(emails[0].text).toContain('Lot: QL1');

    // A correction to an already-complete set must NOT re-notify.
    await releases.enterResults(1, { results: [{ id: 1, result: '7.2' }] }, actor);
    expect(await prisma.emailSent.count()).toBe(1);
  });
});

describe('NotificationsService (rules CRUD + e-mail log)', () => {
  it('creates, updates, deletes rules with uniqueness + catalog validation and audit rows', async () => {
    const { notificationRules } = services(prisma);
    const rule = await notificationRules.createRule(
      { notificationCode: 'MFO Created Notification', sendTo: 'a@b.c', subject: 's', text: 't' },
      actor,
    );
    expect(rule.id).toBeGreaterThan(NATIVE);
    expect(rule.securityGroup).toBe('*');

    await expect(
      notificationRules.createRule({ notificationCode: 'MFO Created Notification' }, actor),
    ).rejects.toThrow(/already exists/);
    await expect(notificationRules.createRule({ notificationCode: 'Bogus Code' }, actor)).rejects.toThrow(/Unknown notification code/);

    const updated = await notificationRules.updateRule(rule.id, { securityGroup: 'GRPA', useSendtoListOnly: true }, actor);
    expect(updated.securityGroup).toBe('GRPA');
    expect(updated.useSendtoListOnly).toBe(true);
    expect(updated.version).toBe(2);

    await addEntity(prisma, { id: 4, code: 'SITE' });
    const detail = await notificationRules.addDetail(rule.id, { ownerId: 4, sendTo: 'site@plant.local' }, actor);
    expect(detail.ownerCode).toBe('SITE');

    const overview = await notificationRules.overview();
    expect(overview.rules).toHaveLength(1);
    expect(overview.rules[0].details).toHaveLength(1);
    expect(overview.catalog.length).toBeGreaterThan(30);

    await notificationRules.deleteRule(rule.id, actor);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.notificationDetail.count()).toBe(0);

    expect(await prisma.auditLog.count()).toBeGreaterThanOrEqual(4);
  });

  it('refuses to re-queue legacy history and non-failed rows', async () => {
    const { notificationRules } = services(prisma);
    await prisma.emailSent.create({ data: { id: 100, sendTo: 'x@y.z', subject: 'legacy', text: 'x', status: 'Failed' } });
    await expect(notificationRules.requeue(100, actor)).rejects.toThrow(/Legacy history/);
    await prisma.emailSent.create({ data: { id: NATIVE + 1, sendTo: 'x@y.z', subject: 's', text: 'x', status: 'Sent' } });
    await expect(notificationRules.requeue(NATIVE + 1, actor)).rejects.toThrow(/Only failed/);
  });
});

describe('planning notifications (Short / Expedite / Testing Required on recalc)', () => {
  it('emits one summary e-mail per kind with an @Table listing', async () => {
    const { planningRecalc } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'PRECISION' });
    await addItem(prisma, { id: 40, code: 'MS-ITEM' });
    await prisma.itemEntity.create({ data: { id: 1, itemId: 40, entityId: 4, context: 'ST', minimumStock: 50 } });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    // 10 on hand but quarantined (Hold) -> consumed as Retest.
    await addLot(prisma, { lot: 'Q1', itemId: 40 });
    await addSublot(prisma, { id: 1, lot: 'Q1' });
    await addInventory(prisma, { itemId: 40, sublotId: 1, locationId: 1, qty: 10 });
    await prisma.release.create({ data: { id: 1, sublotId: 1, status: 'Hold' } });
    // A late PO for 8 (promised yesterday -> expedite).
    await addOrder(prisma, { id: 3000, context: 'PO' });
    await prisma.ordDetail.create({
      data: { id: 30001, ordrId: 3000, context: 'PO', itemId: 40, qtyReqd: 8, datePromised: new Date(Date.now() - 86_400_000) },
    });

    for (const code of ['Inventory Short Notification', 'Inventory Expedite Notification', 'Testing Required Notification']) {
      await addRule({ code, sendTo: 'plan@plant.local', subject: code, text: 'Area: @Area <br/>@Table' });
    }

    await planningRecalc.recalculate(actor);

    const emails = await allEmails();
    expect(emails.map((e) => e.subject).sort()).toEqual([
      'Inventory Expedite Notification',
      'Inventory Short Notification',
      'Testing Required Notification',
    ]);
    const short = emails.find((e) => e.subject === 'Inventory Short Notification')!;
    expect(short.text).toContain('Area: PRECISION');
    expect(short.text).toContain('<td>MS-ITEM</td>');
    expect(short.text).toContain('<td>32</td>'); // 50 - 10 held - 8 on order
    const expedite = emails.find((e) => e.subject === 'Inventory Expedite Notification')!;
    expect(expedite.text).toContain('PO#3000+');
    const retest = emails.find((e) => e.subject === 'Testing Required Notification')!;
    expect(retest.text).toContain('<td>Q1</td>');
  });
});

describe('legacy import of the notification tables (never-logged wholesale copies)', () => {
  class MiniLegacy {
    maxLog = 100;
    tables = new Map<string, Record<string, unknown>[]>();
    columns = new Map<string, string[]>();
    setTable(t: string, cols: string[], rows: Record<string, unknown>[]) {
      this.tables.set(t, rows);
      this.columns.set(t, cols);
    }
    async open(): Promise<LegacyConnection> {
      const self = this;
      return {
        async maxLogId() { return self.maxLog; },
        async logDelta(): Promise<LogTouch[]> { return []; },
        async tableColumns(t: string) { return self.columns.get(t) ?? []; },
        async fetchAll(t: string) { return self.tables.get(t) ?? []; },
        async fetchByKeys() { return []; },
        async fetchNewRows() { return []; },
        async countRows(t: string) { return (self.tables.get(t) ?? []).length; },
        async close() {},
      };
    }
  }

  it('copies Notification (boolean canonicalized), NotificationDetail and EmailSent history', async () => {
    const fake = new MiniLegacy();
    fake.setTable('dbo.Notification', ['Notification', 'NotificationCode', 'SecurityGroup', 'Version', 'SendTo', 'Subject', 'Text', 'UseSendtoListOnly'], [
      { Notification: 5, NotificationCode: 'MFO Created Notification', SecurityGroup: '*', Version: 2, SendTo: null, Subject: 'A manufacturing order has been created / edited', Text: '<br/>Ordr: @Ordr <br/>', UseSendtoListOnly: null },
      { Notification: 86, NotificationCode: 'ServiceInvoiceNotification', SecurityGroup: '*', Version: 1, SendTo: 'akoves@mar-kov.com', Subject: 'Mar-Kov Service Invoice', Text: '<pre>@Data</pre>', UseSendtoListOnly: true },
    ]);
    fake.setTable('dbo.NotificationDetail', ['NotificationDetail', 'Notification', 'Owner', 'SendTo'], [
      { NotificationDetail: 1, Notification: 5, Owner: 4, SendTo: 'vmiller@precisioninkcorp.com' },
    ]);
    fake.setTable('dbo.EmailSent', ['EmailSent', 'SendTo', 'Subject', 'Text', 'DateCreated', 'Log', 'Step', 'Status', 'MailItemId', 'Error'], [
      { EmailSent: 516, SendTo: 'vmiller@precisioninkcorp.com', Subject: 'A manufacturing order has been created / edited', Text: '<html>…</html>', DateCreated: new Date('2022-07-01T14:09:19Z'), Log: 440098, Step: 19, Status: 'Not sent', MailItemId: null, Error: null },
    ]);

    const { genealogy } = services(prisma);
    const res = await new LegacyImportService(
      prisma as unknown as PrismaService,
      genealogy,
      fake as unknown as LegacyDbService,
    ).run('tester');
    expect(res.status).toBe('success');

    const rules = await prisma.notification.findMany({ orderBy: { id: 'asc' } });
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe(5);
    expect(rules[0].useSendtoListOnly).toBe(false); // NULL canonicalized
    expect(rules[1].useSendtoListOnly).toBe(true);
    expect(await prisma.notificationDetail.count()).toBe(1);
    const legacyEmail = await prisma.emailSent.findUnique({ where: { id: 516 } });
    expect(legacyEmail!.status).toBe('Not sent');
    expect(legacyEmail!.log).toBe(440098);
    expect(legacyEmail!.attempts).toBe(0);
  });
});
