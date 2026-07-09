import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermissionService } from '../../src/auth/permission.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { ViewersService } from '../../src/viewers/viewers.service';
import { VIEWERS } from '../../src/viewers/viewer-registry';
import { hashPassword, seedUserWithPrograms } from './http-support';
import { addEntity, addItem, addLot, addOrdDetailCommit, addOrder, addSublot, makePrisma, resetDb } from './support';

// §18 declarative viewer platform: the generic executor's math and semantics
// against real Postgres. Every SQL fragment in the registry also executes in
// the HTTP sweep (viewers.http.spec.ts); here we pin the reconstructed
// formulas (at-date sums, by-package prices, committed/uncommitted, actual
// cost) with seeded fixtures.

let prisma: PrismaClient;
let userId: string;
let hash: string;

const svc = () =>
  new ViewersService(prisma as unknown as PrismaService, new PermissionService(prisma as unknown as PrismaService));

const ALL_PROGRAMS = VIEWERS.map((v) => v.program);

beforeAll(async () => {
  prisma = makePrisma();
  await prisma.$connect();
  hash = await hashPassword(prisma, 'pw-View3r!');
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb(prisma);
  userId = await seedUserWithPrograms(prisma, { email: 'v@test.local', passwordHash: hash, programs: ALL_PROGRAMS });
});

// --- fixture helpers -------------------------------------------------------

let nextMovementId = 1;
async function addMovement(data: {
  context: string;
  changeSetId: number;
  itemId?: number | null;
  sublotId?: number | null;
  legs: Array<{ context: string; ownerId?: number; locationId?: number | null; ordDetailId?: number | null; qty?: number | null; value?: number | null }>;
}): Promise<number> {
  const id = nextMovementId++;
  await prisma.invMovement.create({
    data: { id, context: data.context, changeSetId: data.changeSetId, itemId: data.itemId ?? null, sublotId: data.sublotId ?? null },
  });
  for (const leg of data.legs) {
    await prisma.invMovementDtl.create({
      data: {
        invMovementId: id,
        context: leg.context,
        ownerId: leg.ownerId ?? 4,
        locationId: leg.locationId ?? null,
        ordDetailId: leg.ordDetailId ?? null,
        qty: leg.qty ?? null,
        value: leg.value ?? null,
      },
    });
  }
  return id;
}

async function addChangeSet(data: { id: number; context: string; ordrId?: number | null; changeDate: string; poNumber?: string | null; transId?: number | null }) {
  await prisma.changeSet.create({
    data: {
      id: data.id,
      context: data.context,
      ordrId: data.ordrId ?? null,
      changeDate: new Date(data.changeDate),
      poNumber: data.poNumber ?? null,
      transId: data.transId ?? null,
    },
  });
}

// --- tests -----------------------------------------------------------------

describe('viewer platform: access & metadata', () => {
  it('lists only the viewers the user has programs for', async () => {
    const limitedId = await seedUserWithPrograms(prisma, {
      email: 'limited@test.local',
      passwordHash: hash,
      programs: ['viewers.shipmentDetail'],
    });
    const all = await svc().list(userId);
    expect(all.viewers.map((v) => v.id).sort()).toEqual(VIEWERS.map((v) => v.id).sort());
    const limited = await svc().list(limitedId);
    expect(limited.viewers.map((v) => v.id)).toEqual(['shipment-detail']);
  });

  it('403s a viewer without its program; 404s an unknown viewer', async () => {
    const limitedId = await seedUserWithPrograms(prisma, {
      email: 'limited@test.local',
      passwordHash: hash,
      programs: ['viewers.shipmentDetail'],
    });
    await expect(svc().rows(limitedId, 'inventory-movement', {})).rejects.toThrow(/permission/);
    await expect(svc().rows(userId, 'nope', {})).rejects.toThrow(/Unknown viewer/);
  });

  it('rejects non-whitelisted or non-sortable sort keys and bad params', async () => {
    await expect(svc().rows(userId, 'shipment-detail', { sort: 'itemCode;DROP TABLE x:asc' })).rejects.toThrow(/Invalid sort/);
    await expect(svc().rows(userId, 'shipment-detail', { sort: 'shipToName:asc' })).rejects.toThrow(/Invalid sort/);
    await expect(svc().rows(userId, 'shipment-detail', { p_from: '07/01/2026' })).rejects.toThrow(/Invalid date/);
    // Calendar-impossible or out-of-range dates 400 instead of dying in the cast.
    await expect(svc().rows(userId, 'shipment-detail', { p_from: '2026-02-31' })).rejects.toThrow(/Invalid date/);
    await expect(svc().rows(userId, 'shipment-detail', { p_to: '9999-12-31' })).rejects.toThrow(/Invalid date/);
    await expect(svc().rows(userId, 'inventory-movement', { p_legs: 'bogus' })).rejects.toThrow(/Invalid value/);
    // Extreme page values 400 instead of overflowing the Postgres OFFSET.
    await expect(svc().rows(userId, 'shipment-detail', { page: '100000000000000000000' })).rejects.toThrow(/Invalid number/);
    // Duplicated query params (Express arrays) read as absent, not a crash.
    await expect(
      svc().rows(userId, 'shipment-detail', { q: ['a', 'b'] as unknown as string }),
    ).resolves.toMatchObject({ total: 0 });
    // Required-with-default: a bare call resolves using today's date.
    await expect(svc().rows(userId, 'inventory-at-date', {})).resolves.toMatchObject({ total: 0 });
  });
});

