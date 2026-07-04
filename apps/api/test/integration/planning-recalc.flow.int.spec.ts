import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import {
  addEntity,
  addInventory,
  addItem,
  addLot,
  addSublot,
  makePrisma,
  resetDb,
  seedActor,
  services,
} from './support';

// §10 Planning slice 2: the NATIVE Recalculate Plan Trace engine (UG §14.1).
// One deep fixture exercises every fill path: available stock (own + consigned
// + manufacturer-matched + pinned-sublot rejected), quarantined (Hold) and
// expired stock, open MF-order supply, open PO supply (late +), Short with
// requirement explosion through the ACTIVE costing recipe (stale pointer
// re-resolved), and min-stock demand losing the stock race to orders.
//
// Dates are CLOCK-RELATIVE (the engine compares against "today").

const NATIVE = 1_000_000_000;
const DAY = 86_400_000;
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

const today = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
const days = (n: number) => new Date(today().getTime() + n * DAY);

// Item ids
const FG = 100; // packaged product, costing recipe RMPP (stale pointer)
const BULK = 200; // bulk, costing recipe RMBA
const INGA = 300; // purchased ingredient: lead 10, testing 2
const INGB = 400; // purchased ingredient: min stock 100
const SOLO = 500; // manufacturer-restricted + pinned-sublot demands

