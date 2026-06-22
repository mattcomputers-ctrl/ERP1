import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addItem, addLocation, makePrisma, onHandForLot, resetDb, seedActor, services } from './support';

// Flow integration test: the real MiscReceiptService against a real Postgres —
// a non-PO inventory receipt mints a lot + sublot + on-hand + a MISC ChangeSet/
// receipt, with no order and no supplier.

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

describe('MiscReceiptService.receive', () => {
  it('mints a lot + sublot + on-hand + a MISC ChangeSet/receipt (no PO, no supplier), recall-findable by mfr lot', async () => {
    await addItem(prisma, { id: 1, code: 'RAW', unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    const { miscReceipt, purchasing } = services(prisma);

    const res = await miscReceipt.receive(
      { lines: [{ itemId: 1, qty: 25, manufacturerLot: 'MFR-1', unitCost: 4 }], reference: 'opening' },
      actor,
    );
    expect(res.received).toBe(1);
    const lotCode = res.lots[0].lot;

    const lot = (await prisma.lot.findUnique({ where: { lot: lotCode } }))!;
    expect(Number(lot.lot)).toBeGreaterThanOrEqual(100); // raw-material sequence (from 100)
    expect(lot.supLot).toBe('MFR-1');
    expect(lot.manfLot).toBe('MFR-1');
    expect(lot.supplierId).toBeNull(); // no supplier on a misc receipt
    expect(Number(lot.unitCost)).toBe(4);
    expect(await onHandForLot(prisma, lotCode)).toBe(25);

    // A MISC ChangeSet (no order) + a 1:1 ChangeSetReceipt (no PO line).
    const cs = (await prisma.changeSet.findFirst({ where: { context: 'MISC' } }))!;
    expect(cs.ordrId).toBeNull();
    const receipt = (await prisma.changeSetReceipt.findUnique({ where: { changeSetId: cs.id } }))!;
    expect(receipt.ordDetailId).toBeNull();
    expect(receipt.itemId).toBe(1);
    expect(receipt.psQty).toBe(25);

    // The lot enters the manufacturer-lot recall (SupLot set).
    const recall = await purchasing.recallByManufacturerLot('MFR-1');
    expect(recall.rows.map((r) => r.lot)).toContain(lotCode);
  });

  it('allows a receipt with no manufacturer lot (SupLot null)', async () => {
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    const { miscReceipt } = services(prisma);
    const res = await miscReceipt.receive({ lines: [{ itemId: 1, qty: 10 }] }, actor);
    const lot = (await prisma.lot.findUnique({ where: { lot: res.lots[0].lot } }))!;
    expect(lot.supLot).toBeNull();
    expect(await onHandForLot(prisma, res.lots[0].lot)).toBe(10);
  });

  it('mints distinct lots/changesets across lines and lists them with the native lot', async () => {
    await addItem(prisma, { id: 1, code: 'A', unit: 'lb' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'kg' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    const { miscReceipt } = services(prisma);

    const res = await miscReceipt.receive({ lines: [{ itemId: 1, qty: 5 }, { itemId: 2, qty: 7 }] }, actor);
    expect(res.received).toBe(2);
    expect(new Set(res.lots.map((l) => l.lot)).size).toBe(2);
    expect(await prisma.changeSet.count({ where: { context: 'MISC' } })).toBe(2);

    const list = await miscReceipt.list({});
    expect(list.total).toBe(2);
    expect(list.rows.map((r) => r.itemCode).sort()).toEqual(['A', 'B']);
    expect(list.rows.every((r) => r.lot != null)).toBe(true);
  });

  it('rejects an unknown item', async () => {
    const { miscReceipt } = services(prisma);
    await expect(miscReceipt.receive({ lines: [{ itemId: 999, qty: 1 }] }, actor)).rejects.toThrow(/Unknown item/);
  });
});
