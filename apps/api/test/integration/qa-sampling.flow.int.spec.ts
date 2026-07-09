import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { NATIVE_ID_BASE } from '../../src/common/locks';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrder,
  addSublot,
  makePrisma,
  resetDb,
  seedActor,
  services,
} from './support';

// Native QA sampling (ASSUMPTIONS §21): every ERP1-born sublot gets a Release
// at birth — Approved at the receiving/opening seams, Hold + a native sample
// set (retained-sample split, pre-created result rows, 'New Sample set'
// notification) at completion for tested products. Reversal unwinds it all,
// and QA work already begun pins the batch.

const SAMPLE_LB = 0.005 * 2.2046226218487757;
// reverse() only accepts natively-completed orders (id ≥ 1e9) — fixtures that
// exercise it (and the retained-sample/CofA flows built on it) use this id.
const OID = NATIVE_ID_BASE + 800;
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

async function addItemTest(itemId: number, test: string, extra?: { min?: number; max?: number; testGroup?: string }) {
  await prisma.itemTest.create({
    data: { itemId, test, min: extra?.min ?? null, max: extra?.max ?? null, testGroup: extra?.testGroup ?? 'DEFAULT', onProduction: true, onReceipt: true },
  });
}
async function addDefaultTestGroup() {
  await prisma.testGroup.create({ data: { testGroup: 'DEFAULT', sampleSize: 0.005, unit: 'kg', samplingMethod: 'LOT', mfSamplingMethod: 'BATCH' } });
}
async function relaxCompleteSignature() {
  await prisma.securedItem.create({
    data: { key: 'order.complete', description: 'order.complete', requireReason: false, requireSignature: false, requireWitness: false },
  });
}
async function relaxReverseSignature() {
  await prisma.securedItem.create({
    data: { key: 'order.reverse', description: 'order.reverse', requireReason: false, requireSignature: false, requireWitness: false },
  });
}

/** A Released MFBA order producing item 1 (lot PROD1) with one FIFO raw line. */
async function releasedBatch() {
  await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  await addItem(prisma, { id: 1, code: 'PROD' });
  await addItem(prisma, { id: 3, code: 'BULK', purchasePrice: 4 });
  await addOrder(prisma, { id: 800, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
  await addOrdDetail(prisma, { id: 900, ordrId: 800, context: 'PK', itemId: 1, qtyReqd: 100 });
  await addOrdDetail(prisma, { id: 902, ordrId: 800, context: 'UI', itemId: 3, qtyReqd: 8 });
  await addOrdDetail(prisma, { id: 904, ordrId: 800, context: 'IPT', description: 'Specification Test' });
  await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: 900 });
  await addLot(prisma, { lot: 'OLD', itemId: 3, unitCost: 3, receivedDate: new Date('2020-01-01') });
  await addSublot(prisma, { id: 3, lot: 'OLD' });
  await addInventory(prisma, { itemId: 3, sublotId: 3, locationId: 1, qty: 20 });
}

