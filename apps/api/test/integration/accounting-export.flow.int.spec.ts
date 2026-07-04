import { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountingJournalService, type ExportKind } from '../../src/accounting/journal.service';
import { AccountingExportService } from '../../src/accounting/export.service';
import { AuditService } from '../../src/audit/audit.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SettingsService } from '../../src/settings/settings.service';
import {
  addEntity, addInventory, addItem, addLocation, addLot, addOrdDetail, addOrder,
  addSublot, makePrisma, resetDb, seedActor, services,
} from './support';

// The accounting export (§13): journal building over invoices / receipts /
// misc receipts / adjustments / builds, account resolution through the GL
// grid, IIF/CSV rendering, and the export-run ledger.

let prisma: PrismaClient;
let actor: Actor;

const svc = () => {
  const p = prisma as unknown as PrismaService;
  const journal = new AccountingJournalService(p, new SettingsService(p));
  return { journal, exporter: new AccountingExportService(p, journal, new AuditService(p)) };
};

// Clock-relative range covering "around now" — the fixtures below stamp
// their own dates inside it.
const FROM = new Date(Date.now() - 30 * 86400_000);
const TO = new Date(Date.now() + 86400_000);
const ALL: Set<ExportKind> = new Set(['invoices', 'receipts', 'miscReceipts', 'adjustments', 'builds']);

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

async function seedGl() {
  const { glMasters } = services(prisma);
  await glMasters.createGlGroup({ glGroup: 'FG' }, actor);
  await glMasters.createGlGroup({ glGroup: 'RM' }, actor);
  for (const code of ['Asset', 'Income', 'COUNT', 'MiscReceipt']) await glMasters.createGlCode({ glCode: code }, actor);
  for (const acct of ['12200 - FG Asset', '35200 - FG Revenue', '12100 - RM Asset', '65100 - RM Adjustment'])
    await glMasters.createAccountCode({ accountCode: acct }, actor);
  await glMasters.createGlGroupCode({ glGroup: 'FG', glCode: 'Asset', accountCode: '12200 - FG Asset' }, actor);
  await glMasters.createGlGroupCode({ glGroup: 'FG', glCode: 'Income', accountCode: '35200 - FG Revenue' }, actor);
  await glMasters.createGlGroupCode({ glGroup: 'RM', glCode: 'Asset', accountCode: '12100 - RM Asset' }, actor);
  await glMasters.createGlGroupCode({ glGroup: 'RM', glCode: 'COUNT', accountCode: '65100 - RM Adjustment' }, actor);
}