async function seedWorld() {
  // Site + parties. Entity 4 is the site (single ST-context ItemEntity owner).
  await addEntity(prisma, { id: 4, code: 'PRECISION' });
  await addEntity(prisma, { id: 50, code: 'ACME', isSupplier: true });
  await addEntity(prisma, { id: 51, code: 'MFRX' });
  await addEntity(prisma, { id: 60, code: 'CONSIGNCO' });

  await prisma.item.create({ data: { id: FG, itemCode: 'E100-50', unit: 'lb', costingRecipeId: 9000 } });
  await prisma.item.create({ data: { id: BULK, itemCode: 'E100', unit: 'lb', costingRecipeId: 9100 } });
  await prisma.item.create({ data: { id: INGA, itemCode: 'INGA', unit: 'lb', supplierId: 50 } });
  await prisma.item.create({ data: { id: INGB, itemCode: 'INGB', unit: 'lb', supplierId: 50 } });
  await addItem(prisma, { id: SOLO, code: 'SOLO', unit: 'lb' });

  // Planning knobs live on ItemEntity ST rows (Item has no such columns in
  // this install). The MF-context row is manufacturer approval data and must
  // be IGNORED by planning.
  await prisma.itemEntity.createMany({
    data: [
      { id: 1, itemId: INGA, entityId: 4, context: 'ST', leadTime: 10, testingLeadTime: 2 },
      { id: 2, itemId: INGB, entityId: 4, context: 'ST', minimumStock: 100 },
      { id: 3, itemId: INGA, entityId: 51, context: 'MF', minimumStock: 999 },
    ],
  });

  // Recipes. FG's costing pointer aims at the OLD inactive revision — the
  // engine must re-resolve to the active sibling E100-50.02 (lead 5, bulk 1:1).
  await prisma.recipe.createMany({
    data: [
      { id: 9000, recipeNumber: 'E100-50', context: 'RMPP', isPublished: true, inactive: true },
      { id: 9002, recipeNumber: 'E100-50.02', context: 'RMPP', isPublished: true, inactive: false, leadTime: 5 },
      { id: 9100, recipeNumber: 'E100.03', context: 'RMBA', isPublished: true, inactive: false },
    ],
  });
  await prisma.recipeDetail.createMany({
    data: [
      { id: 91, recipeId: 9002, context: 'UI', itemId: BULK, qtyReqd: 1.0 },
      { id: 92, recipeId: 9002, context: 'PK', itemId: FG, qtyReqd: 1.0 }, // product line: not exploded
      { id: 93, recipeId: 9100, context: 'UI', itemId: INGA, qtyReqd: 0.5 },
      { id: 94, recipeId: 9100, context: 'UI', itemId: INGB, qtyReqd: 0.25 },
      { id: 95, recipeId: 9100, context: 'UI', itemId: null, qtyReqd: 1 }, // itemless line: skipped
      { id: 96, recipeId: 9100, context: 'INSTR', itemId: INGA, qtyReqd: 99 }, // not an ingredient
    ],
  });

  // Locations: WH is site-owned; CONS belongs to the consignment entity.
  await prisma.location.create({ data: { id: 1, locationCode: 'WH', ownerId: 4, context: 'WHS' } });
  await prisma.location.create({ data: { id: 2, locationCode: 'CONS', ownerId: 60, context: 'WHS' } });

  // Stock.
  await addLot(prisma, { lot: 'F1', itemId: FG });
  await addSublot(prisma, { id: 1, lot: 'F1' });
  await addInventory(prisma, { itemId: FG, sublotId: 1, locationId: 1, qty: 20 });
  // A retained QC sample of FG (SMP-context location): NOT nettable — it must
  // never appear in the plan or reduce the short.
  await prisma.location.create({ data: { id: 3, locationCode: 'SMP1', ownerId: 4, context: 'SMP' } });
  await addSublot(prisma, { id: 8, lot: 'F1' });
  await addInventory(prisma, { itemId: FG, sublotId: 8, locationId: 3, qty: 7 });

  await addLot(prisma, { lot: 'A1', itemId: INGA });
  await addSublot(prisma, { id: 2, lot: 'A1' });
  await addInventory(prisma, { itemId: INGA, sublotId: 2, locationId: 1, qty: 10 });
  await addLot(prisma, { lot: 'A2', itemId: INGA });
  await addSublot(prisma, { id: 3, lot: 'A2' });
  await addInventory(prisma, { itemId: INGA, sublotId: 3, locationId: 1, qty: 5 });
  await prisma.release.create({ data: { id: 1, sublotId: 3, status: 'Hold' } }); // quarantined

  await addLot(prisma, { lot: 'B1', itemId: INGB });
  await addSublot(prisma, { id: 4, lot: 'B1' });
  await addInventory(prisma, { itemId: INGB, sublotId: 4, locationId: 1, qty: 30 });
  await prisma.release.create({ data: { id: 2, sublotId: 4, status: 'Approved', expiryDate: days(-3) } }); // expired
  await addLot(prisma, { lot: 'B2', itemId: INGB });
  await addSublot(prisma, { id: 5, lot: 'B2' });
  await addInventory(prisma, { itemId: INGB, sublotId: 5, locationId: 2, qty: 15 }); // consigned

  await prisma.lot.create({ data: { lot: 'S1', context: 'LOT', itemId: SOLO } }); // no manufacturer
  await addSublot(prisma, { id: 6, lot: 'S1' });
  await addInventory(prisma, { itemId: SOLO, sublotId: 6, locationId: 1, qty: 50 });
  await prisma.release.create({ data: { id: 3, sublotId: 6, status: 'Rejected' } });
  await prisma.lot.create({ data: { lot: 'S2', context: 'LOT', itemId: SOLO, manufacturerId: 51 } });
  await addSublot(prisma, { id: 7, lot: 'S2' });
  await addInventory(prisma, { itemId: SOLO, sublotId: 7, locationId: 1, qty: 5 });

  // Demand: an SH order for 60 FG (10 already shipped -> 50 remaining).
  await prisma.ordr.create({
    data: { id: 1000, context: 'SH', status: 'RTS', placedBy: 'sales.user', dateReleased: days(-1), dateRequired: days(10) },
  });
  await prisma.ordDetail.create({
    data: { id: 10001, ordrId: 1000, context: 'SH', itemId: FG, qtyReqd: 60, qtyUsed: 10, dateUpdated: days(-1) },
  });

  // Supply + demand: an open MFPP order packing 12 FG (2 done -> 10 supply,
  // arrival = its required date, T+3) and consuming 12 BULK (open demand).
  await prisma.ordr.create({
    data: { id: 2000, context: 'MFPP', status: 'NST', placedBy: 'ops.user', dateRequired: days(3) },
  });
  await prisma.ordDetail.createMany({
    data: [
      { id: 20001, ordrId: 2000, context: 'PK', itemId: FG, qtyReqd: 12, qtyUsed: 2 },
      { id: 20002, ordrId: 2000, context: 'UI', itemId: BULK, qtyReqd: 12 },
    ],
  });

  // Supply: an open PO for 8 INGA promised yesterday (late -> +).
  await prisma.ordr.create({ data: { id: 3000, context: 'PO', entityId: 50, dateOrdered: days(-5) } });
  await prisma.ordDetail.create({
    data: { id: 30001, ordrId: 3000, context: 'PO', itemId: INGA, qtyReqd: 8, datePromised: days(-1) },
  });

  // Demands on SOLO: one restricted to manufacturer MFRX, one pinned to the
  // REJECTED sublot 6 (pinned demands may consume rejected stock).
  await prisma.ordr.create({
    data: { id: 4000, context: 'MFBA', status: 'RLS', placedBy: 'batch.user', dateReleased: days(-2), dateRequired: days(2) },
  });
  await prisma.ordDetail.createMany({
    data: [
      { id: 40001, ordrId: 4000, context: 'UI', itemId: SOLO, qtyReqd: 20, manufacturerId: 51 },
      { id: 40003, ordrId: 4000, context: 'UI', itemId: SOLO, qtyReqd: 10, sublotId: 6 },
    ],
  });

  // Noise that must all be ignored: a completed order, a quote, a discarded
  // line, and a fully-consumed line.
  await prisma.ordr.create({ data: { id: 5000, context: 'SH', status: 'CMP', dateCompleted: days(-1), dateRequired: days(1) } });
  await prisma.ordDetail.create({ data: { id: 50001, ordrId: 5000, context: 'SH', itemId: FG, qtyReqd: 99 } });
  await prisma.ordr.create({ data: { id: 5001, context: 'SH', status: 'NST', isQuote: true, dateRequired: days(1) } });
  await prisma.ordDetail.create({ data: { id: 50011, ordrId: 5001, context: 'SH', itemId: FG, qtyReqd: 77 } });
  await prisma.ordDetail.create({ data: { id: 50002, ordrId: 1000, context: 'SH', itemId: FG, qtyReqd: 33, discarded: true } });
  await prisma.ordDetail.create({ data: { id: 50003, ordrId: 1000, context: 'SH', itemId: BULK, qtyReqd: 5, qtyUsed: 5 } });

  // A legacy plan row: never touched by the native engine, only visible with
  // source=legacy.
  await prisma.planTrace.create({ data: { id: 700, itemId: FG, reference: 'AVAIL', quantity: 1, dateUpdated: days(-1) } });
}