describe('Receiving seams — Approved release at birth', () => {
  it('misc receipt: release Approved/GMP, Sublot.releaseId set — even for a TESTED item (receiving never held stock here)', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'RAW' });
    await addItemTest(1, 'ASSAY', { min: 95 });
    const { miscReceipt } = services(prisma);

    const res = await miscReceipt.receive({ lines: [{ itemId: 1, qty: 10 }] }, actor);
    const sub = (await prisma.sublot.findFirst({ where: { lot: res.lots[0].lot } }))!;
    expect(sub.releaseId).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    const rel = (await prisma.release.findUnique({ where: { id: sub.releaseId! } }))!;
    expect(rel).toMatchObject({ status: 'Approved', grade: 'GMP', sublotId: sub.id, sampleSetId: null, context: 'CURRENT' });
    expect(rel.releaseDate).not.toBeNull();
    expect(rel.releasedBy).toBe(actor.label);
    expect(await prisma.sampleSet.count()).toBe(0); // no set at a receiving seam
  });

  it('purchase receive: every received lot gets an Approved release', async () => {
    const supplier = await addEntity(prisma, { id: 200, code: 'SUP', isSupplier: true });
    await addItem(prisma, { id: 1, code: 'RAW', unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addOrder(prisma, { id: 300, context: 'PO', status: 'NST', entityId: supplier, ownerId: 4 });
    await addOrdDetail(prisma, { id: 400, ordrId: 300, context: 'PO', itemId: 1, qtyReqd: 100, price: 4, entityUnit: 'lb' });
    const { purchasing } = services(prisma);

    const res = await purchasing.receive(
      300,
      { lines: [{ ordDetailId: 400, lots: [{ qty: 30, manufacturerLot: 'MFR-1' }, { qty: 20, manufacturerLot: 'MFR-2' }] }] },
      actor,
    );
    for (const l of res.lots) {
      const sub = (await prisma.sublot.findFirst({ where: { lot: l.lot } }))!;
      expect(sub.releaseId).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
      const rel = (await prisma.release.findUnique({ where: { id: sub.releaseId! } }))!;
      expect(rel.status).toBe('Approved');
    }
    expect(await prisma.release.count()).toBe(2);
  });

  it('lot-enable: opening sublots get Approved releases; a sublot that already carries one is left alone', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'FG' });
    // An imported FG lot whose sublot already carries an (imported) release.
    await addLot(prisma, { lot: 'FG-EXISTING', itemId: 1 });
    await prisma.release.create({ data: { id: 77, sublotId: 5, status: 'Approved', grade: 'GMP', context: 'CURRENT' } });
    await prisma.sublot.create({ data: { id: 5, lot: 'FG-EXISTING', sublotCode: 'FG-EXISTING', context: 'LOT', releaseId: 77 } });
    const { lotTracking } = services(prisma);

    await lotTracking.enable(
      1,
      { groups: [{ locationId: 1, entries: [{ lotNumber: 'FG-EXISTING', qty: 4 }, { lotNumber: 'FG-NEW', qty: 6 }] }] },
      actor,
    );
    // The pre-existing release is untouched (idempotent skip)…
    expect((await prisma.sublot.findUnique({ where: { id: 5 } }))!.releaseId).toBe(77);
    expect(await prisma.release.count({ where: { id: 77 } })).toBe(1);
    // …and the new opening sublot got a native Approved release.
    const newSub = (await prisma.sublot.findFirst({ where: { lot: 'FG-NEW' } }))!;
    expect(newSub.releaseId).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect((await prisma.release.findUnique({ where: { id: newSub.releaseId! } }))!.status).toBe('Approved');
  });
});

