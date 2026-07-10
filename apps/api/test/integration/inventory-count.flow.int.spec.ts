import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { InventoryCountService } from '../../src/inventory/inventory-count.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { MovementRecorderService } from '../../src/inventory/movement-recorder.service';
import { NotificationEngineService } from '../../src/notifications/notification-engine.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addEntity, addInventory, addItem, addLocation, addLot, addSublot, makePrisma, resetDb, seedActor,
} from './support';

// Flow integration test: inventory count sheets (L62) — create → enter → post,
// composing the shared per-parcel adjust core under ONE COUNT ChangeSet.

const NATIVE_BASE = 1_000_000_000;
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

function services() {
  const p = prisma as unknown as PrismaService;
  const audit = new AuditService(p);
  const movements = new MovementRecorderService();
  const inventory = new InventoryService(p, audit, movements, new NotificationEngineService(p));
  const counts = new InventoryCountService(p, audit, inventory, movements);
  return { counts, inventory };
}

// A location with two lot-traced parcels + one parcel at another location + one
// reserved parcel (all of the same item), so scoping/exclusion is exercised.
async function seedStock() {
  await addEntity(prisma, { id: 1, code: 'SITE' });
  const loc = await addLocation(prisma, { code: 'WHS', context: null });
  const other = await addLocation(prisma, { code: 'OTHER', context: null });
  await addItem(prisma, { id: 500, code: 'MAT', unit: 'lb' });
  await addLot(prisma, { lot: 'L1', itemId: 500, unitCost: 2 });
  await addLot(prisma, { lot: 'L2', itemId: 500, unitCost: 2 });
  await addLot(prisma, { lot: 'L3', itemId: 500, unitCost: 2 });
  const s1 = await addSublot(prisma, { id: 5001, lot: 'L1' });
  const s2 = await addSublot(prisma, { id: 5002, lot: 'L2' });
  const s3 = await addSublot(prisma, { id: 5003, lot: 'L3' });
  const p1 = await addInventory(prisma, { itemId: 500, sublotId: s1, locationId: loc, qty: 100 });
  const p2 = await addInventory(prisma, { itemId: 500, sublotId: s2, locationId: loc, qty: 40 });
  await addInventory(prisma, { itemId: 500, sublotId: s3, locationId: other, qty: 7 }); // other location
  // A reserved parcel at the counted location (ordDetailId set) — must be excluded.
  await prisma.ordr.create({ data: { id: 900, context: 'SH', status: 'NST' } });
  await prisma.ordDetail.create({ data: { id: 9001, ordrId: 900, context: 'SH', itemId: 500 } });
  const sr = await addSublot(prisma, { id: 5004, lot: 'L1' });
  await addInventory(prisma, { itemId: 500, sublotId: sr, locationId: loc, qty: 5, ordDetailId: 9001 });
  return { loc, p1, p2 };
}

