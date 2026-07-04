import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import {
  addEntity,
  addItem,
  addPriceDetail,
  addPriceVersion,
  makePrisma,
  resetDb,
  seedActor,
  services,
} from './support';

// §10 Planning — Create Purchase Order from selected plan lines (UG §14.2.1).
// Vendor rules: same Item + Required Manufacturer only, supplier pricing must
// exist for the combination, sublot-pinned requirements can never be
// purchased, multiple pricings -> the caller picks the supplier.

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

const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);

const ITEM = 11;
const OTHER_ITEM = 12;
const MFR = 51;

async function seedBase() {
  await addEntity(prisma, { id: 50, code: 'ACME', isSupplier: true });
  await addEntity(prisma, { id: 60, code: 'BULKCO', isSupplier: true });
  await addEntity(prisma, { id: MFR, code: 'MFRX', isManufacturer: true });
  await prisma.item.create({ data: { id: ITEM, itemCode: 'RESIN', unit: 'lb', supplierId: 50 } });
  await addItem(prisma, { id: OTHER_ITEM, code: 'SOLVENT' });

  // Plan lines (legacy-range ids; the button works on whichever plan is shown).
  await prisma.planTrace.createMany({
    data: [
      { id: 1, itemId: ITEM, reference: 'Short', quantity: 30, dateRequired: days(5), manufacturerId: null },
      { id: 2, itemId: ITEM, reference: 'Short', quantity: 20, dateRequired: days(2), manufacturerId: null },
      { id: 3, itemId: ITEM, reference: 'AVAIL', quantity: 5, dateRequired: days(2) },
      { id: 4, itemId: OTHER_ITEM, reference: 'Short', quantity: 9, dateRequired: days(3) },
      { id: 5, itemId: ITEM, reference: 'Short', quantity: 4, dateRequired: days(4), manufacturerId: MFR },
      { id: 6, itemId: ITEM, reference: 'Short', quantity: 2, dateRequired: days(4), reqdSublotId: 77 },
      { id: 7, itemId: ITEM, reference: 'Negative', quantity: 6, dateRequired: days(9), manufacturerId: null },
    ],
  });
}