describe('Completion seam — Hold + native sample set for tested products', () => {
  it('untested product: Approved-at-birth release, no sample set', async () => {
    await releasedBatch();
    await relaxCompleteSignature();
    const { orders } = services(prisma);

    const res = (await orders.complete(800, { actualBatchSize: 100 }, actor)) as { qa: { releaseId: number; held: boolean }[] };
    expect(res.qa).toHaveLength(1);
    expect(res.qa[0].held).toBe(false);
    const sub = (await prisma.sublot.findFirst({ where: { lot: 'PROD1' } }))!;
    expect(sub.releaseId).toBe(res.qa[0].releaseId);
    expect((await prisma.release.findUnique({ where: { id: sub.releaseId! } }))!.status).toBe('Approved');
    expect(await prisma.sampleSet.count()).toBe(0);
  });

  it('tested product: Hold release + sample set + pre-created result rows + retained-sample split + SAMPLE legs + notification', async () => {
    await releasedBatch();
    await relaxCompleteSignature();
    await addDefaultTestGroup();
    await addItemTest(1, 'VISC', { min: 28, max: 33 });
    await addItemTest(1, 'GRIND', { max: 2 });
    await prisma.notification.create({
      data: { notificationCode: 'New Sample set', securityGroup: '*', sendTo: 'qa@plant.local', subject: 'New sample set', text: '<p>@ItemCode @Lot @SampleSet</p>' },
    });
    const { orders } = services(prisma);

    const res = (await orders.complete(800, { actualBatchSize: 100 }, actor)) as {
      qa: { releaseId: number; held: boolean; sampleSetId?: number; sampleQty?: number }[];
    };
    expect(res.qa).toHaveLength(1);
    const qa = res.qa[0];
    expect(qa.held).toBe(true);
    expect(qa.sampleSetId).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect(qa.sampleQty).toBeCloseTo(SAMPLE_LB, 12);

    // Release: Hold/HOLD, carries the set, undated (awaits disposition).
    const rel = (await prisma.release.findUnique({ where: { id: qa.releaseId } }))!;
    expect(rel).toMatchObject({ status: 'Hold', grade: 'HOLD', sampleSetId: qa.sampleSetId, context: 'CURRENT' });
    expect(rel.releaseDate).toBeNull();

    // Sample set row (native, IPT line linked, grade GMP).
    const set = (await prisma.sampleSet.findUnique({ where: { id: qa.sampleSetId! } }))!;
    expect(set).toMatchObject({ grade: 'GMP', beingTested: false, iptOrdDetailId: 904 });

    // Result rows pre-created 1:1 with the item's tests, untested.
    const lst = await prisma.locationSampleTest.findMany({ where: { sampleSetId: qa.sampleSetId }, orderBy: { id: 'asc' } });
    expect(lst.map((r) => r.test)).toEqual(['VISC', 'GRIND']);
    expect(lst.every((r) => r.result == null && r.testedTime == null)).toBe(true);

    // Retained sample: SMP location (6-digit sample sequence), stock split off
    // the produced parcel, conserving the total.
    // Native codes use the 'E' namespace — NOT legacy's live 6-digit sequence
    // (parallel-running collision, 2026-07-09 review).
    const smp = (await prisma.location.findUnique({ where: { id: lst[0].locationId } }))!;
    expect(smp.context).toBe('SMP');
    expect(smp.locationCode).toBe('E00001');
    const sub = (await prisma.sublot.findFirst({ where: { lot: 'PROD1' } }))!;
    const parcels = await prisma.inventory.findMany({ where: { sublotId: sub.id }, orderBy: { id: 'asc' } });
    expect(parcels).toHaveLength(2);
    const sample = parcels.find((p) => p.locationId === smp.id)!;
    const main = parcels.find((p) => p.locationId !== smp.id)!;
    expect(sample.qty).toBeCloseTo(SAMPLE_LB, 12);
    expect((main.qty ?? 0) + (sample.qty ?? 0)).toBeCloseTo(100, 9);

    // One SAMPLE movement: US(−) from the mint location, MK(+) into SMP, both
    // valueless, release stamped on the header.
    const mv = (await prisma.invMovement.findFirst({ where: { context: 'SAMPLE' } }))!;
    expect(Number(mv.releaseId)).toBe(qa.releaseId);
    const legs = await prisma.invMovementDtl.findMany({ where: { invMovementId: mv.id }, orderBy: { id: 'asc' } });
    expect(legs.map((l) => l.context)).toEqual(['US', 'MK']);
    expect(legs[0].qty).toBeCloseTo(-SAMPLE_LB, 12);
    expect(legs[1].qty).toBeCloseTo(SAMPLE_LB, 12);
    expect(legs.every((l) => l.value == null)).toBe(true);

    // 'New Sample set' queued (native EmailSent id, the rule's subject).
    const mails = await prisma.emailSent.findMany({ where: { subject: 'New sample set' } });
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails[0].id).toBeGreaterThanOrEqual(NATIVE_ID_BASE);

    // The native set is live QC: results enter through the shipped flow.
    const { releases } = services(prisma);
    const grid = (await releases.tests(qa.releaseId)) as { hasSampleSet: boolean; tests: { id: number; test: string }[] };
    expect(grid.hasSampleSet).toBe(true);
    expect(grid.tests).toHaveLength(2);
    await releases.enterResults(
      qa.releaseId,
      { results: [{ id: grid.tests[0].id, result: '30' }, { id: grid.tests[1].id, result: '1' }] },
      actor,
    );
    const after = await prisma.locationSampleTest.findMany({ where: { sampleSetId: qa.sampleSetId } });
    expect(after.every((r) => r.passed === true && r.testedTime != null)).toBe(true);
  });

  it('tested product without a TestGroup row (or ZEROQTY size): set + rows created, NO stock split', async () => {
    await releasedBatch();
    await relaxCompleteSignature();
    await addItemTest(1, 'VISC', { min: 28, max: 33 }); // group DEFAULT, but no TestGroup row seeded
    const { orders } = services(prisma);

    const res = (await orders.complete(800, { actualBatchSize: 100 }, actor)) as {
      qa: { releaseId: number; held: boolean; sampleSetId?: number; sampleQty?: number }[];
    };
    expect(res.qa[0].held).toBe(true);
    expect(res.qa[0].sampleQty).toBe(0);
    const sub = (await prisma.sublot.findFirst({ where: { lot: 'PROD1' } }))!;
    const parcels = await prisma.inventory.findMany({ where: { sublotId: sub.id } });
    expect(parcels).toHaveLength(1); // no sample parcel
    expect(parcels[0].qty).toBe(100);
    expect(await prisma.invMovement.count({ where: { context: 'SAMPLE' } })).toBe(0);
    expect(await prisma.locationSampleTest.count()).toBe(1); // rows still pre-created
  });
});