describe('InventoryCountService', () => {
  it('snapshots the countable parcels at a location (excludes reserved + other locations)', async () => {
    const { counts } = services();
    const actor = await seedActor(prisma);
    const { loc } = await seedStock();

    const { id, parcels } = await counts.createCount({ locationId: loc }, actor);
    expect(id).toBeGreaterThanOrEqual(NATIVE_BASE);
    expect(parcels).toBe(2); // p1 + p2; reserved + other-location parcels excluded
    const got = await counts.get(id);
    expect(got.posted).toBe(false);
    expect(got.lines.map((l) => l.book).sort((a, b) => a - b)).toEqual([40, 100]);
    expect(got.lines.every((l) => l.counted === null)).toBe(true);
  });

  it('enters counts (draft), previews the adjust against live book, and rejects editing a posted count', async () => {
    const { counts } = services();
    const actor = await seedActor(prisma);
    const { loc, p1, p2 } = await seedStock();
    const { id } = await counts.createCount({ locationId: loc }, actor);
    const before = await counts.get(id);
    const line1 = before.lines.find((l) => l.inventoryId === p1)!;
    const line2 = before.lines.find((l) => l.inventoryId === p2)!;

    await counts.enterCounts(id, { counts: [{ detailId: line1.id, countedQty: 90 }, { detailId: line2.id, countedQty: 44 }] }, actor);
    const after = await counts.get(id);
    const a1 = after.lines.find((l) => l.id === line1.id)!;
    expect(a1.book).toBe(100);
    expect(a1.counted).toBe(90);
    expect(a1.adjust).toBe(-10); // counted − live book
    expect(after.lines.find((l) => l.id === line2.id)!.adjust).toBe(4);

    // A stray detail id is rejected.
    await expect(counts.enterCounts(id, { counts: [{ detailId: 999999, countedQty: 1 }] }, actor)).rejects.toThrow(/not part of this count/i);
  });

  it('posts every counted line under ONE COUNT change set, sets the parcels, stores the adjust, and links the header', async () => {
    const { counts } = services();
    const actor = await seedActor(prisma);
    const { loc, p1, p2 } = await seedStock();
    const { id } = await counts.createCount({ locationId: loc }, actor);
    const d = await counts.get(id);
    const l1 = d.lines.find((l) => l.inventoryId === p1)!;
    const l2 = d.lines.find((l) => l.inventoryId === p2)!;
    await counts.enterCounts(id, { counts: [{ detailId: l1.id, countedQty: 90 }, { detailId: l2.id, countedQty: 44 }] }, actor);

    const res = await counts.postCount(id, actor);
    expect(res.changeSetId).toBeGreaterThanOrEqual(NATIVE_BASE);
    expect(res.adjusted).toBe(2);

    // Parcels set to the counted quantities.
    expect((await prisma.inventory.findUnique({ where: { id: p1 } }))?.qty).toBe(90);
    expect((await prisma.inventory.findUnique({ where: { id: p2 } }))?.qty).toBe(44);
    // Header posted + linked; details carry the actual adjust.
    const header = await prisma.inventoryCount.findUnique({ where: { id } });
    expect(header?.posted).toBe(true);
    expect(header?.changeSetId).toBe(res.changeSetId);
    const posted = await counts.get(id);
    expect(posted.lines.find((l) => l.id === l1.id)!.adjust).toBe(-10);
    expect(posted.lines.find((l) => l.id === l1.id)!.book).toBe(100); // posted book = counted − adjust

    // Exactly ONE COUNT change set for this post, and both movement legs hang off it.
    expect(await prisma.changeSet.count({ where: { id: res.changeSetId, context: 'COUNT' } })).toBe(1);
    const moves = await prisma.invMovement.findMany({ where: { changeSetId: res.changeSetId }, select: { changeSetId: true } });
    expect(moves.length).toBe(2);
    expect(moves.every((m) => m.changeSetId === res.changeSetId)).toBe(true);

    // Re-posting is refused.
    await expect(counts.postCount(id, actor)).rejects.toThrow(/already posted/i);
  });

  it('applies the delta against the LIVE book (drift between entry and post)', async () => {
    const { counts, inventory } = services();
    const actor = await seedActor(prisma);
    const { loc, p1 } = await seedStock();
    const { id } = await counts.createCount({ locationId: loc, itemId: 500 }, actor);
    const line = (await counts.get(id)).lines.find((l) => l.inventoryId === p1)!;
    await counts.enterCounts(id, { counts: [{ detailId: line.id, countedQty: 90 }] }, actor);

    // Parcel drifts to 80 (a separate adjust) before the count is posted.
    await inventory.adjust({ inventoryId: p1, newQty: 80, reason: 'drift' }, actor);

    await counts.postCount(id, actor);
    expect((await prisma.inventory.findUnique({ where: { id: p1 } }))?.qty).toBe(90); // set to counted
    expect((await prisma.inventoryCountDetail.findFirst({ where: { inventoryCountId: id, inventoryId: p1 } }))?.qtyAdjust).toBe(10); // 90 − live 80
  });

  it('rejects posting with nothing counted, and deletes a draft (posted counts are immutable)', async () => {
    const { counts } = services();
    const actor = await seedActor(prisma);
    const { loc } = await seedStock();
    const { id } = await counts.createCount({ locationId: loc }, actor);

    await expect(counts.postCount(id, actor)).rejects.toThrow(/at least one counted/i);
    const del = await counts.deleteCount(id, actor);
    expect(del.deleted).toBe(true);
    expect(await prisma.inventoryCount.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.inventoryCountDetail.count({ where: { inventoryCountId: id } })).toBe(0);
  });

  it('a posted count refuses further edits/deletes, and shows uncounted lines as blank (not zero) book', async () => {
    const { counts } = services();
    const actor = await seedActor(prisma);
    const { loc, p1, p2 } = await seedStock();
    const { id } = await counts.createCount({ locationId: loc }, actor);
    const d = await counts.get(id);
    const l1 = d.lines.find((l) => l.inventoryId === p1)!;
    const l2 = d.lines.find((l) => l.inventoryId === p2)!;
    // Count only p1; leave p2 uncounted.
    await counts.enterCounts(id, { counts: [{ detailId: l1.id, countedQty: 90 }] }, actor);
    await counts.postCount(id, actor);

    await expect(counts.enterCounts(id, { counts: [{ detailId: l1.id, countedQty: 1 }] }, actor)).rejects.toThrow(/already posted/i);
    await expect(counts.deleteCount(id, actor)).rejects.toThrow(/cannot be deleted/i);

    const posted = await counts.get(id);
    const pl2 = posted.lines.find((l) => l.id === l2.id)!;
    expect(pl2.counted).toBeNull();
    expect(pl2.book).toBeNull(); // uncounted on a posted count → blank, not a false zero
    expect(pl2.adjust).toBeNull();
    // p2's on-hand was left untouched.
    expect((await prisma.inventory.findUnique({ where: { id: p2 } }))?.qty).toBe(40);
  });
});

describe('InventoryService.adjust SMP fence on no-op', () => {
  it('refuses a no-op adjust on a sample (SMP) parcel (behavior preserved through the refactor)', async () => {
    const { inventory } = services();
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 600, code: 'SAMP' });
    await addLot(prisma, { lot: 'SL', itemId: 600, unitCost: 1 });
    const sub = await addSublot(prisma, { id: 6001, lot: 'SL' });
    const smp = await addLocation(prisma, { code: 'E00001', context: 'SMP' });
    const parcel = await addInventory(prisma, { itemId: 600, sublotId: sub, locationId: smp, qty: 5 });
    // Same-qty (no-op) must still hit the SMP fence, not silently succeed.
    await expect(inventory.adjust({ inventoryId: parcel, newQty: 5, reason: 'x' }, actor)).rejects.toThrow(/sample parcels are managed/i);
  });
});
