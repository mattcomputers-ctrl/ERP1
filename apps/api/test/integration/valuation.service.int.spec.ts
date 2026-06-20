import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addConsumptionEdge,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addSublot,
  makePrisma,
  onHandForLot,
  resetDb,
  valuationService,
} from './support';

// Integration tests for the valuation/consumption engine against a REAL Postgres
// — the DB-coupled behaviour unit tests can't reach: native-id allocation,
// specific-identification depletion across real Inventory parcels, FIFO ordering
// by real date columns, cost roll-up reading the lot_genealogy graph, and the
// warehouse/zone location resolution (incl. the raw-JOIN that replaced a
// bind-variable-overflowing IN list).

const D = (iso: string) => new Date(iso);
let prisma: PrismaClient;
const inTx = <T>(fn: (tx: any) => Promise<T>): Promise<T> => prisma.$transaction(fn);

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
});

describe('mintInventory', () => {
  it('creates an on-hand parcel with a native id (>= 1e9) and ascending allocation', async () => {
    const loc = await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    const sub = await addSublot(prisma, { id: 1, lot: 'L1' });
    const v = valuationService(prisma);

    const [id1, id2] = await inTx(async (tx) => [
      await v.mintInventory(tx, { itemId: 1, sublotId: sub, locationId: loc, qty: 7 }),
      await v.mintInventory(tx, { itemId: 1, sublotId: sub, locationId: loc, qty: 3 }),
    ]);

    expect(id1).toBe(1_000_000_001);
    expect(id2).toBe(1_000_000_002);
    const rows = await prisma.inventory.findMany({ where: { id: { in: [id1!, id2!] } }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.qty)).toEqual([7, 3]);
    expect(rows.every((r) => r.locationId === loc && r.itemId === 1 && r.sublotId === sub)).toBe(true);
  });

  it('no-ops (returns null) when there is no location to put stock in', async () => {
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    const sub = await addSublot(prisma, { id: 1, lot: 'L1' });
    const v = valuationService(prisma);
    const id = await inTx((tx) => v.mintInventory(tx, { itemId: 1, sublotId: sub, locationId: null, qty: 5 }));
    expect(id).toBeNull();
    expect(await prisma.inventory.count()).toBe(0);
  });

  it('ignores pre-existing legacy ids (< 1e9) and continues above the highest NATIVE id', async () => {
    const loc = await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    const sub = await addSublot(prisma, { id: 1, lot: 'L1' });
    // A legacy/imported parcel in the low id range — must NOT pull native ids down
    // (otherwise a later legacy re-import could clobber the native row).
    await addInventory(prisma, { id: 500_000, itemId: 1, sublotId: sub, locationId: loc, qty: 1 });
    const v = valuationService(prisma);

    const first = await inTx((tx) => v.mintInventory(tx, { itemId: 1, sublotId: sub, locationId: loc, qty: 2 }));
    expect(first).toBe(1_000_000_001); // legacy id 500000 ignored

    // Seed a higher native row and assert allocation continues above it.
    await addInventory(prisma, { id: 1_000_000_050, itemId: 1, sublotId: sub, locationId: loc, qty: 1 });
    const next = await inTx((tx) => v.mintInventory(tx, { itemId: 1, sublotId: sub, locationId: loc, qty: 1 }));
    expect(next).toBe(1_000_000_051);
  });
});