describe('Reversal — unwinds the completion QA; begun QA work pins the batch', () => {
  // Same fixture as releasedBatch() but in the native id range (see OID).
  async function completedTestedBatch() {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD' });
    await addItem(prisma, { id: 3, code: 'BULK', purchasePrice: 4 });
    await addOrder(prisma, { id: OID, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: OID + 100, ordrId: OID, context: 'PK', itemId: 1, qtyReqd: 100 });
    await addOrdDetail(prisma, { id: OID + 102, ordrId: OID, context: 'UI', itemId: 3, qtyReqd: 8 });
    await addOrdDetail(prisma, { id: OID + 104, ordrId: OID, context: 'IPT', description: 'Specification Test' });
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: OID + 100 });
    await addLot(prisma, { lot: 'OLD', itemId: 3, unitCost: 3, receivedDate: new Date('2020-01-01') });
    await addSublot(prisma, { id: 3, lot: 'OLD' });
    await addInventory(prisma, { itemId: 3, sublotId: 3, locationId: 1, qty: 20 });
    await relaxCompleteSignature();
    await relaxReverseSignature();
    await addDefaultTestGroup();
    await addItemTest(1, 'VISC', { min: 28, max: 33 });
    const { orders, releases } = services(prisma);
    const res = (await orders.complete(OID, { actualBatchSize: 100 }, actor)) as {
      qa: { releaseId: number; held: boolean; sampleSetId?: number }[];
    };
    return { orders, releases, qa: res.qa[0] };
  }

  it('reverse before any QA work: sample parcel/set/rows/release/SMP location all unwound, negation leg written, re-completion mints a fresh set', async () => {
    const { orders, qa } = await completedTestedBatch();

    await orders.reverse(OID, {}, actor);
    expect((await prisma.ordr.findUnique({ where: { id: OID } }))!.status).toBe('RLS');
    const sub = (await prisma.sublot.findFirst({ where: { lot: 'PROD1' } }))!;
    expect(sub.releaseId).toBeNull();
    expect(await prisma.release.count()).toBe(0);
    expect(await prisma.sampleSet.count()).toBe(0);
    expect(await prisma.locationSampleTest.count()).toBe(0);
    expect(await prisma.inventory.count({ where: { sublotId: sub.id } })).toBe(0);
    expect(await prisma.location.count({ where: { context: 'SMP' } })).toBe(0);
    // Ledger: 3 SAMPLE legs exist (forward US/MK pair + the SMP negation under
    // the RVSMFP change set), and the produced item's at-date nets to zero at
    // EVERY location (the prod-side forward US leg is compensated by the PCKAGE
    // negation of the main parcel, which held full − s).
    const sampleLegCount = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM "InvMovementDtl" imd JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
      WHERE im."Context" = 'SAMPLE'`;
    expect(sampleLegCount[0].n).toBe(3);
    const perLocation = await prisma.$queryRaw<{ loc: number | null; qty: number }[]>`
      SELECT imd."Location" AS loc, COALESCE(SUM(imd."Qty"), 0)::float8 AS qty
      FROM "InvMovementDtl" imd JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
      WHERE im."Item" = 1
      GROUP BY imd."Location"`;
    for (const row of perLocation) expect(row.qty).toBeCloseTo(0, 9);

    // Re-complete: a fresh Hold release + set are created.
    const res2 = (await orders.complete(OID, { actualBatchSize: 100 }, actor)) as {
      qa: { releaseId: number; held: boolean; sampleSetId?: number }[];
    };
    expect(res2.qa[0].held).toBe(true);
    // The unwind deleted the old set, so the native MAX+1 allocator may hand
    // out the same id again — assert the re-created state, not id inequality.
    expect(res2.qa[0].sampleSetId).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect(await prisma.sampleSet.count()).toBe(1);
    expect((await prisma.release.findUnique({ where: { id: res2.qa[0].releaseId } }))!.status).toBe('Hold');
    expect(await prisma.locationSampleTest.count({ where: { sampleSetId: res2.qa[0].sampleSetId } })).toBe(1);
  });

  it('reverse is refused once results are recorded, and once the release is dispositioned', async () => {
    const { orders, releases, qa } = await completedTestedBatch();
    const grid = (await releases.tests(qa.releaseId)) as { tests: { id: number }[] };
    await releases.enterResults(qa.releaseId, { results: [{ id: grid.tests[0].id, result: '30' }] }, actor);

    await expect(orders.reverse(OID, {}, actor)).rejects.toThrow(/test results were already recorded/i);
  });

  it('reverse is refused after disposition (status left Hold) even with no results', async () => {
    const { orders, qa } = await completedTestedBatch();
    // Disposition applied directly (the shipped e-signed flow is covered by its
    // own suite; here only the resulting state matters).
    await prisma.release.update({ where: { id: qa.releaseId }, data: { status: 'Approved', grade: 'GMP', releaseDate: new Date(), releasedBy: 'QA' } });

    await expect(orders.reverse(OID, {}, actor)).rejects.toThrow(/already dispositioned/i);
  });

  it('reverse is refused after a Hold→Hold re-disposition (grade/date stamped, status unchanged)', async () => {
    const { orders, qa } = await completedTestedBatch();
    // applyDispositionToRelease always stamps releaseDate/releasedBy — a
    // quarantine-with-notes keeps status Hold but is still a disposition.
    await prisma.release.update({ where: { id: qa.releaseId }, data: { releaseDate: new Date(), releasedBy: 'QA', purity: 98.5 } });

    await expect(orders.reverse(OID, {}, actor)).rejects.toThrow(/already dispositioned/i);
  });

  it('reverse is refused when an UNTESTED product\'s born-Approved release was quarantined to Hold', async () => {
    // Untested fixture in the native range (no ItemTest rows -> born Approved).
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD' });
    await addOrder(prisma, { id: OID, context: 'MFBA', status: 'RLS', actualBatchSize: 50 });
    await addOrdDetail(prisma, { id: OID + 100, ordrId: OID, context: 'PK', itemId: 1, qtyReqd: 50 });
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: OID + 100 });
    await relaxCompleteSignature();
    await relaxReverseSignature();
    const { orders } = services(prisma);
    const res = (await orders.complete(OID, { actualBatchSize: 50 }, actor)) as { qa: { releaseId: number; held: boolean }[] };
    expect(res.qa[0].held).toBe(false);
    // QA quarantines the lot (e-signed flow elsewhere; state is what matters).
    await prisma.release.update({ where: { id: res.qa[0].releaseId }, data: { status: 'Hold', releaseDate: new Date(), releasedBy: 'QA' } });

    await expect(orders.reverse(OID, {}, actor)).rejects.toThrow(/already dispositioned/i);
  });

  it('a PENDING disposition request against the deleted release is auto-rejected by the reversal', async () => {
    const { orders, qa } = await completedTestedBatch();
    await prisma.approvalRequest.create({
      data: {
        kind: 'release.disposition', targetTable: 'Release', targetId: String(qa.releaseId),
        payload: '{"status":"Approved"}', requiredCapability: 'approveChange', state: 'PENDING',
        requestedById: actor.id, requestedAt: new Date(),
      },
    });

    await orders.reverse(OID, {}, actor);
    const req = (await prisma.approvalRequest.findFirst({ where: { kind: 'release.disposition' } }))!;
    expect(req.state).toBe('REJECTED');
    expect(req.decisionReason).toMatch(/completion reversed/i);
  });
});

describe('Retained-sample protection', () => {
  it('FIFO depletion never draws the SMP retained-sample parcel — the shortfall is reported instead', async () => {
    const { qa } = await (async () => {
      await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
      await addItem(prisma, { id: 1, code: 'PROD' });
      await addOrder(prisma, { id: OID, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
      await addOrdDetail(prisma, { id: OID + 100, ordrId: OID, context: 'PK', itemId: 1, qtyReqd: 100 });
      await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: OID + 100 });
      await relaxCompleteSignature();
      await addDefaultTestGroup();
      await addItemTest(1, 'VISC', { min: 28, max: 33 });
      const { orders } = services(prisma);
      const res = (await orders.complete(OID, { actualBatchSize: 100 }, actor)) as { qa: { releaseId: number; sampleSetId?: number }[] };
      return { qa: res.qa[0] };
    })();
    const { valuation } = services(prisma);

    // Ask for the FULL 100: only the main parcel (100 − sample) is drawable.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(906090906)`;
      return valuation.depleteFifo(tx, 1, 100);
    });
    expect(result.depleted).toBeCloseTo(100 - SAMPLE_LB, 9);
    expect(result.shortfall).toBeCloseTo(SAMPLE_LB, 9);
    // The retained sample is untouched.
    const lst = await prisma.locationSampleTest.findFirst({ where: { sampleSetId: qa.sampleSetId } });
    const sample = await prisma.inventory.findFirst({ where: { locationId: lst!.locationId } });
    expect(sample!.qty).toBeCloseTo(SAMPLE_LB, 12);
  });

  it('lot-enable refuses while a native QC sample is undispositioned, proceeds after approval', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD' });
    await addOrder(prisma, { id: OID, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: OID + 100, ordrId: OID, context: 'PK', itemId: 1, qtyReqd: 100 });
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: OID + 100 });
    await relaxCompleteSignature();
    await addDefaultTestGroup();
    await addItemTest(1, 'VISC', { min: 28, max: 33 });
    const { orders, lotTracking } = services(prisma);
    const res = (await orders.complete(OID, { actualBatchSize: 100 }, actor)) as { qa: { releaseId: number }[] };

    await expect(
      lotTracking.enable(1, { groups: [{ locationId: 1, entries: [{ lotNumber: 'OP1', qty: 5 }] }] }, actor),
    ).rejects.toThrow(/undispositioned QC sample/i);

    // Disposition it — the pin lifts (the wipe may then clear the historical sample parcel).
    await prisma.release.update({ where: { id: res.qa[0].releaseId }, data: { status: 'Approved', grade: 'GMP', releaseDate: new Date(), releasedBy: 'QA' } });
    const enabled = await lotTracking.enable(1, { groups: [{ locationId: 1, entries: [{ lotNumber: 'OP1', qty: 5 }] }] }, actor);
    expect(enabled).toBeTruthy();
  });
});

