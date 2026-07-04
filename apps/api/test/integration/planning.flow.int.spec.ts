import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LegacyImportService } from '../../src/import/legacy-import.service';
import type { LegacyDbService } from '../../src/import/legacy-db.service';
import { PlanningService } from '../../src/planning/planning.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addSublot,
  makePrisma,
  resetDb,
  services,
} from './support';

// §10 Planning slice 1: the mirrored PlanTrace (legacy nightly MRP output)
// behind the Plan Tracing / Short Inventory viewers, and the import engine's
// replaceStale semantics — the source rewrites the whole table with fresh ids
// every recalc, so re-copies must prune vanished rows (legacy-id range only).

const NATIVE = 1_000_000_000;
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

const D = (iso: string) => new Date(iso);
const DAY = 24 * 60 * 60 * 1000;
// UTC-digit midnight offset from today — the fixture must track the real
// clock (the expedite rule compares against today), never absolute dates.
const daysFromNow = (n: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + n * DAY);
};

async function seedPlanFixture() {
  await addEntity(prisma, { id: 50, code: 'ACME', isSupplier: true });
  await addEntity(prisma, { id: 51, code: 'MFRX' });
  await addEntity(prisma, { id: 52, code: 'MFRY' });
  await prisma.item.create({
    data: { id: 11, itemCode: 'RESIN', description: 'Acrylic resin', unit: 'lb', supplierId: 50 },
  });
  await addItem(prisma, { id: 12, code: 'SOLVENT', unit: 'lb' });
  // On-hand for RESIN: 30 across two parcels.
  await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  await addLot(prisma, { lot: 'R1', itemId: 11 });
  await addSublot(prisma, { id: 1, lot: 'R1' });
  await addInventory(prisma, { itemId: 11, sublotId: 1, locationId: 1, qty: 20 });
  await addLot(prisma, { lot: 'R2', itemId: 11 });
  await addSublot(prisma, { id: 2, lot: 'R2' });
  await addInventory(prisma, { itemId: 11, sublotId: 2, locationId: 1, qty: 10 });

  await prisma.planTrace.createMany({
    data: [
      // Covered from stock — not short; already available.
      { id: 1, itemId: 11, reference: 'AVAIL', quantity: 5, mfLevel: 1, dateRequired: daysFromNow(7), availableDate: daysFromNow(-2), dateUpdated: D('2026-07-03T05:00:00Z') },
      // Filled by a purchase order, late (+): available after required AND after today -> expedite.
      { id: 2, itemId: 11, reference: 'PO#900+', sourceOrdrId: 900, quantity: 40, mfLevel: 1, dateRequired: daysFromNow(2), availableDate: daysFromNow(29), dateUpdated: D('2026-07-03T05:00:00Z') },
      // Short requirements for RESIN — two rows, same required manufacturer.
      { id: 3, itemId: 11, manufacturerId: 51, reference: 'Short', quantity: 12, mfLevel: 2, dateRequired: daysFromNow(5), availableDate: daysFromNow(30), orderByDate: daysFromNow(-8), dateUpdated: D('2026-07-03T05:00:00Z') },
      { id: 4, itemId: 11, manufacturerId: 51, reference: 'Short', quantity: 8, mfLevel: 2, dateRequired: daysFromNow(17), availableDate: daysFromNow(38), orderByDate: daysFromNow(-2), dateUpdated: D('2026-07-03T05:00:00Z') },
      // Negative (min-stock refill) for SOLVENT, no manufacturer.
      { id: 5, itemId: 12, reference: 'Negative', quantity: 3, mfLevel: 1, dateRequired: daysFromNow(3), dateUpdated: D('2026-07-03T05:00:00Z') },
      // Expedite boundary: available AFTER required but NOT after today -> no flag.
      { id: 6, itemId: 12, reference: 'Hold', quantity: 2, mfLevel: 1, dateRequired: daysFromNow(-10), availableDate: daysFromNow(-1), dateUpdated: D('2026-07-03T05:00:00Z') },
      // A second required-manufacturer for RESIN -> its own short group.
      { id: 7, itemId: 11, manufacturerId: 52, reference: 'Short', quantity: 6, mfLevel: 2, dateRequired: daysFromNow(9), availableDate: daysFromNow(33), orderByDate: daysFromNow(1), dateUpdated: D('2026-07-03T05:00:00Z') },
    ],
  });
}