describe('depleteSpecific (specific identification)', () => {
  beforeEach(async () => {
    await addItem(prisma, { id: 1 });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  });

  it('draws a lot down across its parcels oldest-id first, never negative', async () => {
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'L1' });
    const p1 = await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 10 });
    const p2 = await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 5 });
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteSpecific(tx, 'L1', 12));
    expect(res).toEqual({ depleted: 12, shortfall: 0 });
    expect((await prisma.inventory.findUnique({ where: { id: p1 } }))!.qty).toBe(0); // first parcel emptied
    expect((await prisma.inventory.findUnique({ where: { id: p2 } }))!.qty).toBe(3); // remainder from second
  });

  it('reports a shortfall when on-hand is insufficient and leaves nothing negative', async () => {
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'L1' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 3 });
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteSpecific(tx, 'L1', 5));
    expect(res).toEqual({ depleted: 3, shortfall: 2 });
    expect(await onHandForLot(prisma, 'L1')).toBe(0);
  });

  it('only touches the target lot — other lots are untouched', async () => {
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    await addLot(prisma, { lot: 'L2', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'L1' });
    await addSublot(prisma, { id: 2, lot: 'L2' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 8 });
    await addInventory(prisma, { itemId: 1, sublotId: 2, locationId: 1, qty: 8 });
    const v = valuationService(prisma);

    await inTx((tx) => v.depleteSpecific(tx, 'L1', 5));
    expect(await onHandForLot(prisma, 'L1')).toBe(3);
    expect(await onHandForLot(prisma, 'L2')).toBe(8);
  });

  it('returns the full want as shortfall when the lot has no on-hand', async () => {
    const v = valuationService(prisma);
    const res = await inTx((tx) => v.depleteSpecific(tx, 'GHOST', 4));
    expect(res).toEqual({ depleted: 0, shortfall: 4 });
  });

  it('depletes a lot fanned out across MULTIPLE sublots, oldest Inventory id first', async () => {
    // One lot, two sublots, a parcel under each — the realistic recall case.
    await addLot(prisma, { lot: 'L1', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'L1' });
    await addSublot(prisma, { id: 2, lot: 'L1' });
    const p1 = await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 4 });
    const p2 = await addInventory(prisma, { itemId: 1, sublotId: 2, locationId: 1, qty: 4 });
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteSpecific(tx, 'L1', 6));
    expect(res).toEqual({ depleted: 6, shortfall: 0 });
    expect((await prisma.inventory.findUnique({ where: { id: p1 } }))!.qty).toBe(0); // first sublot's parcel emptied
    expect((await prisma.inventory.findUnique({ where: { id: p2 } }))!.qty).toBe(2); // remainder from the second sublot
    expect(await onHandForLot(prisma, 'L1')).toBe(2); // summed across both sublots
  });
});

describe('depleteFifo (oldest units first, by lot date)', () => {
  beforeEach(async () => {
    await addItem(prisma, { id: 1 });
    await addItem(prisma, { id: 2 });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  });

  it('depletes the older lot first, spilling the remainder into the newer lot', async () => {
    // Insert the NEWER lot FIRST so it gets the lower Inventory id. Only correct
    // date ordering (not the id tie-break / insertion order) can then put OLD first.
    await addLot(prisma, { lot: 'NEW', itemId: 1, receivedDate: D('2020-06-01') });
    await addLot(prisma, { lot: 'OLD', itemId: 1, receivedDate: D('2020-01-01') });
    await addSublot(prisma, { id: 1, lot: 'NEW' });
    await addSublot(prisma, { id: 2, lot: 'OLD' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 5 }); // NEW -> Inventory id 1
    await addInventory(prisma, { itemId: 1, sublotId: 2, locationId: 1, qty: 5 }); // OLD -> Inventory id 2
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteFifo(tx, 1, 7));
    expect(res.depleted).toBe(7);
    expect(res.shortfall).toBe(0);
    expect(res.picks).toEqual([
      { lot: 'OLD', qty: 5 }, // older despite the higher Inventory id
      { lot: 'NEW', qty: 2 },
    ]);
    expect(await onHandForLot(prisma, 'OLD')).toBe(0);
    expect(await onHandForLot(prisma, 'NEW')).toBe(3);
  });

  it('falls back to manufactured date when received date is absent, and puts undated lots last', async () => {
    // Insert the UNDATED lot FIRST (lower id) so only the received->manf fallback
    // (not the id tie-break) can put the dated MANF lot first.
    await addLot(prisma, { lot: 'UNDATED', itemId: 1, receivedDate: null, manfDate: null });
    await addLot(prisma, { lot: 'MANF', itemId: 1, receivedDate: null, manfDate: D('2019-01-01') });
    await addSublot(prisma, { id: 1, lot: 'UNDATED' });
    await addSublot(prisma, { id: 2, lot: 'MANF' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 4 }); // UNDATED -> Inventory id 1
    await addInventory(prisma, { itemId: 1, sublotId: 2, locationId: 1, qty: 4 }); // MANF -> Inventory id 2
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteFifo(tx, 1, 5));
    // MANF (dated via manf fallback) drawn fully first despite its higher id, then the undated lot.
    expect(res.picks).toEqual([
      { lot: 'MANF', qty: 4 },
      { lot: 'UNDATED', qty: 1 },
    ]);
  });

  it('breaks a date tie by Inventory id (lower id drawn first)', async () => {
    // Two lots received the SAME day — order must fall to the Inventory id tie-break.
    await addLot(prisma, { lot: 'T1', itemId: 1, receivedDate: D('2020-03-01') });
    await addLot(prisma, { lot: 'T2', itemId: 1, receivedDate: D('2020-03-01') });
    await addSublot(prisma, { id: 1, lot: 'T1' });
    await addSublot(prisma, { id: 2, lot: 'T2' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 3 }); // T1 -> Inventory id 1
    await addInventory(prisma, { itemId: 1, sublotId: 2, locationId: 1, qty: 3 }); // T2 -> Inventory id 2
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteFifo(tx, 1, 4));
    expect(res.picks).toEqual([
      { lot: 'T1', qty: 3 }, // lower Inventory id drawn first
      { lot: 'T2', qty: 1 },
    ]);
  });

  it('only depletes the requested item; another item is untouched; reports shortfall', async () => {
    await addLot(prisma, { lot: 'A', itemId: 1, receivedDate: D('2020-01-01') });
    await addLot(prisma, { lot: 'B', itemId: 2, receivedDate: D('2020-01-01') });
    await addSublot(prisma, { id: 1, lot: 'A' });
    await addSublot(prisma, { id: 2, lot: 'B' });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: 1, qty: 3 });
    await addInventory(prisma, { itemId: 2, sublotId: 2, locationId: 1, qty: 9 });
    const v = valuationService(prisma);

    const res = await inTx((tx) => v.depleteFifo(tx, 1, 10));
    expect(res.depleted).toBe(3);
    expect(res.shortfall).toBe(7);
    expect(res.picks).toEqual([{ lot: 'A', qty: 3 }]);
    expect(await onHandForLot(prisma, 'B')).toBe(9);
  });
});