describe('Native CofA header', () => {
  it('the approving disposition creates the ReleaseCofA header for a native release; the CofA endpoint serves it', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD' });
    await addOrder(prisma, { id: OID, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: OID + 100, ordrId: OID, context: 'PK', itemId: 1, qtyReqd: 100 });
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: OID + 100 });
    await relaxCompleteSignature();
    await addDefaultTestGroup();
    await addItemTest(1, 'VISC', { min: 28, max: 33 });
    // Relax the disposition e-sig and give the seeded actor full approval caps
    // (same shape seedActor(withApprovalCaps) builds) so disposition enacts
    // directly through the SHIPPED flow.
    await prisma.securedItem.create({
      data: { key: 'release.disposition', description: 'x', requireReason: false, requireSignature: false, requireWitness: false },
    });
    await prisma.user.update({
      where: { id: actor.id },
      data: {
        roles: {
          create: {
            role: {
              create: {
                code: 'QA_CAPS', name: 'QA Caps',
                approvalPolicy: {
                  create: { canRequestApproval: true, canApprove: true, canApproveUpdate: true, canApproveChange: true, canOverride: true, noApprovalRequired: true },
                },
              },
            },
          },
        },
      },
    });
    const { orders, releases } = services(prisma);
    const res = (await orders.complete(OID, { actualBatchSize: 100 }, actor)) as { qa: { releaseId: number }[] };
    const releaseId = res.qa[0].releaseId;

    await releases.disposition(releaseId, { status: 'Approved', grade: 'GMP' }, actor);
    const cofa = (await prisma.releaseCofA.findUnique({ where: { releaseId } }))!;
    expect(cofa.productCode).toBe('PROD');
    expect(cofa.pkgLot).toBe('PROD1');
    // Re-disposition doesn't duplicate (PK) or fail.
    await releases.disposition(releaseId, { status: 'Approved', grade: 'GMP' }, actor);
    expect(await prisma.releaseCofA.count()).toBe(1);
  });
});
