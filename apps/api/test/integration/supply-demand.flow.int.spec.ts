import { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SupplyDemandService } from '../../src/planning/supply-demand.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addInventory, addItem, addLocation, addLot, addOrdDetail, addOrdDetailCommit, addOrder,
  addSublot, makePrisma, resetDb, seedActor,
} from './support';

// Inventory Supply & Demand (UG §13.3 "Allocate Demand", read-only): per-item
// sources (warehouse stock / POs / production orders), open demand, and the
// OrdDetailCommit allocation edges between them.

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  await seedActor(prisma);
});

const svc = () => new SupplyDemandService(prisma as unknown as PrismaService);

describe('supply & demand', () => {
  it('assembles sources, demand, and allocation edges for one item', async () => {
    const bulk = await addItem(prisma, { id: 901, code: 'BULK1' });
    await addItem(prisma, { id: 902, code: 'PACKOUT1' });

    // Warehouse stock: 40 available at WHS + 5 at a sample location (excluded).
    const whs = await addLocation(prisma, { code: 'WHS', context: 'WHS' });
    const smp = await addLocation(prisma, { code: 'SMP', context: 'SMP' });
    await addLot(prisma, { lot: 'B1', itemId: bulk });
    await addSublot(prisma, { id: 57001, lot: 'B1' });
    await addInventory(prisma, { itemId: bulk, sublotId: 57001, locationId: whs, qty: 40 });
    await addInventory(prisma, { itemId: bulk, sublotId: 57001, locationId: smp, qty: 5 });

    // Supply: an open PO for 100 (30 received) and a batch order producing 50.
    await addOrder(prisma, { id: 9401, context: 'PO' });
    await addOrdDetail(prisma, { id: 94011, ordrId: 9401, context: 'PO', itemId: bulk, qtyReqd: 100 });
    await prisma.ordDetail.update({ where: { id: 94011 }, data: { qtyUsed: 30 } });
    await addOrder(prisma, { id: 9402, context: 'MFBA', status: 'RLS' });
    await addOrdDetail(prisma, { id: 94021, ordrId: 9402, context: 'PK', itemId: bulk, qtyReqd: 50 });

    // Demand: a packaging order consuming 60 bulk (25 committed from the
    // batch above — the OrdDetailCommit edge) + a shipping order for 10.
    await addOrder(prisma, { id: 9403, context: 'MFPP', status: 'RLS' });
    await addOrdDetail(prisma, { id: 94031, ordrId: 9403, context: 'UI', itemId: bulk, qtyReqd: 60 });
    await addOrdDetail(prisma, { id: 94032, ordrId: 9403, context: 'PK', itemId: 902, qtyReqd: 200 });
    await addOrdDetailCommit(prisma, { ordDetailId: 94031, srcOrdDetailId: 94021, qty: 25 });
    await addOrder(prisma, { id: 9404, context: 'SH', status: 'NST' });
    await addOrdDetail(prisma, { id: 94041, ordrId: 9404, context: 'SH', itemId: bulk, qtyReqd: 10 });

    // A closed order's line must not appear.
    await addOrder(prisma, { id: 9405, context: 'SH', status: 'CLS' });
    await addOrdDetail(prisma, { id: 94051, ordrId: 9405, context: 'SH', itemId: bulk, qtyReqd: 99 });

    const r = await svc().forItem(bulk);
    expect(r.item.itemCode).toBe('BULK1');
    expect(r.totals.availableStock).toBe(40); // SMP sample stock excluded

    const kinds = r.sources.map((s) => s.kind);
    expect(kinds).toEqual(['INV', 'PO', 'MFBA']);
    expect(r.sources[1]).toMatchObject({ orderId: 9401, supplyQty: 70 }); // 100 - 30 received
    expect(r.sources[2]).toMatchObject({ orderId: 9402, supplyQty: 50, allocatedQty: 25, balanceQty: 25 });

    expect(r.demands).toHaveLength(2);
    const pkg = r.demands.find((d) => d.orderId === 9403)!;
    expect(pkg).toMatchObject({ requiredQty: 60, committedQty: 25, balanceQty: 35, itemProduceCode: 'PACKOUT1', qtyProduce: 200 });
    const ship = r.demands.find((d) => d.orderId === 9404)!;
    expect(ship).toMatchObject({ requiredQty: 10, committedQty: 0, balanceQty: 10, itemProduceCode: null });

    expect(r.allocations).toEqual([{ demandOrdDetailId: 94031, srcOrdDetailId: 94021, qty: 25 }]);
    expect(r.totals.supply).toBe(160); // 40 + 70 + 50
    expect(r.totals.openDemand).toBe(70); // 60 + 10

    // Item picker + guards.
    const opts = await svc().itemOptions('BULK');
    expect(opts.rows.map((o) => o.itemCode)).toContain('BULK1');
    await expect(svc().forItem(424242)).rejects.toThrow(/not found/);
  });

  it('open demand sums remaining (not stale commits) and drops edges to closed orders', async () => {
    const bulk = await addItem(prisma, { id: 903, code: 'BULK2' });

    // Open packaging order: 60 required, commit of 25, then 50 EXECUTED.
    // Commits are never decremented — remaining (10) is the open demand.
    await addOrder(prisma, { id: 9501, context: 'MFBA', status: 'RLS' });
    await addOrdDetail(prisma, { id: 95011, ordrId: 9501, context: 'PK', itemId: bulk, qtyReqd: 50 });
    await addOrder(prisma, { id: 9502, context: 'MFPP', status: 'RLS' });
    await addOrdDetail(prisma, { id: 95021, ordrId: 9502, context: 'UI', itemId: bulk, qtyReqd: 60 });
    await addOrdDetailCommit(prisma, { ordDetailId: 95021, srcOrdDetailId: 95011, qty: 25 });
    await prisma.ordDetail.update({ where: { id: 95021 }, data: { qtyUsed: 50 } });

    // A commit whose source batch is CLOSED is settled history: excluded
    // from the edges and from the demand line's committed sum.
    await addOrder(prisma, { id: 9503, context: 'MFBA', status: 'CLS' });
    await addOrdDetail(prisma, { id: 95031, ordrId: 9503, context: 'PK', itemId: bulk, qtyReqd: 30 });
    await addOrdDetailCommit(prisma, { ordDetailId: 95021, srcOrdDetailId: 95031, qty: 30 });

    const r = await svc().forItem(bulk);
    expect(r.totals.openDemand).toBe(10); // 60 - 50 executed
    const line = r.demands.find((d) => d.ordDetailId === 95021)!;
    expect(line.committedQty).toBe(25); // the closed batch's 30 not counted
    expect(r.allocations).toEqual([{ demandOrdDetailId: 95021, srcOrdDetailId: 95011, qty: 25 }]);
    // The closed batch also isn't a source.
    expect(r.sources.filter((s) => s.kind !== 'INV').map((s) => s.orderId)).toEqual([9501]);
  });
});
