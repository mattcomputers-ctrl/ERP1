import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import {
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrder,
  addSublot,
  makePrisma,
  onHandForLot,
  resetDb,
  seedActor,
  services,
} from './support';

// Flow integration tests: the real OrdersService consumption/shipment flows
// against a real Postgres — lineage capture + valuation depletion + cost roll-up
// wired together, the multi-service path unit tests can't reach.

const D = (iso: string) => new Date(iso);
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

describe('OrdersService.consumeLots (specific-id deplete + real cost roll-up)', () => {
  it('records consumption, depletes the consumed lots, and rolls REAL cost into the produced lot', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1 }); // product
    await addItem(prisma, { id: 2 }); // raw A
    await addItem(prisma, { id: 3 }); // raw B
    await addOrder(prisma, { id: 600, context: 'MFBA', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: 700, ordrId: 600, context: 'PK', itemId: 1 });
    await addLot(prisma, { lot: 'PROD', itemId: 1, ordDetailId: 700 }); // produced lot of record
    await addLot(prisma, { lot: 'RA', itemId: 2, unitCost: 5 });
    await addLot(prisma, { lot: 'RB', itemId: 3, unitCost: 2 });
    await addSublot(prisma, { id: 1, lot: 'RA' });
    await addSublot(prisma, { id: 2, lot: 'RB' });
    await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 200 });
    await addInventory(prisma, { itemId: 3, sublotId: 2, locationId: 1, qty: 200 });
    const { orders } = services(prisma);

    const res = await orders.consumeLots(600, { lots: [{ lot: 'RA', qty: 10 }, { lot: 'RB', qty: 5 }] }, actor);
    expect(res.unitCost).toBeCloseTo(0.6, 10); // (10*5 + 5*2)/100 — real cost, not averaged
    expect(res.shortfalls).toEqual([]);

    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PROD' } }))!.unitCost)).toBeCloseTo(0.6, 10);
    expect(await onHandForLot(prisma, 'RA')).toBe(190);
    expect(await onHandForLot(prisma, 'RB')).toBe(195);
    const edges = await prisma.lotGenealogy.findMany({ where: { childLot: 'PROD', source: 'consumption' } });
    expect(edges.map((e) => e.parentLot).sort()).toEqual(['RA', 'RB']);
  });

  it('accumulates qty + cost across repeated consume calls (ON CONFLICT roll-up, recompute from the full edge set)', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1 }); // product
    await addItem(prisma, { id: 2 }); // raw
    await addOrder(prisma, { id: 620, context: 'MFBA', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: 720, ordrId: 620, context: 'PK', itemId: 1 });
    await addLot(prisma, { lot: 'PRODA', itemId: 1, ordDetailId: 720 });
    await addLot(prisma, { lot: 'RA', itemId: 2, unitCost: 5 });
    await addSublot(prisma, { id: 1, lot: 'RA' });
    await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 200 });
    const { orders } = services(prisma);

    await orders.consumeLots(620, { lots: [{ lot: 'RA', qty: 10 }] }, actor);
    const second = await orders.consumeLots(620, { lots: [{ lot: 'RA', qty: 5 }] }, actor);

    // One edge whose qty ACCUMULATED to 15 (not overwritten to 5, not duplicated).
    const edges = await prisma.lotGenealogy.findMany({ where: { childLot: 'PRODA', parentLot: 'RA' } });
    expect(edges).toHaveLength(1);
    expect(edges[0].qty).toBe(15);
    expect(await onHandForLot(prisma, 'RA')).toBe(185); // depleted 10 then 5
    // Cost recomputed from the full (accumulated) edge set: 15*5/100 = 0.75.
    expect(second.unitCost).toBeCloseTo(0.75, 10);
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PRODA' } }))!.unitCost)).toBeCloseTo(0.75, 10);
  });

  it('rejects consuming into a non-MFBA order', async () => {
    await addOrder(prisma, { id: 610, context: 'SH' });
    const { orders } = services(prisma);
    await expect(orders.consumeLots(610, { lots: [{ lot: 'X', qty: 1 }] }, actor)).rejects.toThrow(/Only batch/);
  });
});