describe('PlanningService viewers', () => {
  it('trace lists decorated requirements with the expedite rule and filters', async () => {
    await seedPlanFixture();
    const planning = new PlanningService(prisma as unknown as PrismaService);

    const all = await planning.trace({});
    expect(all.total).toBe(7);
    expect(all.lastCalculated).toEqual(D('2026-07-03T05:00:00Z'));
    const avail = all.rows.find((r) => r.id === 1)!;
    expect(avail).toMatchObject({ itemCode: 'RESIN', unit: 'lb', reference: 'AVAIL', expedite: false });
    const po = all.rows.find((r) => r.id === 2)!;
    expect(po.expedite).toBe(true); // available after required AND after today
    // Boundary: available after required but NOT after today -> no expedite.
    expect(all.rows.find((r) => r.id === 6)!.expedite).toBe(false);

    // Reference prefix filter (PO# groups all purchase-order fills).
    const pos = await planning.trace({ reference: 'PO#' });
    expect(pos.total).toBe(1);
    expect(pos.rows[0].sourceOrdrId).toBe(900);

    // shortOnly covers Short AND Negative.
    const short = await planning.trace({ shortOnly: '1' });
    expect(short.total).toBe(4);

    // q searches by item code; whitespace-only q is a no-op, not match-all-of-500.
    const solvent = await planning.trace({ q: 'SOLV' });
    expect(solvent.total).toBe(2);
    expect(solvent.rows.every((r) => r.itemCode === 'SOLVENT')).toBe(true);
    expect((await planning.trace({ q: '   ' })).total).toBe(7);

    // An exact itemId INTERSECTS with q — it must never be silently dropped.
    expect((await planning.trace({ itemId: '12' })).total).toBe(2);
    expect((await planning.trace({ itemId: '12', q: 'SOLV' })).total).toBe(2);
    expect((await planning.trace({ itemId: '12', q: 'RESIN' })).total).toBe(0);
  });

  it('short groups by item+manufacturer with totals, SOH, dates, and supplier', async () => {
    await seedPlanFixture();
    const planning = new PlanningService(prisma as unknown as PrismaService);

    const { rows } = await planning.short();
    // Grouped by item + required manufacturer: RESIN splits across MFRX/MFRY.
    expect(rows).toHaveLength(3);

    const resinX = rows.find((r) => r.itemCode === 'RESIN' && r.requiredManufacturer === 'MFRX')!;
    expect(resinX).toMatchObject({
      quantity: 20, // 12 + 8
      onHand: 30, // both parcels
      unit: 'lb',
      supplierCode: 'ACME',
    });
    expect(resinX.dateRequired).toEqual(daysFromNow(5)); // earliest
    expect(resinX.availableDate).toEqual(daysFromNow(38)); // latest
    expect(resinX.orderByDate).toEqual(daysFromNow(-8)); // earliest

    const resinY = rows.find((r) => r.itemCode === 'RESIN' && r.requiredManufacturer === 'MFRY')!;
    expect(resinY).toMatchObject({ quantity: 6, onHand: 30 });

    const solvent = rows.find((r) => r.itemCode === 'SOLVENT')!;
    expect(solvent).toMatchObject({ requiredManufacturer: null, quantity: 3, onHand: 0 });
    // Sorted by earliest required date first.
    expect(rows[0].itemCode).toBe('SOLVENT');
  });
});

describe('import replaceStale (PlanTrace re-copy prunes vanished rows)', () => {
  function fakeLegacy(snapshot: () => Record<string, unknown>[]) {
    return {
      async open() {
        return {
          async maxLogId() { return 1; },
          async logDelta() { return []; },
          async tableColumns() { return []; },
          async fetchAll(legacyTable: string) {
            return legacyTable === 'dbo.PlanTrace' ? snapshot() : [];
          },
          async fetchByKeys() { return []; },
          async countRows(legacyTable: string) {
            return legacyTable === 'dbo.PlanTrace' ? snapshot().length : 0;
          },
          async close() {},
        };
      },
    } as unknown as LegacyDbService;
  }

  it('a re-imported nightly rewrite replaces the plan; native rows survive', async () => {
    let rows: Record<string, unknown>[] = [
      { PlanTrace: 101, Item: 11, Reference: 'Short', Quantity: 5 },
      { PlanTrace: 102, Item: 11, Reference: 'AVAIL', Quantity: 2 },
    ];
    await addItem(prisma, { id: 11, code: 'RESIN' });
    // A native plan row (the future ERP1 recalc engine's output) must never be
    // touched by import pruning.
    await prisma.planTrace.create({ data: { id: NATIVE + 1, itemId: 11, reference: 'Short', quantity: 9 } });

    const { genealogy } = services(prisma);
    const importer = new LegacyImportService(prisma as unknown as PrismaService, genealogy, fakeLegacy(() => rows));

    await importer.run('test', ['PlanTrace']);
    expect(await prisma.planTrace.count()).toBe(3); // 101, 102 + native

    // The nightly recalc rewrote the table: fresh ids, old rows gone.
    rows = [
      { PlanTrace: 201, Item: 11, Reference: 'Short', Quantity: 7 },
    ];
    await importer.run('test', ['PlanTrace']);

    const ids = (await prisma.planTrace.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((r) => Number(r.id));
    expect(ids).toEqual([201, NATIVE + 1]);
    expect((await prisma.planTrace.findUnique({ where: { id: 201 } }))!.quantity).toBe(7);
  });

  it('sync re-copies PlanTrace with a reported prune; an empty snapshot never wipes the mirror', async () => {
    let rows: Record<string, unknown>[] = [
      { PlanTrace: 101, Item: 11, Reference: 'Short', Quantity: 5 },
      { PlanTrace: 102, Item: 11, Reference: 'AVAIL', Quantity: 2 },
    ];
    await addItem(prisma, { id: 11, code: 'RESIN' });
    const { genealogy } = services(prisma);
    const importer = new LegacyImportService(prisma as unknown as PrismaService, genealogy, fakeLegacy(() => rows));
    await importer.run('test', ['PlanTrace']);
    // The watermark a real FULL import would have established.
    await prisma.appSetting.create({ data: { key: 'import.logWatermark', value: '0', description: 'test watermark' } });

    // Nightly recalc rewrote the source; the sync re-copy must prune AND say so.
    rows = [{ PlanTrace: 301, Item: 11, Reference: 'Short', Quantity: 4 }];
    const rep = await importer.sync('test');
    const recopy = (rep.tables as Array<{ name: string; upserted: number; deleted: number }>).find(
      (t) => t.name === 'PlanTrace (re-copy)',
    );
    expect(recopy).toMatchObject({ upserted: 1, deleted: 2 });
    expect((await prisma.planTrace.findMany()).map((r) => Number(r.id))).toEqual([301]);

    // A suspect EMPTY snapshot (e.g. the source caught mid-rewrite) must not
    // wipe the mirror — the prune is skipped and retried next sync.
    rows = [];
    await importer.sync('test');
    expect(await prisma.planTrace.count()).toBe(1);
  });
});