describe('journal builder', () => {
  it('books an invoice as AR against grouped Income + tax + freight', async () => {
    await seedGl();
    await addEntity(prisma, { id: 9301, code: 'CUST1', isBillTo: true });
    await addItem(prisma, { id: 801, code: 'FG-A' });
    await prisma.item.update({ where: { id: 801 }, data: { glGroup: 'FG' } });
    await prisma.trans.create({
      data: {
        id: 30001, context: 'CI', transDocument: 'N00000042', documentDate: new Date(),
        billToId: 9301, freightCharge: 20, tax1Amount: 12,
      },
    });
    await prisma.transDetail.create({ data: { id: 30001, transId: 30001, context: 'SH', itemId: 801, qty: 40, price: 2.5 } });

    const { journal } = svc();
    const { entries, warnings } = await journal.build(FROM, TO, new Set(['invoices']));
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'INVOICE', refNumber: 'N00000042', name: 'CUST1' });
    expect(entries[0].lines).toEqual([
      { account: 'Accounts Receivable', amount: 132, memo: null },
      { account: '35200 - FG Revenue', amount: -100, memo: null },
      { account: 'Freight Income', amount: -20, memo: 'Freight' },
      { account: 'Sales Tax Payable', amount: -12, memo: 'Tax 1' },
    ]);
  });

  it('books a PO receipt as a BILL at the line price, and warns on unmapped groups', async () => {
    await seedGl();
    const sup = await addEntity(prisma, { id: 9302, code: 'SUP1', isSupplier: true });
    await addItem(prisma, { id: 802, code: 'RM-A' });
    await prisma.item.update({ where: { id: 802 }, data: { glGroup: 'RM' } });
    await addItem(prisma, { id: 803, code: 'RM-NOGROUP' }); // no GL group -> fallback + warning
    await addOrder(prisma, { id: 8401, context: 'PO', entityId: sup, poNumber: '3475' });
    await addOrdDetail(prisma, { id: 84011, ordrId: 8401, context: 'PO', itemId: 802, qtyReqd: 400, price: 2.03 });
    await addOrdDetail(prisma, { id: 84012, ordrId: 8401, context: 'PO', itemId: 803, qtyReqd: 10, price: 5 });
    await prisma.changeSet.create({ data: { id: 40001, context: 'PO', ordrId: 8401, changeDate: new Date(), poNumber: '3475' } });
    await prisma.changeSetReceipt.create({ data: { changeSetId: 40001, ordDetailId: 84011, itemId: 802, psQty: 400 } });
    await prisma.changeSet.create({ data: { id: 40002, context: 'PO', ordrId: 8401, changeDate: new Date(), poNumber: '3475' } });
    await prisma.changeSetReceipt.create({ data: { changeSetId: 40002, ordDetailId: 84012, itemId: 803, psQty: 10 } });

    const { journal } = svc();
    const { entries, warnings } = await journal.build(FROM, TO, new Set(['receipts']));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: 'BILL', refNumber: '3475', name: 'SUP1' });
    expect(entries[0].lines).toEqual([
      { account: 'Accounts Payable', amount: -812, memo: null },
      { account: '12100 - RM Asset', amount: 812, memo: null },
    ]);
    // The unmapped item landed on the fallback account WITH a warning.
    expect(entries[1].lines[1].account).toBe('Uncategorized');
    expect(warnings.some((w) => w.includes('RM-NOGROUP') || w.includes('CS 40002'))).toBe(true);
  });

  it('divides by-package line prices per stock unit and nets out reversed receipts', async () => {
    await seedGl();
    const sup = await addEntity(prisma, { id: 9304, code: 'SUP2', isSupplier: true });
    await addItem(prisma, { id: 808, code: 'RM-PKG' });
    await prisma.item.update({ where: { id: 808 }, data: { glGroup: 'RM' } });
    await addOrder(prisma, { id: 8402, context: 'PO', entityId: sup, poNumber: '4001' });
    // $86.20 per 7-unit package (the live OrdDetail 285592 shape): 35 stock
    // units received = 5 packages = $431, NOT 35 x 86.20.
    await addOrdDetail(prisma, { id: 84021, ordrId: 8402, context: 'PO', itemId: 808, qtyReqd: 35, price: 86.2 });
    await prisma.ordDetailPricing.create({ data: { ordDetailId: 84021, priceByPackage: true, entityQuantity: 7 } });
    await prisma.changeSet.create({ data: { id: 40003, context: 'PO', ordrId: 8402, changeDate: new Date(), poNumber: '4001' } });
    await prisma.changeSetReceipt.create({ data: { changeSetId: 40003, ordDetailId: 84021, itemId: 808, psQty: 35 } });

    const { journal } = svc();
    const { entries } = await journal.build(FROM, TO, new Set(['receipts']));
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toEqual([
      { account: 'Accounts Payable', amount: -431, memo: null },
      { account: '12100 - RM Asset', amount: 431, memo: null },
    ]);

    // Reversing the receipt (RVSPO back-pointer) nets it out of the export.
    await prisma.changeSet.create({ data: { id: 1_000_000_401, context: 'RVSPO', reverseChangeSetId: 40003, changeDate: new Date() } });
    const after = await journal.build(FROM, TO, new Set(['receipts']));
    expect(after.entries).toHaveLength(0);
    expect(after.warnings.some((w) => w.includes('reversed on'))).toBe(true);

    // A reversal IN range of a receipt BEFORE the range emits the negated
    // counter-entry instead (the original was exported last period).
    const counter = await journal.build(new Date(Date.now() - 3600_000), TO, new Set(['receipts']));
    expect(counter.entries).toHaveLength(0); // both events inside [from,to] here — still netted

    await prisma.changeSet.update({ where: { id: 40003 }, data: { changeDate: new Date(Date.now() - 60 * 86400_000) } });
    const split = await journal.build(FROM, TO, new Set(['receipts']));
    expect(split.entries).toHaveLength(1);
    expect(split.entries[0].refNumber).toBe('RVS 4001');
    expect(split.entries[0].lines).toEqual([
      { account: 'Accounts Payable', amount: 431, memo: null },
      { account: '12100 - RM Asset', amount: -431, memo: null },
    ]);
  });

  it('books native adjustments from the audit trail at the lot cost', async () => {
    await seedGl();
    await addItem(prisma, { id: 804, code: 'RM-B' });
    await prisma.item.update({ where: { id: 804 }, data: { glGroup: 'RM' } });
    const whs = await addLocation(prisma, { code: 'WHS', context: 'WHS' });
    await addLot(prisma, { lot: 'L804', itemId: 804, unitCost: 3 });
    await addSublot(prisma, { id: 56001, lot: 'L804' });
    const parcelId = await addInventory(prisma, { itemId: 804, sublotId: 56001, locationId: whs, qty: 100 });

    const { inventory } = services(prisma);
    await inventory.adjust({ inventoryId: parcelId, newQty: 90, reason: 'cycle count' }, actor);

    const { journal } = svc();
    const { entries, warnings } = await journal.build(FROM, TO, new Set(['adjustments']));
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('GENERAL JOURNAL');
    // -10 units x 3 = -30: credit Asset (write-off), debit the COUNT account.
    expect(entries[0].lines).toEqual([
      { account: '12100 - RM Asset', amount: -30, memo: null },
      { account: '65100 - RM Adjustment', amount: 30, memo: null },
    ]);
  });

  it('books a native build: product Asset debited with the consumed value', async () => {
    await seedGl();
    await addItem(prisma, { id: 805, code: 'RM-C', lotTracked: true });
    await prisma.item.update({ where: { id: 805 }, data: { glGroup: 'RM' } });
    await addItem(prisma, { id: 806, code: 'FG-B' });
    await prisma.item.update({ where: { id: 806 }, data: { glGroup: 'FG' } });
    await addLot(prisma, { lot: 'RAW1', itemId: 805, unitCost: 2 });

    // A second consumed lot with NO unitCost falls back to the item's
    // purchase price (the valuation engine's roll-up basis).
    await addItem(prisma, { id: 809, code: 'RM-D', purchasePrice: 4 });
    await prisma.item.update({ where: { id: 809 }, data: { glGroup: 'RM' } });
    await addLot(prisma, { lot: 'RAW2', itemId: 809 });

    await addOrder(prisma, { id: 1_000_000_101, context: 'MFBA', status: 'CMP' });
    await prisma.ordr.update({ where: { id: 1_000_000_101 }, data: { dateCompleted: new Date(), manfLot: '260704001' } });
    await addOrdDetail(prisma, { id: 1_000_000_102, ordrId: 1_000_000_101, context: 'PK', itemId: 806, qtyReqd: 50 });
    await prisma.lotGenealogy.create({
      data: { childLot: '260704001', parentLot: 'RAW1', qty: 25, viaOrdrId: 1_000_000_101, source: 'consumption' },
    });
    await prisma.lotGenealogy.create({
      data: { childLot: '260704001', parentLot: 'RAW2', qty: 10, viaOrdrId: 1_000_000_101, source: 'consumption' },
    });

    const { journal } = svc();
    const { entries, warnings } = await journal.build(FROM, TO, new Set(['builds']));
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'GENERAL JOURNAL', source: 'build', refNumber: 'MF1000000101' });
    expect(entries[0].lines).toEqual([
      { account: '12200 - FG Asset', amount: 90, memo: null }, // 25 x 2 + 10 x 4
      { account: '12100 - RM Asset', amount: -90, memo: null },
    ]);
  });
});