describe('rollUpProducedCost (real specific-identification cost, with purchase-price fallback)', () => {
  it('sets the produced lot unit cost to Σ(qty × that lot cost) / produced qty — real, not averaged', async () => {
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'P', itemId: 1 });
    await addLot(prisma, { lot: 'R1', itemId: 1, unitCost: 5 });
    await addLot(prisma, { lot: 'R2', itemId: 1, unitCost: 2 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R1', qty: 10 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R2', qty: 5 });
    const v = valuationService(prisma);

    const unit = await inTx((tx) => v.rollUpProducedCost(tx, 'P', 100));
    expect(unit).toBeCloseTo(0.6, 10); // (10*5 + 5*2)/100, not (5+2)/2
    const p = await prisma.lot.findUnique({ where: { lot: 'P' }, select: { unitCost: true } });
    expect(Number(p!.unitCost)).toBeCloseTo(0.6, 10);
  });

  it('falls back to the input item purchase price when a consumed lot has no unit cost', async () => {
    await addItem(prisma, { id: 1, purchasePrice: 3 });
    await addLot(prisma, { lot: 'P2', itemId: 2 });
    await addLot(prisma, { lot: 'R', itemId: 1, unitCost: null }); // no lot cost; item 1 has purchasePrice 3
    await addItem(prisma, { id: 2 });
    await addConsumptionEdge(prisma, { childLot: 'P2', parentLot: 'R', qty: 4 });
    const v = valuationService(prisma);

    const unit = await inTx((tx) => v.rollUpProducedCost(tx, 'P2', 8));
    expect(unit).toBeCloseTo((4 * 3) / 8, 10); // 1.5
  });

  it('returns null and leaves the lot cost untouched when no input carries a cost', async () => {
    await addItem(prisma, { id: 1, purchasePrice: null });
    await addLot(prisma, { lot: 'P', itemId: 2 });
    await addLot(prisma, { lot: 'R', itemId: 1, unitCost: null });
    await addItem(prisma, { id: 2 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R', qty: 4 });
    const v = valuationService(prisma);

    const unit = await inTx((tx) => v.rollUpProducedCost(tx, 'P', 8));
    expect(unit).toBeNull();
    expect((await prisma.lot.findUnique({ where: { lot: 'P' } }))!.unitCost).toBeNull();
  });

  it('returns null when there are no consumption edges or produced qty is not positive', async () => {
    await addLot(prisma, { lot: 'P', itemId: 1 });
    await addItem(prisma, { id: 1 });
    const v = valuationService(prisma);
    expect(await inTx((tx) => v.rollUpProducedCost(tx, 'P', 100))).toBeNull(); // no edges
    await addLot(prisma, { lot: 'R', itemId: 1, unitCost: 5 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R', qty: 10 });
    expect(await inTx((tx) => v.rollUpProducedCost(tx, 'P', 0))).toBeNull(); // producedQty 0
  });

  it('recomputes from the full edge set each call (idempotent; not accumulated)', async () => {
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'P', itemId: 1 });
    await addLot(prisma, { lot: 'R1', itemId: 1, unitCost: 5 });
    await addLot(prisma, { lot: 'R2', itemId: 1, unitCost: 2 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R1', qty: 10, viaOrdrId: 1 });
    const v = valuationService(prisma);

    expect(await inTx((tx) => v.rollUpProducedCost(tx, 'P', 100))).toBeCloseTo(0.5, 10); // 10*5/100
    // Re-running with no new edges must NOT accumulate (still 0.5, not 1.0).
    expect(await inTx((tx) => v.rollUpProducedCost(tx, 'P', 100))).toBeCloseTo(0.5, 10);
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'P' } }))!.unitCost)).toBeCloseTo(0.5, 10);

    // A further consumption batch (distinct viaOrdr) recomputes over ALL edges.
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R2', qty: 5, viaOrdrId: 2 });
    expect(await inTx((tx) => v.rollUpProducedCost(tx, 'P', 100))).toBeCloseTo(0.6, 10); // (10*5 + 5*2)/100
  });

  it('ignores non-consumption edges (e.g. OrdDetailCommit packaging links)', async () => {
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'P', itemId: 1 });
    await addLot(prisma, { lot: 'R1', itemId: 1, unitCost: 5 });
    await addLot(prisma, { lot: 'PK', itemId: 1, unitCost: 999 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'R1', qty: 10 });
    await addConsumptionEdge(prisma, { childLot: 'P', parentLot: 'PK', qty: 10, source: 'OrdDetailCommit' });
    const v = valuationService(prisma);

    const unit = await inTx((tx) => v.rollUpProducedCost(tx, 'P', 100));
    expect(unit).toBeCloseTo(0.5, 10); // only the consumption edge (10*5/100), the 999 packaging link ignored
  });
});