describe('PlanningPoService.createPoFromPlan (UG §14.2.1)', () => {
  it('creates ONE PO from selected Short/Negative lines: summed qty, earliest date, tier price', async () => {
    await seedBase();
    // Only ACME prices RESIN (tier: 10 up to 49, 9 from 50 up).
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await addPriceDetail(prisma, { id: 1000, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10, minOrder2: 50, price2: 9 });

    const { planningPo } = services(prisma);
    const res = await planningPo.createPoFromPlan({ planTraceIds: [1, 2, 7] }, actor);
    expect(res.created).toBe(true);
    if (!res.created) throw new Error('unreachable');
    expect(res).toMatchObject({ supplierCode: 'ACME', itemCode: 'RESIN', quantity: 56, lines: 3 });

    const po = await prisma.ordr.findUnique({ where: { id: res.orderId } });
    expect(po).toMatchObject({ context: 'PO', status: 'NST', entityId: 50, reference: 'Plan Trace' });
    // Earliest of the selected lines (line 2's date; compare to the stored row,
    // not a recomputed now-relative value).
    const line2 = await prisma.planTrace.findUnique({ where: { id: 2 } });
    expect(po!.dateRequired).toEqual(line2!.dateRequired);
    const lines = await prisma.ordDetail.findMany({ where: { ordrId: res.orderId } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ itemId: ITEM, qtyReqd: 56, manufacturerId: null });
    expect(Number(lines[0].price)).toBe(9); // 56 crosses the 50-unit tier
  });

  it('asks which supplier when several price the item, preferred first; re-post with the choice', async () => {
    await seedBase();
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await addPriceDetail(prisma, { id: 1000, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10 });
    await addPriceVersion(prisma, { id: 101, entityId: 60, effectiveDate: days(-10) });
    await addPriceDetail(prisma, { id: 1001, priceVersionId: 101, itemId: ITEM, minOrder1: 1, price1: 8 });

    const { planningPo } = services(prisma);
    const ask = await planningPo.createPoFromPlan({ planTraceIds: [1, 2] }, actor);
    expect(ask.created).toBe(false);
    if (ask.created) throw new Error('unreachable');
    expect(ask.options.map((o) => [o.supplierCode, o.preferred, o.price])).toEqual([
      ['ACME', true, 10], // the item's preferred supplier ranks first
      ['BULKCO', false, 8],
    ]);
    expect(await prisma.ordr.count()).toBe(0); // nothing created yet

    const res = await planningPo.createPoFromPlan({ planTraceIds: [1, 2], supplierId: 60 }, actor);
    expect(res.created).toBe(true);
    if (!res.created) throw new Error('unreachable');
    expect(res.supplierCode).toBe('BULKCO');
    expect(Number((await prisma.ordDetail.findFirst({ where: { ordrId: res.orderId } }))!.price)).toBe(8);
  });

  it('manufacturer-pinned lines price from the manufacturer-specific detail, not the lowest-id one', async () => {
    await seedBase();
    // ACME prices RESIN generically; BULKCO's effective version carries BOTH a
    // generic detail (LOWER id, 10) and an MFRX-specific one (higher id, 7) —
    // the pinned line must be priced/packaged from the MFRX detail.
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await addPriceDetail(prisma, { id: 1000, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10 });
    await addPriceVersion(prisma, { id: 101, entityId: 60, effectiveDate: days(-10) });
    await addPriceDetail(prisma, { id: 1001, priceVersionId: 101, itemId: ITEM, minOrder1: 1, price1: 9 });
    await prisma.priceDetail.create({
      data: { id: 1002, priceVersionId: 101, itemId: ITEM, manufacturerId: MFR, minOrder1: 1, price1: 7 },
    });

    const { planningPo } = services(prisma);
    // Generic pricing also covers the pinned manufacturer -> both qualify; the
    // quoted prices are manufacturer-aware (BULKCO quotes its MFRX rate).
    const ask = await planningPo.createPoFromPlan({ planTraceIds: [5] }, actor);
    expect(ask.created).toBe(false);
    if (ask.created) throw new Error('unreachable');
    expect(ask.options.map((o) => [o.supplierCode, o.price])).toEqual([
      ['ACME', 10],
      ['BULKCO', 7],
    ]);

    const res = await planningPo.createPoFromPlan({ planTraceIds: [5], supplierId: 60 }, actor);
    expect(res.created).toBe(true);
    if (!res.created) throw new Error('unreachable');
    const line = await prisma.ordDetail.findFirst({ where: { ordrId: res.orderId } });
    expect(line).toMatchObject({ itemId: ITEM, qtyReqd: 4, manufacturerId: MFR });
    expect(Number(line!.price)).toBe(7); // the MFRX detail, despite the lower-id generic
  });

  it('unpinned lines price from the generic detail even when a manufacturer-specific one has a lower id', async () => {
    await seedBase();
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await prisma.priceDetail.create({
      data: { id: 1000, priceVersionId: 100, itemId: ITEM, manufacturerId: MFR, minOrder1: 1, price1: 5 },
    });
    await addPriceDetail(prisma, { id: 1001, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10 });

    const { planningPo } = services(prisma);
    const res = await planningPo.createPoFromPlan({ planTraceIds: [1, 2] }, actor);
    expect(res.created).toBe(true);
    if (!res.created) throw new Error('unreachable');
    // Not the MFRX-specific 5 — the unpinned demand takes the generic rate.
    expect(Number((await prisma.ordDetail.findFirst({ where: { ordrId: res.orderId } }))!.price)).toBe(10);
  });

  it('non-supplier entities that price the item (e.g. sales price lists) never qualify', async () => {
    await seedBase();
    await addEntity(prisma, { id: 70, code: 'RETAIL-LIST', isPriceList: true }); // NOT a supplier
    await addPriceVersion(prisma, { id: 102, entityId: 70, effectiveDate: days(-5) });
    await addPriceDetail(prisma, { id: 1010, priceVersionId: 102, itemId: ITEM, minOrder1: 1, price1: 99 });
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await addPriceDetail(prisma, { id: 1000, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10 });

    const { planningPo } = services(prisma);
    // ACME is the ONLY qualifying supplier -> auto-selected, no chooser, and
    // the price list never reaches purchasing.create.
    const res = await planningPo.createPoFromPlan({ planTraceIds: [1] }, actor);
    expect(res.created).toBe(true);
    if (!res.created) throw new Error('unreachable');
    expect(res.supplierCode).toBe('ACME');
  });

  it('rejects a plan line pinned to an entity that is not a manufacturer', async () => {
    await seedBase();
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await addPriceDetail(prisma, { id: 1000, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10 });
    // A Short row pinned to ACME (a supplier, NOT flagged manufacturer).
    await prisma.planTrace.create({
      data: { id: 8, itemId: ITEM, reference: 'Short', quantity: 3, dateRequired: days(4), manufacturerId: 50 },
    });
    const { planningPo } = services(prisma);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [8] }, actor)).rejects.toThrow(/not flagged as a manufacturer/);
    expect(await prisma.ordr.count()).toBe(0);
  });

  it('rejects mixed items, mixed manufacturers, non-short lines, sublot-pinned lines, and unpriced combos', async () => {
    await seedBase();
    await addPriceVersion(prisma, { id: 100, entityId: 50, effectiveDate: days(-30) });
    await addPriceDetail(prisma, { id: 1000, priceVersionId: 100, itemId: ITEM, minOrder1: 1, price1: 10 });
    const { planningPo } = services(prisma);

    await expect(planningPo.createPoFromPlan({ planTraceIds: [1, 4] }, actor)).rejects.toThrow(/same Item and Required Manufacturer/);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [1, 5] }, actor)).rejects.toThrow(/same Item and Required Manufacturer/);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [1, 3] }, actor)).rejects.toThrow(/only Short\/Negative/);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [6] }, actor)).rejects.toThrow(/specific sublot/);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [4] }, actor)).rejects.toThrow(/No supplier pricing/);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [1], supplierId: 60 }, actor)).rejects.toThrow(/no pricing for this item/);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [999] }, actor)).rejects.toThrow(/not found/);
    expect(await prisma.ordr.count()).toBe(0);
  });

  it('ignores pricing that only exists on a superseded (non-effective) price version', async () => {
    await seedBase();
    // BULKCO priced RESIN on an OLD version; its current version dropped it.
    await addPriceVersion(prisma, { id: 101, entityId: 60, effectiveDate: days(-100) });
    await addPriceDetail(prisma, { id: 1001, priceVersionId: 101, itemId: ITEM, minOrder1: 1, price1: 8 });
    await addPriceVersion(prisma, { id: 102, entityId: 60, effectiveDate: days(-1) });
    await addPriceDetail(prisma, { id: 1002, priceVersionId: 102, itemId: OTHER_ITEM, minOrder1: 1, price1: 3 });

    const { planningPo } = services(prisma);
    await expect(planningPo.createPoFromPlan({ planTraceIds: [1] }, actor)).rejects.toThrow(/No supplier pricing/);
  });
});
