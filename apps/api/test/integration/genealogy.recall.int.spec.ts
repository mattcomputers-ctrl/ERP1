import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addConsumptionEdge,
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrdDetailCommit,
  addOrder,
  addShipmentLot,
  addSublot,
  makePrisma,
  resetDb,
  services,
} from './support';

// Flow integration test: the real GenealogyService against a real Postgres —
// recall/trace start-resolution (incl. the raw-lot discriminator), the recursive
// lot_genealogy forward/back traversal, on-hand + shipment decoration, and the
// derive() rebuild from OrdDetailCommit.

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
});

describe('GenealogyService — recall start resolution', () => {
  it('an exact ERP1 lot wins, even when that lot also carries a supplier lot', async () => {
    await addLot(prisma, { lot: '105', supLot: '105', manfLot: '105' });
    const { genealogy } = services(prisma);
    const r = await genealogy.recall({ q: '105' });
    expect(r.startLots).toEqual(['105']);
    expect(r.matched).toEqual([{ query: '105', lot: '105', via: 'lot' }]);
  });

  it('matches a manufacturer lot ONLY on raw lots (SupLot set), never a legacy FG self-reference', async () => {
    // Legacy finished-good lot: ManfLot equals its own number, SupLot null — a
    // manufacturer-lot search must NOT match it (the substring/self-ref trap).
    await addLot(prisma, { lot: 'FG1', manfLot: 'SHARED', supLot: null });
    // Raw lot: SupLot set (the discriminator) — this is the one to match.
    await addLot(prisma, { lot: '105', manfLot: 'SHARED', supLot: 'SHARED' });
    const { genealogy } = services(prisma);
    const r = await genealogy.recall({ q: 'SHARED' });
    expect(r.startLots).toEqual(['105']);
    expect(r.matched).toEqual([{ query: 'SHARED', lot: '105', via: 'manufacturerLot', manufacturerLot: 'SHARED' }]);
  });

  it('matches the manufacturer lot case-insensitively', async () => {
    await addLot(prisma, { lot: '105', supLot: 'ABC123', manfLot: 'ABC123' });
    const { genealogy } = services(prisma);
    expect((await genealogy.recall({ q: 'abc123' })).startLots).toEqual(['105']);
  });

  it('returns every ERP1 lot that shares a manufacturer lot (split receipts)', async () => {
    await addLot(prisma, { lot: '105', supLot: 'DUP', manfLot: 'DUP' });
    await addLot(prisma, { lot: '106', supLot: 'DUP', manfLot: 'DUP' });
    const { genealogy } = services(prisma);
    expect((await genealogy.recall({ q: 'DUP' })).startLots.sort()).toEqual(['105', '106']);
  });

  it('returns no start lots for an unknown query', async () => {
    const { genealogy } = services(prisma);
    const r = await genealogy.recall({ q: 'NOPE' });
    expect(r.startLots).toEqual([]);
    expect(r.matched).toEqual([]);
  });
});