describe('shipment detail', () => {
  beforeEach(async () => {
    await addEntity(prisma, { id: 4, code: 'AREA' });
    await addEntity(prisma, { id: 20, code: 'CUST', isShipTo: true });
    await addItem(prisma, { id: 12, code: 'CTA1184' });
    await prisma.ordr.create({
      data: { id: 500, context: 'SH', status: 'RLS', shipToId: 20, poNumber: 'HDR-PO', placedBy: 'mel' },
    });
    // $50 per 25-lb drum, priced by package.
    await prisma.ordDetail.create({
      data: { id: 5001, ordrId: 500, context: 'SH', itemId: 12, qtyReqd: 100, qtyUsed: 10, price: 50, isOpen: true },
    });
    await prisma.ordDetailPricing.create({
      data: { ordDetailId: 5001, priceByPackage: true, entityQuantity: 25, qtyPerEntityQty: 25, entityUnit: 'lb' },
    });
    await addChangeSet({ id: 900, context: 'SH', ordrId: 500, changeDate: '2026-06-15T14:30:00.000Z', poNumber: 'CUST-PO-9' });
    await prisma.changeSetShipment.create({ data: { changeSetId: 900, waybillId: null } });
    await addMovement({
      context: 'SH', changeSetId: 900, itemId: 12,
      legs: [{ context: 'US', ordDetailId: 5001, qty: -10, value: -15 }],
    });
    // A purchase receipt movement must NOT appear in the shipment viewer.
    await addChangeSet({ id: 901, context: 'PO', changeDate: '2026-06-16T10:00:00.000Z' });
    await addMovement({ context: 'PO', changeSetId: 901, itemId: 12, legs: [{ context: 'MK', qty: 40, value: 60 }] });
  });

  it('shows shipped lines with legacy price math (by-package) and unit cost', async () => {
    const res = await svc().rows(userId, 'shipment-detail', {});
    expect(res.total).toBe(1);
    const row = res.rows[0] as Record<string, number | string>;
    expect(row.ordr).toBe(500);
    expect(row.itemCode).toBe('CTA1184');
    expect(row.qtyShipped).toBe(10);
    expect(row.unitPrice).toBeCloseTo(2, 6); // $50/pkg ÷ 25 lb
    expect(row.totalAmount).toBeCloseTo(20, 6); // 10 lb × $2
    expect(row.unitCost).toBeCloseTo(1.5, 6); // -15 / -10
    expect(row.poNumber).toBe('CUST-PO-9');
    expect(String(row.dateShipped)).toContain('2026-06-15');
  });

  it('date params bound the shipped window (inclusive from, inclusive to-day)', async () => {
    const hit = await svc().rows(userId, 'shipment-detail', { p_from: '2026-06-15', p_to: '2026-06-15' });
    expect(hit.total).toBe(1);
    const missBefore = await svc().rows(userId, 'shipment-detail', { p_to: '2026-06-14' });
    expect(missBefore.total).toBe(0);
    const missAfter = await svc().rows(userId, 'shipment-detail', { p_from: '2026-06-16' });
    expect(missAfter.total).toBe(0);
  });

  it('free-text search hits searchable columns only, treating % _ \\ literally', async () => {
    const byCode = await svc().rows(userId, 'shipment-detail', { q: 'cta11' });
    expect(byCode.total).toBe(1);
    const byOrdr = await svc().rows(userId, 'shipment-detail', { q: '500' });
    expect(byOrdr.total).toBe(1);
    const none = await svc().rows(userId, 'shipment-detail', { q: 'zzz-nothing' });
    expect(none.total).toBe(0);
    // ILIKE metacharacters are escaped: a bare % is a literal, not match-all.
    const literalPercent = await svc().rows(userId, 'shipment-detail', { q: '%' });
    expect(literalPercent.total).toBe(0);
    const literalUnderscore = await svc().rows(userId, 'shipment-detail', { q: 'CTA____' });
    expect(literalUnderscore.total).toBe(0);
  });
});

