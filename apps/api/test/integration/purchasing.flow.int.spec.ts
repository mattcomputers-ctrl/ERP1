import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import {
  addEntity,
  addItem,
  addLocation,
  addOrdDetail,
  addOrdDetailPricing,
  addOrder,
  makePrisma,
  onHandForLot,
  resetDb,
  seedActor,
  services,
} from './support';

// Flow integration test: the real PurchasingService.receive against a real
// Postgres — the multi-step receiving flow (Lot + Sublot + on-hand mint via the
// valuation engine + ChangeSet/ChangeSetReceipt + QtyUsed bump + audit).

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

describe('PurchasingService.receive', () => {
  it('mints a raw lot + on-hand at the receiving location, records the receipt, and bumps QtyUsed', async () => {
    const supplier = await addEntity(prisma, { id: 200, code: 'SUP', isSupplier: true });
    await addItem(prisma, { id: 1, code: 'RAW', unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addOrder(prisma, { id: 300, context: 'PO', status: 'NST', entityId: supplier, ownerId: 4 });
    await addOrdDetail(prisma, { id: 400, ordrId: 300, context: 'PO', itemId: 1, qtyReqd: 100, price: 4, entityUnit: 'lb' });
    const { purchasing } = services(prisma);

    const res = await purchasing.receive(300, { lines: [{ ordDetailId: 400, lots: [{ qty: 30, manufacturerLot: 'MFR-1' }] }] }, actor);
    expect(res.received).toBe(1);
    const lotCode = res.lots[0].lot;

    // The raw lot is tagged with the supplier + manufacturer lot and priced from the PO line.
    const lot = (await prisma.lot.findUnique({ where: { lot: lotCode } }))!;
    expect(lot.supLot).toBe('MFR-1');
    expect(lot.manfLot).toBe('MFR-1');
    expect(lot.supplierId).toBe(supplier);
    expect(Number(lot.unitCost)).toBe(4);

    // On-hand minted (at the resolved WHS location), receipt recorded, QtyUsed bumped.
    expect(await onHandForLot(prisma, lotCode)).toBe(30);
    const receipts = await prisma.changeSetReceipt.findMany({ where: { ordDetailId: 400 } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].psQty).toBe(30);
    expect((await prisma.ordDetail.findUnique({ where: { id: 400 } }))!.qtyUsed).toBe(30);
  });

  it('splits a received line across multiple manufacturer lots, accumulating QtyUsed', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addOrder(prisma, { id: 301, context: 'PO', status: 'NST', entityId: supplier });
    await addOrdDetail(prisma, { id: 401, ordrId: 301, context: 'PO', itemId: 1, qtyReqd: 100, price: 2 });
    const { purchasing } = services(prisma);

    const res = await purchasing.receive(
      301,
      { lines: [{ ordDetailId: 401, lots: [{ qty: 20, manufacturerLot: 'A' }, { qty: 15, manufacturerLot: 'B' }] }] },
      actor,
    );
    expect(res.received).toBe(2);
    expect((await prisma.ordDetail.findUnique({ where: { id: 401 } }))!.qtyUsed).toBe(35);
    expect(await prisma.lot.count({ where: { supLot: { in: ['A', 'B'] } } })).toBe(2);
  });

  it('prices a per-package line at price / package-qty (PriceByPackage), not the raw package price', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addOrder(prisma, { id: 310, context: 'PO', status: 'NST', entityId: supplier });
    // $400 per DRUM of 400 lb -> true per-unit cost $1/lb.
    await addOrdDetail(prisma, { id: 410, ordrId: 310, context: 'PO', itemId: 1, qtyReqd: 800, price: 400 });
    await addOrdDetailPricing(prisma, { ordDetailId: 410, entityQuantity: 400, priceByPackage: true });
    const { purchasing } = services(prisma);

    const res = await purchasing.receive(310, { lines: [{ ordDetailId: 410, lots: [{ qty: 400, manufacturerLot: 'D1' }] }] }, actor);
    const lot = (await prisma.lot.findUnique({ where: { lot: res.lots[0].lot } }))!;
    expect(Number(lot.unitCost)).toBeCloseTo(1, 6); // 400 / 400, NOT 400
  });

  it('accumulates QtyUsed across SEPARATE receives of the same line (COALESCE re-read, not overwrite)', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addOrder(prisma, { id: 320, context: 'PO', status: 'NST', entityId: supplier });
    await addOrdDetail(prisma, { id: 420, ordrId: 320, context: 'PO', itemId: 1, qtyReqd: 100, price: 1 });
    const { purchasing } = services(prisma);

    await purchasing.receive(320, { lines: [{ ordDetailId: 420, lots: [{ qty: 20, manufacturerLot: 'R1' }] }] }, actor);
    await purchasing.receive(320, { lines: [{ ordDetailId: 420, lots: [{ qty: 15, manufacturerLot: 'R2' }] }] }, actor);
    expect((await prisma.ordDetail.findUnique({ where: { id: 420 } }))!.qtyUsed).toBe(35); // 20 + 15, not 15
  });

  it('rejects receiving against a closed PO and a line not on the PO (IDOR)', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1 });
    await addOrder(prisma, { id: 302, context: 'PO', status: 'CLS', entityId: supplier });
    await addOrdDetail(prisma, { id: 402, ordrId: 302, context: 'PO', itemId: 1, qtyReqd: 100 });
    await addOrder(prisma, { id: 303, context: 'PO', status: 'NST', entityId: supplier });
    await addOrdDetail(prisma, { id: 403, ordrId: 303, context: 'PO', itemId: 1, qtyReqd: 100 });
    const { purchasing } = services(prisma);

    await expect(
      purchasing.receive(302, { lines: [{ ordDetailId: 402, lots: [{ qty: 5, manufacturerLot: 'X' }] }] }, actor),
    ).rejects.toThrow(/closed/);
    await expect(
      purchasing.receive(303, { lines: [{ ordDetailId: 999, lots: [{ qty: 5, manufacturerLot: 'X' }] }] }, actor),
    ).rejects.toThrow(/not a line/);
  });
});