describe('OrdersService.consumeQuantity (FIFO + shortfalls contract)', () => {
  // A minimal MFBA order with a produced lot of record (the consume target).
  async function product(orderId: number, lineId: number, prodLot: string) {
    await addItem(prisma, { id: 1 }); // product
    await addOrder(prisma, { id: orderId, context: 'MFBA', actualBatchSize: 50 });
    await addOrdDetail(prisma, { id: lineId, ordrId: orderId, context: 'PK', itemId: 1 });
    await addLot(prisma, { lot: prodLot, itemId: 1, ordDetailId: lineId });
  }

  it('consumes a not-lot-traced item FIFO, records lineage, and returns a top-level shortfalls array', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await product(601, 701, 'PRODQ');
    await addItem(prisma, { id: 2, lotTracked: false }); // raw, not traced
    // Insert the NEWER lot FIRST (lower Inventory id) so only correct date ordering
    // — not the id tie-break — can draw the OLDER lot first.
    await addLot(prisma, { lot: 'NEW', itemId: 2, unitCost: 9, receivedDate: D('2020-06-01') });
    await addLot(prisma, { lot: 'OLD', itemId: 2, unitCost: 3, receivedDate: D('2020-01-01') });
    await addSublot(prisma, { id: 1, lot: 'NEW' });
    await addSublot(prisma, { id: 2, lot: 'OLD' });
    await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 5 }); // NEW -> Inventory id 1
    await addInventory(prisma, { itemId: 2, sublotId: 2, locationId: 1, qty: 5 }); // OLD -> Inventory id 2
    const { orders } = services(prisma);

    const res = await orders.consumeQuantity(601, { items: [{ itemId: 2, qty: 7 }] }, actor);
    expect(Array.isArray(res.shortfalls)).toBe(true); // the contract a prior review caught missing
    expect(res.shortfalls).toEqual([]);
    expect(await onHandForLot(prisma, 'OLD')).toBe(0); // FIFO: oldest fully drawn first (despite higher id)
    expect(await onHandForLot(prisma, 'NEW')).toBe(3);
    const edges = await prisma.lotGenealogy.findMany({ where: { childLot: 'PRODQ', source: 'consumption' } });
    expect(edges.map((e) => e.parentLot).sort()).toEqual(['NEW', 'OLD']);
  });

  it('reports a top-level shortfall (labelled by item code) when on-hand is insufficient', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await product(602, 702, 'PRODS');
    await addItem(prisma, { id: 2, code: 'SHORTRAW', lotTracked: false });
    await addLot(prisma, { lot: 'L', itemId: 2, receivedDate: D('2020-01-01') });
    await addSublot(prisma, { id: 1, lot: 'L' });
    await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 2 });
    const { orders } = services(prisma);

    const res = await orders.consumeQuantity(602, { items: [{ itemId: 2, qty: 10 }] }, actor);
    expect(res.shortfalls).toEqual([{ lot: 'SHORTRAW', shortfall: 8 }]);
  });

  it('rejects a lot-traced item (must use consume-lots)', async () => {
    await product(603, 703, 'PRODT');
    await addItem(prisma, { id: 2, code: 'TRACED', lotTracked: true });
    const { orders } = services(prisma);
    await expect(orders.consumeQuantity(603, { items: [{ itemId: 2, qty: 1 }] }, actor)).rejects.toThrow(/lot-traced/);
  });
});

describe('OrdersService.shipLots (record + deplete shipped FG lots)', () => {
  it('records a shipment_lot row and depletes the shipped lot on-hand', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, lotTracked: true, unit: 'lb' }); // FG, lot-traced
    await addOrder(prisma, { id: 604, context: 'SH', poNumber: 'CPO-9' });
    await addOrdDetail(prisma, { id: 704, ordrId: 604, context: 'SH', itemId: 1, qtyReqd: 50 });
    await addLot(prisma, { lot: 'FG1', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'FG1' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 50 });
    const { orders } = services(prisma);

    const res = await orders.shipLots(604, { lots: [{ lot: 'FG1', qty: 20, ordDetailId: 704 }] }, actor);
    expect(res.shipped).toBe(1);
    expect(res.shortfalls).toEqual([]);

    const ship = await prisma.shipmentLot.findMany({ where: { ordrId: 604 } });
    expect(ship).toHaveLength(1);
    expect(ship[0].lot).toBe('FG1');
    expect(ship[0].qty).toBe(20);
    expect(ship[0].unit).toBe('lb'); // defaulted from the item unit
    expect(ship[0].ordDetailId).toBe(704); // the line fulfilled (recall edge)
    expect(ship[0].itemId).toBe(1); // resolved from the lot's item
    expect(ship[0].shippedAt).toBeInstanceOf(Date); // ship date for recall
    expect(await onHandForLot(prisma, 'FG1')).toBe(30); // depleted 50 -> 30
  });

  it('rejects an ordDetailId that belongs to a DIFFERENT order (IDOR)', async () => {
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, lotTracked: true });
    await addOrder(prisma, { id: 604, context: 'SH' });
    await addOrdDetail(prisma, { id: 704, ordrId: 604, context: 'SH', itemId: 1, qtyReqd: 50 });
    await addOrder(prisma, { id: 607, context: 'SH' }); // a different order
    await addOrdDetail(prisma, { id: 707, ordrId: 607, context: 'SH', itemId: 1, qtyReqd: 50 });
    await addLot(prisma, { lot: 'FG1', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'FG1' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 50 });
    const { orders } = services(prisma);

    await expect(
      orders.shipLots(604, { lots: [{ lot: 'FG1', qty: 1, ordDetailId: 707 }] }, actor),
    ).rejects.toThrow(/not a line on shipping order/);
    expect(await prisma.shipmentLot.count()).toBe(0); // nothing written on rejection
  });

  it('rejects shipping a lot whose item is not lot-traced', async () => {
    await addItem(prisma, { id: 1, code: 'UNTRACED', lotTracked: false });
    await addOrder(prisma, { id: 605, context: 'SH' });
    await addLot(prisma, { lot: 'FG2', itemId: 1 });
    const { orders } = services(prisma);
    await expect(orders.shipLots(605, { lots: [{ lot: 'FG2', qty: 1 }] }, actor)).rejects.toThrow(/not lot-traced/);
  });

  it('rejects shipping on a non-SH order', async () => {
    await addOrder(prisma, { id: 606, context: 'MFBA' });
    const { orders } = services(prisma);
    await expect(orders.shipLots(606, { lots: [{ lot: 'X', qty: 1 }] }, actor)).rejects.toThrow(/Only shipping/);
  });
});