describe('open order details (shipping + MF): committed / uncommitted', () => {
  beforeEach(async () => {
    await addItem(prisma, { id: 12, code: 'CTA1184' });
    await addOrder(prisma, { id: 500, context: 'SH', status: 'RLS' });
    await prisma.ordDetail.create({
      data: { id: 5001, ordrId: 500, context: 'SH', itemId: 12, qtyReqd: 100, qtyUsed: 40, qtyCommitted: 10, price: 5, isOpen: true },
    });
    await prisma.ordDetailPricing.create({ data: { ordDetailId: 5001, priceByPackage: false } });
    // Allocation edges: +15 counts, -3 (reversal) does not.
    await addOrder(prisma, { id: 700, context: 'MFBA', status: 'RLS' });
    await prisma.ordDetail.create({ data: { id: 7001, ordrId: 700, context: 'PK', itemId: 12, qtyReqd: 50, isOpen: true } });
    await addOrdDetailCommit(prisma, { ordDetailId: 5001, srcOrdDetailId: 7001, qty: 15 });
    await addOrdDetailCommit(prisma, { ordDetailId: 5001, srcOrdDetailId: 7001, qty: -3 });
    // A closed line must not appear.
    await prisma.ordDetail.create({
      data: { id: 5002, ordrId: 500, context: 'SH', itemId: 12, qtyReqd: 7, isOpen: false },
    });
  });

  it('open shipping order detail: balance, committed (positive edges only), uncommitted', async () => {
    const res = await svc().rows(userId, 'open-shipping-order-detail', {});
    expect(res.total).toBe(1);
    const row = res.rows[0] as Record<string, number>;
    expect(row.qty).toBe(100);
    expect(row.complete).toBe(40);
    expect(row.balance).toBe(60);
    expect(row.committed).toBe(25); // 10 own + 15 positive edge
    expect(row.uncommitted).toBe(35); // 100 - 40 - 25
    expect(row.value).toBeCloseTo(500, 6); // 100 × $5
    expect(row.balanceValue).toBeCloseTo(300, 6);
  });

  it('open MF order detail: UI lines sign-flip, PK lines positive; params filter', async () => {
    await prisma.ordDetail.create({
      data: { id: 7002, ordrId: 700, context: 'UI', itemId: 12, qtyReqd: 20, qtyUsed: 5, isOpen: true },
    });
    const res = await svc().rows(userId, 'open-mf-order-detail', { sort: 'ordDetail:asc' });
    expect(res.total).toBe(2);
    const [pk, ui] = res.rows as Array<Record<string, number | string>>;
    expect(pk.detail).toBe('PK');
    expect(pk.qty).toBe(50);
    expect(ui.detail).toBe('UI');
    expect(ui.qty).toBe(-20);
    expect(ui.balance).toBe(-15);
    const uiOnly = await svc().rows(userId, 'open-mf-order-detail', { p_detail: 'UI' });
    expect(uiOnly.total).toBe(1);
    const mfpkOnly = await svc().rows(userId, 'open-mf-order-detail', { p_context: 'MFPK' });
    expect(mfpkOnly.total).toBe(0);
  });
});