describe('PlanningRecalcService (native Recalculate Plan Trace)', () => {
  it('rebuilds the plan through every fill path and switches the viewers to it', async () => {
    await seedWorld();
    const { planningRecalc, planning } = services(prisma);

    const summary = await planningRecalc.recalculate(actor);
    expect(summary.source).toBe('native');
    expect(summary.demands).toBe(4); // SH FG + MFPP UI BULK + two SOLO lines
    expect(summary.minStockDemands).toBe(1); // INGB

    const native = await prisma.planTrace.findMany({ where: { id: { gte: NATIVE } }, orderBy: { id: 'asc' } });
    expect(native.length).toBe(summary.rows);
    // The legacy row survives, and viewers now default to the native plan.
    expect(await prisma.planTrace.findUnique({ where: { id: 700 } })).not.toBeNull();
    expect((await prisma.appSetting.findUnique({ where: { key: 'planning.source' } }))?.value).toBe('native');

    const rowsFor = (itemId: number) => native.filter((r) => r.itemId === itemId);

    // FG (50 remaining): 20 from WAREHOUSE stock (the 7 lb of retained QC
    // samples at the SMP location are not nettable and never appear), 10 from
    // the open MFPP order (on time, no +), 20 Short planned from the ACTIVE
    // recipe revision (lead 5).
    const fg = rowsFor(FG);
    expect(fg.map((r) => [r.reference, r.quantity])).toEqual([
      ['AVAIL', 20],
      ['MF#2000', 10],
      ['Short', 20],
    ]);
    expect(fg.some((r) => r.sublotId === 8)).toBe(false); // the retain sample
    expect(fg[0]).toMatchObject({ user: 'sales.user', ordrId: 1000, ordDetailId: 10001, context: 'SH', sublotId: 1 });
    expect(fg[0].availableDate).toEqual(today());
    expect(fg[1]).toMatchObject({ sourceOrdrId: 2000, mfOrdrId: 2000 });
    expect(fg[1].arrivalDate).toEqual(days(3));
    expect(fg[1].availableDate).toEqual(days(3));
    // Short: the STALE costing pointer (9000) resolved to the active sibling
    // 9002 -> lead 5; orderBy = required - lead, available = today + lead.
    expect(fg[2].leadTime).toBe(5);
    expect(fg[2].orderByDate).toEqual(days(5));
    expect(fg[2].availableDate).toEqual(days(5));

    // BULK: two demands (12 direct from the MFPP order at T+3, then 20
    // exploded from FG's Short at T+10-5). No stock/supply -> both Short.
    const bulk = rowsFor(BULK);
    expect(bulk.map((r) => [r.reference, r.quantity, r.user])).toEqual([
      ['Short', 12, 'ops.user'],
      ['Short', 20, 'RawMaterial'],
    ]);
    expect(bulk[0]).toMatchObject({ ordrId: 2000, context: 'MFPP', mfgItemId: null });
    expect(bulk[1]).toMatchObject({ ordrId: 1000, ordDetailId: 10001, context: 'SH', mfgItemId: FG });
    expect(bulk[1].dateRequired).toEqual(days(5)); // FG required T+10 minus recipe lead 5
    expect(bulk.every((r) => r.mfLevel === 1)).toBe(true);

    // INGA: 16 exploded (6 from BULK#12, 10 from BULK#20): 10 available, 5 on
    // Hold (assumed approved; Retest; available after the 2-day testing lead),
    // 1 from the late PO (+). No Short.
    const inga = rowsFor(INGA);
    expect(inga.map((r) => [r.reference, r.quantity])).toEqual([
      ['AVAIL', 6],
      ['AVAIL', 4],
      ['Hold', 5],
      ['PO#3000+', 1],
    ]);
    expect(inga.every((r) => r.user === 'RawMaterial' && r.mfgItemId === BULK && r.mfLevel === 2)).toBe(true);
    expect(inga[2]).toMatchObject({ planTraceStatus: 'Retest', sublotId: 3, testingLeadTime: 2, leadTime: 10 });
    expect(inga[2].availableDate).toEqual(days(2)); // today + testing lead
    expect(inga[3].arrivalDate).toEqual(days(-1)); // promised yesterday -> late
    expect(inga[3].promisedDate).toEqual(days(-1));
    expect(inga[3].availableDate).toEqual(days(2)); // max(today, arrival) + testing
    expect(inga[3].sourceOrdrId).toBe(3000);
    expect(inga[3].mfOrdrId).toBeNull();

    // INGB: order explosions (3 + 5) eat expired stock FIRST; the min-stock
    // demand (100) gets the leftovers (22 expired + 15 consigned) and shorts
    // the remaining 63 — orders beat min-stock to the stock.
    const ingb = rowsFor(INGB);
    expect(ingb.map((r) => [r.reference, r.quantity, r.user])).toEqual([
      ['Expired', 3, 'RawMaterial'],
      ['Expired', 5, 'RawMaterial'],
      ['Expired', 22, 'MinStock'],
      ['CONSIGNCO', 15, 'MinStock'],
      ['Short', 63, 'MinStock'],
    ]);
    expect(ingb[0].planTraceStatus).toBe('Retest');
    const minShort = ingb[4];
    expect(minShort.dateRequired).toEqual(today());
    expect(minShort.ordrId).toBeNull();
    expect(minShort.context).toBeNull();
    expect(minShort.leadTime).toBe(3650); // no lead configured -> vendor fallback

    // SOLO: the manufacturer-restricted demand can use ONLY the MFRX lot
    // (5 of 20; rejected stock is out of reach), shorts the rest carrying the
    // required manufacturer; the pinned-sublot demand consumes the REJECTED
    // sublot it names.
    const solo = rowsFor(SOLO);
    expect(solo.map((r) => [r.reference, r.quantity])).toEqual([
      ['AVAIL', 5],
      ['Short', 15],
      ['Rejected', 10],
    ]);
    expect(solo[0]).toMatchObject({ sublotId: 7, manufacturerId: 51 });
    expect(solo[1].manufacturerId).toBe(51);
    expect(solo[2]).toMatchObject({ sublotId: 6, reqdSublotId: 6, user: 'batch.user' });

    // Viewers: default source is now native; legacy remains reachable. The
    // native "last recalculated" stamp is the RECALC time, not the newest
    // order-line dateUpdated the rows carry.
    const trace = await planning.trace({});
    expect(trace.source).toBe('native');
    expect(trace.total).toBe(native.length);
    expect(trace.lastCalculated).toEqual(summary.lastCalculated);
    const legacyTrace = await planning.trace({ source: 'legacy' });
    expect(legacyTrace.total).toBe(1);
    expect(legacyTrace.rows[0].id).toBe(700);

    const short = await planning.short();
    expect(short.source).toBe('native');
    const shortByItem = new Map(short.rows.map((r) => [r.itemId, r]));
    expect(shortByItem.get(FG)?.quantity).toBe(20);
    expect(shortByItem.get(BULK)?.quantity).toBe(32);
    expect(shortByItem.get(INGB)?.quantity).toBe(63);
    expect(shortByItem.get(SOLO)?.quantity).toBe(15);
    expect(short.rows.find((r) => r.itemId === SOLO)?.requiredManufacturer).toBe('MFRX');

    // The audit trail records the recalc.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'planning.recalculate' } });
    expect(audit).not.toBeNull();
  });

  it('is idempotent: a second run replaces the native plan in place', async () => {
    await seedWorld();
    const { planningRecalc } = services(prisma);

    const first = await planningRecalc.recalculate(actor);
    const idsFirst = (
      await prisma.planTrace.findMany({ where: { id: { gte: NATIVE } }, select: { id: true }, orderBy: { id: 'asc' } })
    ).map((r) => Number(r.id));
    const second = await planningRecalc.recalculate(actor);
    const idsSecond = (
      await prisma.planTrace.findMany({ where: { id: { gte: NATIVE } }, select: { id: true }, orderBy: { id: 'asc' } })
    ).map((r) => Number(r.id));

    expect(second.rows).toBe(first.rows);
    expect(idsSecond).toEqual(idsFirst); // fresh ids from the same base — no drift, no leftovers
    expect(await prisma.planTrace.count({ where: { id: { lt: NATIVE } } })).toBe(1); // legacy row untouched
  });

  it('handles an empty world: no demands -> an empty native plan, source still flips', async () => {
    await addEntity(prisma, { id: 4, code: 'PRECISION' });
    const { planningRecalc, planning } = services(prisma);
    const summary = await planningRecalc.recalculate(actor);
    expect(summary.rows).toBe(0);
    const trace = await planning.trace({});
    expect(trace.source).toBe('native');
    expect(trace.total).toBe(0);
  });
});