describe('export service', () => {
  it('produces a balanced IIF file, records the run ledger + audit, and lists runs', async () => {
    await seedGl();
    await addEntity(prisma, { id: 9303, code: 'CUST2', isBillTo: true });
    await addItem(prisma, { id: 807, code: 'FG-C' });
    await prisma.item.update({ where: { id: 807 }, data: { glGroup: 'FG' } });
    await prisma.trans.create({
      data: { id: 30002, context: 'CI', transDocument: 'N00000043', documentDate: new Date(), billToId: 9303 },
    });
    await prisma.transDetail.create({ data: { id: 30002, transId: 30002, context: 'SH', itemId: 807, qty: 10, price: 5 } });

    const { exporter } = svc();
    const from = FROM.toISOString().slice(0, 10);
    const to = TO.toISOString().slice(0, 10);

    const preview = await exporter.preview({ from, to });
    expect(preview.entryCount).toBe(1);
    expect(preview.unbalanced).toEqual([]);

    const r = await exporter.export({ from, to, format: 'iif' }, actor);
    expect(r.entryCount).toBe(1);
    expect(r.fileName).toBe(`erp1-accounting_${from}_${to}.iif`);
    expect(r.content).toContain('!TRNS\t');
    expect(r.content).toContain('N00000043');

    const runs = await exporter.runs();
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ entryCount: 1, format: 'iif' });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'accounting.export' } });
    expect(audit?.summary).toContain('1 entries');

    // CSV flavor renders too.
    const csv = await exporter.export({ from, to, format: 'csv', kinds: ['invoices'] }, actor);
    expect(csv.content.split('\r\n')[0]).toBe('type,source,date,refNumber,name,account,debit,credit,memo');
  });

  it('rejects bad ranges and unknown kinds', async () => {
    const { exporter } = svc();
    await expect(exporter.preview({ from: '2026-07-04', to: '2026-07-01' })).rejects.toThrow(/must not be after/);
    await expect(exporter.preview({ from: 'nope', to: '2026-07-01' } as never)).rejects.toThrow(/YYYY-MM-DD|Invalid date/);
    await expect(exporter.preview({ from: '2026-07-01', to: '2026-07-04', kinds: ['bogus'] })).rejects.toThrow(/No valid export kinds/);
  });
});