describe('inventory movement', () => {
  beforeEach(async () => {
    await addEntity(prisma, { id: 4, code: 'AREA' });
    await addItem(prisma, { id: 12, code: 'CTA1184' });
    await addChangeSet({ id: 910, context: 'PO', changeDate: '2026-06-01T09:00:00.000Z' });
    await addMovement({
      context: 'PO', changeSetId: 910, itemId: 12,
      legs: [{ context: 'MK', qty: 100, value: 200 }],
    });
    await addChangeSet({ id: 911, context: 'CMNGL', changeDate: '2026-06-02T09:00:00.000Z' });
    await addMovement({
      context: 'CMNGL', changeSetId: 911, itemId: 12,
      legs: [
        { context: 'US', qty: -30, value: -60 },
        { context: 'MKB', qty: 30 }, // WIP leg
      ],
    });
  });

  it("defaults to the legacy InventoryMovements stock filter; 'all' includes WIP legs", async () => {
    const stock = await svc().rows(userId, 'inventory-movement', {});
    expect(stock.total).toBe(2); // MK + US, no MKB
    expect((stock.rows as Array<{ detail: string }>).map((r) => r.detail).sort()).toEqual(['MK', 'US']);
    const all = await svc().rows(userId, 'inventory-movement', { p_legs: 'all' });
    expect(all.total).toBe(3);
    const wip = await svc().rows(userId, 'inventory-movement', { p_legs: 'wip' });
    expect(wip.total).toBe(1);
    const poOnly = await svc().rows(userId, 'inventory-movement', { p_movement: 'PO' });
    expect(poOnly.total).toBe(1);
    expect((poOnly.rows[0] as { movement: string }).movement).toBe('PO');
  });

  it('paginates stably (newest first by default)', async () => {
    const p1 = await svc().rows(userId, 'inventory-movement', { p_legs: 'all', pageSize: '2', page: '1' });
    const p2 = await svc().rows(userId, 'inventory-movement', { p_legs: 'all', pageSize: '2', page: '2' });
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows).toHaveLength(1);
    const ids = [...p1.rows, ...p2.rows].map((r) => (r as { id: number }).id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });
});