describe('resolveLocationId / default stock location', () => {
  it('uses the configured location code when the setting is set', async () => {
    await addLocation(prisma, { id: 1, code: 'RECV', context: 'WHS' });
    await addLocation(prisma, { id: 2, code: 'OTHER', context: 'WHS' });
    await prisma.appSetting.create({ data: { key: 'inventory.receivingLocation', value: 'RECV' } });
    const v = valuationService(prisma);

    const id = await inTx((tx) => v.resolveLocationId(tx, 'inventory.receivingLocation'));
    expect(id).toBe(1);
  });

  it('defaults to the most-used warehouse/zone — never a code-less vessel that holds more', async () => {
    const wh = await addLocation(prisma, { code: 'WH', context: 'WHS' });
    const zone = await addLocation(prisma, { code: 'Z', context: 'ZON' });
    const vessel = await addLocation(prisma, { code: 'V', context: 'VSL' });
    await addItem(prisma, { id: 1 });
    await addLot(prisma, { lot: 'L', itemId: 1 });
    await addSublot(prisma, { id: 1, lot: 'L' });
    // The vessel holds the MOST inventory rows, but it is not a WHS/ZON.
    for (let i = 0; i < 5; i++) await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: vessel, qty: 1 });
    for (let i = 0; i < 3; i++) await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: wh, qty: 1 });
    await addInventory(prisma, { itemId: 1, sublotId: 1, locationId: zone, qty: 1 });
    const v = valuationService(prisma);

    const id = await inTx((tx) => v.resolveLocationId(tx, 'inventory.receivingLocation'));
    expect(id).toBe(wh); // most-used among WHS/ZON, not the vessel
  });

  it('falls through to the default when the configured code matches no location (stale/typo setting)', async () => {
    const wh = await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await prisma.appSetting.create({ data: { key: 'inventory.receivingLocation', value: 'GONE' } }); // no such code
    const v = valuationService(prisma);

    const id = await inTx((tx) => v.resolveLocationId(tx, 'inventory.receivingLocation'));
    expect(id).toBe(wh); // not null, not a throw — falls through to the default warehouse
  });

  it('falls back to a warehouse/zone with no inventory, then to any pickable location', async () => {
    const wh = await addLocation(prisma, { code: 'WH', context: 'WHS' }); // no inventory anywhere
    const v = valuationService(prisma);
    const id = await inTx((tx) => v.resolveLocationId(tx, 'inventory.receivingLocation'));
    expect(id).toBe(wh);
  });

  it('resolves across many warehouse/zone locations without a per-id bind overflow', async () => {
    // No inventory anywhere, so the most-used JOIN is empty and resolution must
    // fall through to the warehouse lookup across ALL coded WHS locations. A
    // reintroduced "IN (<every coded id>)" approach would overflow Postgres bind
    // limits here (it did at ~16k); the current code must resolve without error.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Location" ("LocationCode","Context") SELECT 'WH'||g, 'WHS' FROM generate_series(1, 20000) g`,
    );
    const v = valuationService(prisma);

    const id = await inTx((tx) => v.resolveLocationId(tx, 'inventory.receivingLocation'));
    expect(id).not.toBeNull();
    const loc = await prisma.location.findUnique({ where: { id: id! }, select: { context: true } });
    expect(loc?.context).toBe('WHS');
  });
});