describe('GenealogyService — recall forward trace', () => {
  it('forward-traces a raw lot through batch to packout, with on-hand + shipments + summary', async () => {
    await addItem(prisma, { id: 1, code: 'RAW' });
    await addItem(prisma, { id: 2, code: 'FG' });
    await addLot(prisma, { lot: '105', itemId: 1, supLot: 'MFR9', manfLot: 'MFR9' });
    await addLot(prisma, { lot: 'B1', itemId: 2 });
    await addLot(prisma, { lot: 'P1', itemId: 2 });
    // raw -> batch (consumption), batch -> packout (the packaging hop)
    await addConsumptionEdge(prisma, { childLot: 'B1', parentLot: '105', qty: 50, source: 'consumption' });
    await addConsumptionEdge(prisma, { childLot: 'P1', parentLot: 'B1', qty: 50, source: 'OrdDetailCommit' });
    // on-hand on the packout lot
    const loc = await addLocation(prisma, { code: 'WH', context: 'WHS' });
    await addSublot(prisma, { id: 1_000_000_001, lot: 'P1' });
    await addInventory(prisma, { itemId: 2, sublotId: 1_000_000_001, locationId: loc, qty: 40 });
    // a shipment of the batch lot to a customer
    const cust = await addEntity(prisma, { id: 500, code: 'ACME', isBillTo: true });
    await addOrder(prisma, { id: 9000, context: 'SH', billToId: cust });
    await addShipmentLot(prisma, { lot: 'B1', ordrId: 9000, itemId: 2, qty: 10, unit: 'ea' });

    const { genealogy } = services(prisma);
    const r = await genealogy.recall({ q: 'MFR9' });

    expect(r.startLots).toEqual(['105']);
    expect(r.lineage.map((l) => l.lot).sort()).toEqual(['B1', 'P1']);
    expect(r.summary.descendantLots).toBe(2);
    expect(r.summary.affectedLots).toBe(3);
    expect(r.onHand.map((o) => o.lot)).toContain('P1');
    expect(r.summary.totalOnHandQty).toBe(40);
    expect(r.shipments).toHaveLength(1);
    expect(r.shipments[0]).toMatchObject({ lot: 'B1', orderId: 9000, qty: 10, customer: 'ACME' });
    expect(r.summary.shippedQty).toBe(10);
  });

  it('labels the focus lot kind (raw vs produced)', async () => {
    await addLot(prisma, { lot: '105', supLot: 'M1', manfLot: 'M1' });
    await addItem(prisma, { id: 2, code: 'FG' });
    await addOrder(prisma, { id: 800, context: 'MFBA' });
    const pk = await addOrdDetail(prisma, { id: 8001, ordrId: 800, context: 'PK', itemId: 2 });
    await addLot(prisma, { lot: 'B1', itemId: 2, ordDetailId: pk });
    const { genealogy } = services(prisma);

    expect((await genealogy.recall({ q: '105' })).focus[0].kind).toBe('raw');
    const produced = await genealogy.recall({ q: 'B1' });
    expect(produced.focus[0].kind).toBe('produced');
    expect(produced.focus[0].producedByContext).toBe('MFBA');
  });
});

describe('GenealogyService — trace (ancestors + descendants)', () => {
  it('returns ancestors and descendants of a batch lot', async () => {
    await addLot(prisma, { lot: '105', supLot: 'M2', manfLot: 'M2' });
    await addLot(prisma, { lot: 'B1' });
    await addLot(prisma, { lot: 'P1' });
    await addConsumptionEdge(prisma, { childLot: 'B1', parentLot: '105', qty: 1 });
    await addConsumptionEdge(prisma, { childLot: 'P1', parentLot: 'B1', qty: 1 });
    const { genealogy } = services(prisma);

    const r = await genealogy.trace({ lot: 'B1' });
    expect(r.lots.map((l) => l.lot)).toEqual(['B1']);
    expect(r.ancestors.map((l) => l.lot)).toEqual(['105']);
    expect(r.descendants.map((l) => l.lot)).toEqual(['P1']);
  });
});

describe('GenealogyService — derive (rebuild edges from OrdDetailCommit)', () => {
  it('derives batch->packout edges, idempotently', async () => {
    // Packout (MFPP) order: a UI consumption line + a PK produced line.
    await addOrder(prisma, { id: 700, context: 'MFPP' });
    const ui = await addOrdDetail(prisma, { id: 7001, ordrId: 700, context: 'UI' });
    const pk = await addOrdDetail(prisma, { id: 7002, ordrId: 700, context: 'PK' });
    // Batch (MFBA) order: the source production line the packout drew from.
    await addOrder(prisma, { id: 701, context: 'MFBA' });
    const src = await addOrdDetail(prisma, { id: 7011, ordrId: 701, context: 'PK' });
    // Lots: parent (batch) off the source line, child (packout) off the PK line.
    await addLot(prisma, { lot: 'B1', ordDetailId: src });
    await addLot(prisma, { lot: 'P1', ordDetailId: pk });
    await addOrdDetailCommit(prisma, { ordDetailId: ui, srcOrdDetailId: src, qty: 10 });
    const { genealogy } = services(prisma);

    await genealogy.derive();
    const edges = await prisma.lotGenealogy.findMany({ where: { source: 'OrdDetailCommit' } });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ childLot: 'P1', parentLot: 'B1', viaOrdrId: 700, qty: 10 });

    // A second derive yields the same single edge (rebuild is idempotent).
    await genealogy.derive();
    expect(await prisma.lotGenealogy.count({ where: { source: 'OrdDetailCommit' } })).toBe(1);
  });
});