describe('inventory at date (reconstruction of GetInventoryAtDate)', () => {
  beforeEach(async () => {
    await addEntity(prisma, { id: 4, code: 'AREA' });
    await addItem(prisma, { id: 12, code: 'CTA1184' });
    await addItem(prisma, { id: 13, code: 'GONE' });
    // Item 12: +100 @ $200 (Jun 1), -30/-$60 (Jun 10), value-only +$10 MKCA (Jun 12),
    // and a +5 WIP MKB leg (Jun 5) that must NOT count.
    await addChangeSet({ id: 920, context: 'PO', changeDate: '2026-06-01T10:00:00.000Z' });
    await addMovement({ context: 'PO', changeSetId: 920, itemId: 12, legs: [{ context: 'MK', qty: 100, value: 200 }] });
    await addChangeSet({ id: 921, context: 'CMNGL', changeDate: '2026-06-05T10:00:00.000Z' });
    await addMovement({ context: 'CMNGL', changeSetId: 921, itemId: 12, legs: [{ context: 'MKB', qty: 5 }] });
    await addChangeSet({ id: 922, context: 'SH', changeDate: '2026-06-10T14:00:00.000Z' });
    await addMovement({ context: 'SH', changeSetId: 922, itemId: 12, legs: [{ context: 'US', qty: -30, value: -60 }] });
    await addChangeSet({ id: 923, context: 'CA', changeDate: '2026-06-12T10:00:00.000Z' });
    await addMovement({ context: 'CA', changeSetId: 923, itemId: 12, legs: [{ context: 'MKCA', value: 10 }] });
    // Item 13 nets to zero qty AND value by Jun 20 -> excluded then.
    await addChangeSet({ id: 924, context: 'PO', changeDate: '2026-06-03T10:00:00.000Z' });
    await addMovement({ context: 'PO', changeSetId: 924, itemId: 13, legs: [{ context: 'MK', qty: 5, value: 10 }] });
    await addChangeSet({ id: 925, context: 'SH', changeDate: '2026-06-18T10:00:00.000Z' });
    await addMovement({ context: 'SH', changeSetId: 925, itemId: 13, legs: [{ context: 'US', qty: -5, value: -10 }] });
  });

  it('sums non-WIP legs up to the asOf day inclusive', async () => {
    const jun9 = await svc().rows(userId, 'inventory-at-date', { p_asOf: '2026-06-09' });
    const r9 = (jun9.rows as Array<Record<string, unknown>>).find((r) => r.itemCode === 'CTA1184')!;
    expect(r9.qty).toBe(100);
    expect(r9.actualValue).toBe(200);

    // Jun 10 includes that day's 14:00 shipment.
    const jun10 = await svc().rows(userId, 'inventory-at-date', { p_asOf: '2026-06-10' });
    const r10 = (jun10.rows as Array<Record<string, unknown>>).find((r) => r.itemCode === 'CTA1184')!;
    expect(r10.qty).toBe(70);
    expect(r10.actualValue).toBe(140);

    // Value-only MKCA moves value, not qty.
    const jun12 = await svc().rows(userId, 'inventory-at-date', { p_asOf: '2026-06-12' });
    const r12 = (jun12.rows as Array<Record<string, unknown>>).find((r) => r.itemCode === 'CTA1184')!;
    expect(r12.qty).toBe(70);
    expect(r12.actualValue).toBe(150);
  });

  it('hides groups whose qty and value both net to zero', async () => {
    const jun5 = await svc().rows(userId, 'inventory-at-date', { p_asOf: '2026-06-05' });
    expect((jun5.rows as Array<Record<string, unknown>>).some((r) => r.itemCode === 'GONE')).toBe(true);
    const jun20 = await svc().rows(userId, 'inventory-at-date', { p_asOf: '2026-06-20' });
    expect((jun20.rows as Array<Record<string, unknown>>).some((r) => r.itemCode === 'GONE')).toBe(false);
  });
});

describe('purchase history', () => {
  it('supplier-facing qty/unit and per-stock-unit price (packaging conversion)', async () => {
    await addEntity(prisma, { id: 22, code: 'SUPPL', isSupplier: true });
    await addItem(prisma, { id: 12, code: 'RESIN', unit: 'lb' });
    await addItem(prisma, { id: 40, code: 'BAG' });
    await addOrder(prisma, { id: 600, context: 'PO', entityId: 22 });
    // Supplier sells 25-kg bags (55 lb each) at $2.20/kg: 110 lb = 50 kg.
    await prisma.ordDetail.create({
      data: { id: 6001, ordrId: 600, context: 'PO', itemId: 12, qtyReqd: 110, price: 2.2, isOpen: true, pkgTypeId: 40 },
    });
    await prisma.ordDetailPricing.create({
      data: { ordDetailId: 6001, priceByPackage: false, pkgTypeId: 40, entityQuantity: 25, entityUnit: 'kg', qtyPerEntityQty: 55 },
    });
    const res = await svc().rows(userId, 'purchase-history', {});
    expect(res.total).toBe(1);
    const row = res.rows[0] as Record<string, number | string>;
    expect(row.poQty).toBeCloseTo(50, 6);
    expect(row.poUnit).toBe('kg');
    expect(row.poPrice).toBeCloseTo(2.2, 6);
    expect(row.unitPrice).toBeCloseTo(1.0, 6); // 2.2 × 25 / 55
    expect(row.supplier).toBe('SUPPL');
    const closed = await svc().rows(userId, 'purchase-history', { p_open: 'closed' });
    expect(closed.total).toBe(0);
  });
});

