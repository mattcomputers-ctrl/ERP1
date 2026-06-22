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
  addPriceDetail,
  addPriceVersion,
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

  it('create() sources line packaging + price from the supplier effective price version', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, code: 'PIGMENT', unit: 'lb' });
    await addItem(prisma, { id: 9, code: 'DRUM' }); // the package-type item
    // Older + newer price versions; the newer (effective) one carries DRUM packaging + tiered price.
    await addPriceVersion(prisma, { id: 50, entityId: supplier, effectiveDate: new Date('2020-01-01'), version: 1 });
    await addPriceVersion(prisma, { id: 51, entityId: supplier, effectiveDate: new Date('2025-01-01'), version: 2 });
    await addPriceDetail(prisma, { id: 800, priceVersionId: 50, itemId: 1, price1: 99 }); // stale version — must be ignored
    await addPriceDetail(prisma, {
      id: 801, priceVersionId: 51, itemId: 1, pkgTypeId: 9, entityQuantity: 400, entityUnit: 'lb',
      priceByPackage: false, entityItemCode: 'THEIR-7', minOrder1: 1, price1: 5.5, minOrder2: 100, price2: 4.25,
    });
    const { purchasing } = services(prisma);

    // qty 250 -> the $4.25 tier; packaging from the effective version.
    const res = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 250 }] }, actor);
    expect(res.packagedLines).toBe(1);

    const line = (await prisma.ordDetail.findFirst({ where: { ordrId: res.id }, select: { id: true, price: true } }))!;
    expect(Number(line.price)).toBe(4.25); // tiered price for qty 250 from the effective version (not the stale 99)
    const pricing = (await prisma.ordDetailPricing.findFirst({ where: { ordDetailId: line.id } }))!;
    expect(pricing.pkgTypeId).toBe(9);
    expect(pricing.entityQuantity).toBe(400);
    expect(pricing.entityUnit).toBe('lb');
    expect(pricing.entityItemCode).toBe('THEIR-7');
  });

  it('create() leaves a line unpackaged when the supplier has no price detail for the item', async () => {
    const supplier = await addEntity(prisma, { id: 201, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    const { purchasing } = services(prisma);
    const res = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 10, price: 2 }] }, actor);
    expect(res.packagedLines).toBe(0);
    expect(await prisma.ordDetailPricing.count()).toBe(0);
  });

  it('create() ignores a FUTURE-dated price version', async () => {
    const supplier = await addEntity(prisma, { id: 202, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addPriceVersion(prisma, { id: 60, entityId: supplier, effectiveDate: new Date('2020-01-01'), version: 1 });
    await addPriceVersion(prisma, { id: 61, entityId: supplier, effectiveDate: new Date(Date.now() + 365 * 24 * 3600 * 1000), version: 2 });
    await addPriceDetail(prisma, { id: 810, priceVersionId: 60, itemId: 1, price1: 7 });
    await addPriceDetail(prisma, { id: 811, priceVersionId: 61, itemId: 1, price1: 99 }); // future — must be ignored
    const { purchasing } = services(prisma);
    const res = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 5 }] }, actor);
    const line = (await prisma.ordDetail.findFirst({ where: { ordrId: res.id } }))!;
    expect(Number(line.price)).toBe(7); // current past version, not the future 99
  });

  it('create() picks a deterministic (lowest-id) detail when the version lists the item under several packages', async () => {
    const supplier = await addEntity(prisma, { id: 203, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addItem(prisma, { id: 8, code: 'DRUM' });
    await addItem(prisma, { id: 9, code: 'BAG' });
    await addPriceVersion(prisma, { id: 62, entityId: supplier, effectiveDate: new Date('2025-01-01'), version: 1 });
    await addPriceDetail(prisma, { id: 820, priceVersionId: 62, itemId: 1, pkgTypeId: 8, entityQuantity: 380, price1: 2.2 });
    await addPriceDetail(prisma, { id: 821, priceVersionId: 62, itemId: 1, pkgTypeId: 9, entityQuantity: 44, price1: 5.3 });
    const { purchasing } = services(prisma);
    const res = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 10 }] }, actor);
    const line = (await prisma.ordDetail.findFirst({ where: { ordrId: res.id } }))!;
    const pricing = (await prisma.ordDetailPricing.findFirst({ where: { ordDetailId: line.id } }))!;
    expect(pricing.pkgTypeId).toBe(8); // lowest-id detail (820 -> DRUM), deterministically
    expect(Number(line.price)).toBe(2.2);
  });

  it('create() preserves a price-by-package detail (raw per-package price + flag)', async () => {
    const supplier = await addEntity(prisma, { id: 204, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addItem(prisma, { id: 8, code: 'DRUM' });
    await addPriceVersion(prisma, { id: 63, entityId: supplier, effectiveDate: new Date('2025-01-01'), version: 1 });
    await addPriceDetail(prisma, { id: 830, priceVersionId: 63, itemId: 1, pkgTypeId: 8, entityQuantity: 7, priceByPackage: true, price1: 81 });
    const { purchasing } = services(prisma);
    const res = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 14 }] }, actor);
    const line = (await prisma.ordDetail.findFirst({ where: { ordrId: res.id } }))!;
    const pricing = (await prisma.ordDetailPricing.findFirst({ where: { ordDetailId: line.id } }))!;
    expect(Number(line.price)).toBe(81); // the raw per-package price, NOT divided
    expect(pricing.priceByPackage).toBe(true);
    expect(pricing.entityQuantity).toBe(7);
  });

  it('viewer (list) returns only the effective version details with resolved codes; empty when none', async () => {
    const supplier = await addEntity(prisma, { id: 205, isSupplier: true });
    await addItem(prisma, { id: 1, code: 'WIDGET', description: 'A widget' });
    await addItem(prisma, { id: 8, code: 'DRUM' });
    await addPriceVersion(prisma, { id: 64, entityId: supplier, effectiveDate: new Date('2020-01-01'), version: 1 });
    await addPriceVersion(prisma, { id: 65, entityId: supplier, effectiveDate: new Date('2025-01-01'), version: 2 });
    await addPriceDetail(prisma, { id: 840, priceVersionId: 64, itemId: 1, price1: 1 }); // stale version — excluded
    await addPriceDetail(prisma, { id: 841, priceVersionId: 65, itemId: 1, pkgTypeId: 8, entityQuantity: 44, entityItemCode: 'THEIR-X', price1: 5 });
    const { priceVersions } = services(prisma);

    const out = await priceVersions.list(supplier, {});
    expect(out.total).toBe(1);
    expect(out.rows[0]).toMatchObject({ itemCode: 'WIDGET', packageType: 'DRUM', perPackageQty: 44, theirCode: 'THEIR-X', price: 5 });
    expect(await priceVersions.list(999_999, {})).toMatchObject({ rows: [], total: 0 });
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

describe('PurchasingService line edits (NST PO)', () => {
  it('adds a line sourcing supplier packaging + tier price from the effective version, appended', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'lb' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'lb' });
    await addItem(prisma, { id: 9, code: 'DRUM' });
    await addPriceVersion(prisma, { id: 50, entityId: supplier, effectiveDate: new Date('2025-01-01'), version: 1 });
    await addPriceDetail(prisma, { id: 800, priceVersionId: 50, itemId: 2, pkgTypeId: 9, entityQuantity: 100, entityUnit: 'lb', price1: 3.5 });
    const { purchasing } = services(prisma);
    const po = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 10, price: 1 }] }, actor);

    const res = await purchasing.addLine(po.id, { itemId: 2, qtyReqd: 50 }, actor);
    expect(res.packaged).toBe(true);
    const line = (await prisma.ordDetail.findUnique({ where: { id: res.lineId } }))!;
    expect(line.ordrId).toBe(po.id);
    expect(line.itemId).toBe(2);
    expect(Number(line.price)).toBe(3.5); // sourced tier price (operator gave none)
    expect(line.sortOrder).toBe(2); // appended after the create line
    const pricing = (await prisma.ordDetailPricing.findFirst({ where: { ordDetailId: res.lineId } }))!;
    expect(pricing.pkgTypeId).toBe(9);
    expect(pricing.entityQuantity).toBe(100);
  });

  it('updates a line and removes a line (deleting its packaging snapshot)', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addItem(prisma, { id: 2, unit: 'lb' });
    const { purchasing } = services(prisma);
    const po = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 10, price: 1 }] }, actor);
    const added = await purchasing.addLine(po.id, { itemId: 2, qtyReqd: 5, price: 2 }, actor);

    await purchasing.updateLine(po.id, added.lineId, { qtyReqd: 8, price: 2.5 }, actor);
    let line = (await prisma.ordDetail.findUnique({ where: { id: added.lineId } }))!;
    expect(line.qtyReqd).toBe(8);
    expect(Number(line.price)).toBe(2.5);

    await purchasing.removeLine(po.id, added.lineId, actor);
    line = (await prisma.ordDetail.findUnique({ where: { id: added.lineId } }))!;
    expect(line).toBeNull();
    expect(await prisma.ordDetail.count({ where: { ordrId: po.id } })).toBe(1); // back to the create line
  });

  it('rejects removing the last line and any edit on a non-NST PO', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    const { purchasing } = services(prisma);
    const po = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 10, price: 1 }] }, actor);
    const onlyLine = (await prisma.ordDetail.findFirst({ where: { ordrId: po.id } }))!;

    await expect(purchasing.removeLine(po.id, onlyLine.id, actor)).rejects.toThrow(/at least one line/);

    await prisma.ordr.update({ where: { id: po.id }, data: { status: 'RLS' } });
    await expect(purchasing.addLine(po.id, { itemId: 1, qtyReqd: 1 }, actor)).rejects.toThrow(/not-started/);
    await expect(purchasing.updateLine(po.id, onlyLine.id, { qtyReqd: 5 }, actor)).rejects.toThrow(/not-started/);
  });

  it('rejects removing a line that already has receipts, and editing a line not on the PO (IDOR)', async () => {
    const supplier = await addEntity(prisma, { id: 200, isSupplier: true });
    await addItem(prisma, { id: 1, unit: 'lb' });
    await addItem(prisma, { id: 2, unit: 'lb' });
    await addLocation(prisma, { code: 'WH', context: 'WHS' });
    const { purchasing } = services(prisma);
    const po = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 10, price: 1 }] }, actor);
    const added = await purchasing.addLine(po.id, { itemId: 2, qtyReqd: 5, price: 2 }, actor);
    const createLine = (await prisma.ordDetail.findFirst({ where: { ordrId: po.id, itemId: 1 } }))!;

    // Receive against the create line, then it can't be removed.
    await purchasing.receive(po.id, { lines: [{ ordDetailId: createLine.id, lots: [{ qty: 4, manufacturerLot: 'M1' }] }] }, actor);
    await expect(purchasing.removeLine(po.id, createLine.id, actor)).rejects.toThrow(/has receipts/);
    // Nor can its ordered qty drop below the received quantity (masks an over-receipt).
    await expect(purchasing.updateLine(po.id, createLine.id, { qtyReqd: 2 }, actor)).rejects.toThrow(/already received/);
    // Raising the qty (above received) is fine.
    await purchasing.updateLine(po.id, createLine.id, { qtyReqd: 20 }, actor);
    expect((await prisma.ordDetail.findUnique({ where: { id: createLine.id } }))!.qtyReqd).toBe(20);
    // The other (un-received) line still removes.
    await purchasing.removeLine(po.id, added.lineId, actor);

    // IDOR: a line on a different PO can't be touched via this one.
    const other = await purchasing.create({ supplierId: supplier, lines: [{ itemId: 1, qtyReqd: 1, price: 1 }] }, actor);
    const otherLine = (await prisma.ordDetail.findFirst({ where: { ordrId: other.id } }))!;
    await expect(purchasing.updateLine(po.id, otherLine.id, { qtyReqd: 2 }, actor)).rejects.toThrow(/not on purchase order/);
  });
});
