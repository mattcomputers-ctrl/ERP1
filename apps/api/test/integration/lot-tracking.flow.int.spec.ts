import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addSublot,
  makePrisma,
  resetDb,
  seedActor,
  services,
  valuationService,
} from './support';

// Lot-tracking enablement (§3): capture opening on-hand by lot, wipe the
// item's prior (legacy / non-lot) inventory, switch the item to lot-traced —
// plus the parcel lock-order alignment: the wipe locks its parcels in the
// system-wide single ascending-id FOR UPDATE scan before deleting, so it
// cannot invert against a concurrent depleter.

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

async function legacyStockedItem(qty = 50) {
  await addItem(prisma, { id: 1, code: 'RESIN', lotTracked: false });
  await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  // Legacy-style on-hand: a parcel with a legacy lot, soon to be wiped.
  await addLot(prisma, { lot: 'OLDLOT', itemId: 1 });
  await addSublot(prisma, { id: 10, lot: 'OLDLOT' });
  const legacyParcelId = await addInventory(prisma, { itemId: 1, sublotId: 10, locationId: 1, qty });
  return legacyParcelId;
}

describe('LotTrackingService.enable', () => {
  it('wipes prior on-hand, mints raw lot numbers, keeps FG lot numbers, and flags the item', async () => {
    const legacyParcelId = await legacyStockedItem(50);
    await addEntity(prisma, { id: 200, code: 'SUP', isSupplier: true });
    const { lotTracking } = services(prisma);

    const res = await lotTracking.enable(
      1,
      {
        groups: [
          {
            locationId: 1,
            entries: [
              { vendorLot: 'V-77', supplierId: 200, qty: 30, unitCost: 2.5 }, // raw — ERP1 mints the number
              { lotNumber: 'FG-9', qty: 20 }, // finished good — kept as entered
            ],
          },
        ],
      },
      actor,
    );

    expect(res.lotTracked).toBe(true);
    expect((await prisma.item.findUnique({ where: { id: 1 } }))!.lotTracked).toBe(true);
    expect(await prisma.inventory.findUnique({ where: { id: legacyParcelId } })).toBeNull(); // prior stock wiped

    const raw = res.lots.find((l) => l.raw)!;
    expect(raw.vendorLot).toBe('V-77');
    expect(Number(raw.lot)).toBeGreaterThanOrEqual(100); // minted from the shared raw sequence
    const rawLot = await prisma.lot.findUnique({ where: { lot: raw.lot } });
    expect(rawLot!.supLot).toBe('V-77');
    expect(rawLot!.supplierId).toBe(200);
    expect(Number(rawLot!.unitCost)).toBeCloseTo(2.5, 10);

    const fg = res.lots.find((l) => !l.raw)!;
    expect(fg.lot).toBe('FG-9');

    // The opening parcels are the on-hand of record, at the entered location.
    const parcels = await prisma.inventory.findMany({ where: { itemId: 1 } });
    expect(parcels).toHaveLength(2);
    expect(parcels.every((p) => p.locationId === 1)).toBe(true);
    expect(parcels.reduce((s, p) => s + (p.qty ?? 0), 0)).toBe(50);
    expect(parcels.every((p) => p.id >= 1_000_000_000)).toBe(true); // native ids — re-import-safe
    expect(await prisma.auditLog.count({ where: { action: 'item.lottracking.enable' } })).toBe(1);
  });

  it('rejects an entry with both/neither lot forms and a lot owned by another item', async () => {
    await legacyStockedItem(10);
    await addItem(prisma, { id: 2, code: 'OTHER' });
    await addLot(prisma, { lot: 'THEIRS', itemId: 2 });
    const { lotTracking } = services(prisma);

    await expect(
      lotTracking.enable(1, { groups: [{ locationId: 1, entries: [{ qty: 5 }] }] }, actor),
    ).rejects.toThrow(/either a vendor lot .* or a lot number/i);
    await expect(
      lotTracking.enable(1, { groups: [{ locationId: 1, entries: [{ vendorLot: 'V', lotNumber: 'L', qty: 5 }] }] }, actor),
    ).rejects.toThrow(/not both/i);
    await expect(
      lotTracking.enable(1, { groups: [{ locationId: 1, entries: [{ lotNumber: 'THEIRS', qty: 5 }] }] }, actor),
    ).rejects.toThrow(/belongs to a different item/i);
    // Nothing wiped by the rejections.
    expect(await prisma.inventory.count({ where: { itemId: 1 } })).toBe(1);
    expect((await prisma.item.findUnique({ where: { id: 1 } }))!.lotTracked).toBe(false);
  });

  it('enabling races a FIFO depleter of the same item without deadlock, ending consistent', async () => {
    // The wipe locks the item's parcels in the same single ascending-id scan
    // depleteFifo uses, so the two serialize cleanly: either the depleter
    // drew from the legacy stock first (then the wipe replaced it — opening
    // 30 stands) or the wipe/create committed first (the depleter then drew
    // 10 from the fresh opening stock — 20 remains). Both are consistent;
    // a lock-order inversion would instead abort one side with 40P01.
    await legacyStockedItem(50);
    const { lotTracking } = services(prisma);
    const v = valuationService(prisma);

    const results = await Promise.allSettled([
      lotTracking.enable(1, { groups: [{ locationId: 1, entries: [{ vendorLot: 'V-1', qty: 30 }] }] }, actor),
      prisma.$transaction((tx) => v.depleteFifo(tx, 1, 10)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const total = (await prisma.inventory.findMany({ where: { itemId: 1 } })).reduce((s, p) => s + (p.qty ?? 0), 0);
    expect([20, 30]).toContain(total);
    expect((await prisma.item.findUnique({ where: { id: 1 } }))!.lotTracked).toBe(true);
  });
});