describe('where used', () => {
  it('active recipes only, per-yield-unit quantity, ingredient filter', async () => {
    await addItem(prisma, { id: 30, code: 'BULK1' });
    await addItem(prisma, { id: 31, code: 'PIGMENT' });
    await prisma.recipe.create({ data: { id: 1, recipeNumber: 'R100', context: 'RMBA', isPublished: true } });
    await prisma.recipeDetail.create({ data: { id: 10, recipeId: 1, context: 'PK', itemId: 30, qtyReqd: 1, mustPreweigh: 0 } });
    await prisma.recipeDetail.create({ data: { id: 11, recipeId: 1, context: 'UI', itemId: 31, qtyReqd: 0.25, mustPreweigh: 0 } });
    // An inactive recipe and an inactive (revision-removed) line must not appear.
    await prisma.recipe.create({ data: { id: 2, recipeNumber: 'R200', context: 'RMBA', inactive: true } });
    await prisma.recipeDetail.create({ data: { id: 20, recipeId: 2, context: 'PK', itemId: 30, qtyReqd: 1, mustPreweigh: 0 } });
    await prisma.recipeDetail.create({ data: { id: 21, recipeId: 2, context: 'UI', itemId: 31, qtyReqd: 0.5, mustPreweigh: 0 } });
    await prisma.recipeDetail.create({ data: { id: 12, recipeId: 1, context: 'UI', itemId: 31, qtyReqd: 0.1, inactive: true, mustPreweigh: 0 } });

    const res = await svc().rows(userId, 'where-used', {});
    expect(res.total).toBe(1);
    const row = res.rows[0] as Record<string, number | string>;
    expect(row.recipeNumber).toBe('R100');
    expect(row.ingredientCode).toBe('PIGMENT');
    expect(row.itemCode).toBe('BULK1');
    expect(row.ingQty).toBeCloseTo(0.25, 9);

    const hit = await svc().rows(userId, 'where-used', { p_ingredient: 'pigm' });
    expect(hit.total).toBe(1);
    const miss = await svc().rows(userId, 'where-used', { p_ingredient: 'nickel' });
    expect(miss.total).toBe(0);
  });
});

describe('complete MF orders', () => {
  it('made qty, actual cost from movement legs, first sublot and packout bulk lineage', async () => {
    await addEntity(prisma, { id: 4, code: 'AREA' });
    await addItem(prisma, { id: 30, code: 'BULK1' });
    await addItem(prisma, { id: 32, code: 'PKGD1' });
    // Bulk order (complete): cost posts as a CA/MKBCA value leg.
    await addOrder(prisma, { id: 700, context: 'MFBA', status: 'CMP', ownerId: 4 });
    await prisma.ordDetail.create({ data: { id: 7001, ordrId: 700, context: 'PK', itemId: 30, qtyReqd: 400, qtyUsed: 387 } });
    await addLot(prisma, { lot: '260615001', itemId: 30, ordDetailId: 7001 });
    await addSublot(prisma, { id: 801, lot: '260615001' });
    await addChangeSet({ id: 950, context: 'CA', ordrId: 700, changeDate: '2026-06-15T18:00:00.000Z' });
    await addMovement({ context: 'CA', changeSetId: 950, itemId: null, legs: [{ context: 'MKBCA', value: 2492.61 }] });
    // Packout order consuming the bulk (UI <- MFBA PK commit edge).
    await addOrder(prisma, { id: 701, context: 'MFPP', status: 'CMP', ownerId: 4 });
    await prisma.ordDetail.create({ data: { id: 7011, ordrId: 701, context: 'PK', itemId: 32, qtyReqd: 100, qtyUsed: 96 } });
    await prisma.ordDetail.create({ data: { id: 7012, ordrId: 701, context: 'UI', itemId: 30, qtyReqd: 96 } });
    await addOrdDetailCommit(prisma, { ordDetailId: 7012, srcOrdDetailId: 7001, qty: 96 });
    await addChangeSet({ id: 951, context: 'PCKAGE', ordrId: 701, changeDate: '2026-06-16T09:00:00.000Z' });
    await addMovement({ context: 'PCKAGE', changeSetId: 951, itemId: 32, legs: [{ context: 'MK', qty: 96, value: 300 }] });
    // An open order must not appear.
    await addOrder(prisma, { id: 702, context: 'MFBA', status: 'RLS' });
    await prisma.ordDetail.create({ data: { id: 7021, ordrId: 702, context: 'PK', itemId: 30, qtyReqd: 10 } });

    const res = await svc().rows(userId, 'complete-mf-orders', { sort: 'ordr:asc' });
    expect(res.total).toBe(2);
    const [bulk, packout] = res.rows as Array<Record<string, number | string | null>>;
    expect(bulk.ordr).toBe(700);
    expect(bulk.qtyMade).toBe(387);
    expect(bulk.actualCost).toBeCloseTo(2492.61, 2);
    expect(bulk.unitActualCost).toBeCloseTo(2492.61 / 387, 4);
    expect(bulk.sublot).toBe('260615001');
    expect(bulk.bulkOrder).toBe(700);
    expect(bulk.bulkItem).toBe('BULK1');
    expect(packout.ordr).toBe(701);
    expect(packout.actualCost).toBeCloseTo(300, 2);
    expect(packout.bulkOrder).toBe(700); // via the commit edge
    expect(packout.bulkItem).toBe('BULK1');
    const mfppOnly = await svc().rows(userId, 'complete-mf-orders', { p_context: 'MFPP' });
    expect(mfppOnly.total).toBe(1);
  });
});

describe('batching orders', () => {
  it('lists MFBA orders with PK product and made qty; status filter', async () => {
    await addEntity(prisma, { id: 4, code: 'AREA' });
    await addItem(prisma, { id: 30, code: 'BULK1' });
    await addOrder(prisma, { id: 700, context: 'MFBA', status: 'CMP', ownerId: 4, actualBatchSize: 400 });
    await prisma.ordDetail.create({ data: { id: 7001, ordrId: 700, context: 'PK', itemId: 30, qtyReqd: 400, qtyUsed: 387 } });
    await addOrder(prisma, { id: 703, context: 'MFBA', status: 'RLS', ownerId: 4 });
    await prisma.ordDetail.create({ data: { id: 7031, ordrId: 703, context: 'PK', itemId: 30, qtyReqd: 100 } });
    // A packaging order is NOT a batching order.
    await addOrder(prisma, { id: 704, context: 'MFPK', status: 'RLS' });

    const all = await svc().rows(userId, 'batching-order', {});
    expect(all.total).toBe(2);
    const open = await svc().rows(userId, 'batching-order', { p_status: 'open' });
    expect(open.total).toBe(1);
    expect((open.rows[0] as { ordr: number }).ordr).toBe(703);
    const complete = await svc().rows(userId, 'batching-order', { p_status: 'complete' });
    expect((complete.rows[0] as { ordr: number; qtyMade: number }).qtyMade).toBe(387);
  });
});

describe('CSV export', () => {
  it('exports the full filtered set with typed formatting and the formula guard', async () => {
    await addEntity(prisma, { id: 4, code: 'AREA' });
    // An item code crafted to look like a spreadsheet formula.
    await prisma.item.create({ data: { id: 12, itemCode: '=SUM(A1)', unit: 'lb' } });
    await addChangeSet({ id: 910, context: 'PO', changeDate: '2026-06-01T09:00:00.000Z' });
    await addMovement({ context: 'PO', changeSetId: 910, itemId: 12, legs: [{ context: 'MK', qty: 100, value: 200 }] });
    // A float-noise qty that stringifies in e-notation: the numeric exemption
    // must NOT apostrophe-prefix it.
    await addChangeSet({ id: 911, context: 'COUNT', changeDate: '2026-06-02T09:00:00.000Z' });
    await addMovement({ context: 'COUNT', changeSetId: 911, itemId: 12, legs: [{ context: 'US', qty: -1.4210854715202004e-14 }] });

    const { fileName, content } = await svc().exportCsv(userId, 'inventory-movement', { sort: 'id:asc' });
    expect(fileName).toBe('inventory-movement.csv');
    const lines = content.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Item');
    expect(lines[1]).toContain(`'=SUM(A1)`); // guarded
    expect(lines[1]).toContain('200.00'); // money formatting
    expect(lines[1]).toContain('2026-06-01 09:00:00'); // plant wall-clock datetime
    // (Prisma's wire protocol may trim trailing float digits — assert the
    // e-notation shape, unprefixed.)
    expect(lines[2]).toMatch(/,-1\.42108547152\d*e-14,/);
    expect(lines[2]).not.toContain(`'-1.42`); // e-notation stays numeric
  });
});
