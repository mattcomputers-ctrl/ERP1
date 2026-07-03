import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addInventory, addItem, addLocation, addLot, addSublot, makePrisma, onHandForLot, resetDb, seedActor, services, valuationService } from './support';

// Flow integration test: native inventory TRANSFER (§3 move). Moves a quantity of
// an on-hand parcel to another location — deducts the source, merges into / mints
// a destination parcel, records a ChangeSet Context='TRNSFR', audited. Total
// on-hand for the lot is conserved.

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

async function setup(qty: number) {
  const actor = await seedActor(prisma);
  await addItem(prisma, { id: 1, code: 'WIDGET' });
  await addLot(prisma, { lot: 'L1', itemId: 1 });
  const subId = await addSublot(prisma, { id: 10, lot: 'L1' });
  const fromLoc = await addLocation(prisma, { code: 'WH1' });
  const toLoc = await addLocation(prisma, { code: 'WH2' });
  const invId = await addInventory(prisma, { itemId: 1, sublotId: subId, locationId: fromLoc, qty });
  return { actor, invId, fromLoc, toLoc, subId };
}

describe('InventoryService.transfer', () => {
  it('moves part of a parcel to a new location, conserving total on-hand, with a TRNSFR change set', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, toLoc } = await setup(100);

    const res = (await inventory.transfer({ inventoryId: invId, toLocationId: toLoc, qty: 30 }, actor)) as { sourceRemaining: number; targetInventoryId: number; changeSetId: number };
    expect(res.sourceRemaining).toBe(70);
    expect(res.targetInventoryId).toBeGreaterThanOrEqual(1_000_000_000); // freshly minted
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(70);
    expect((await prisma.inventory.findUnique({ where: { id: res.targetInventoryId } }))!.qty).toBe(30);
    expect(await onHandForLot(prisma, 'L1')).toBe(100); // conserved
    expect((await prisma.changeSet.findUnique({ where: { id: res.changeSetId } }))!.context).toBe('TRNSFR');
    expect(await prisma.auditLog.count({ where: { action: 'inventory.transfer' } })).toBe(1);
  });

  it('merges into an existing same-item + same-lot parcel at the destination instead of minting', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, toLoc, subId } = await setup(100);
    // A pre-existing parcel of the same lot at the destination.
    const destId = await addInventory(prisma, { itemId: 1, sublotId: subId, locationId: toLoc, qty: 5 });

    const res = (await inventory.transfer({ inventoryId: invId, toLocationId: toLoc, qty: 20 }, actor)) as { targetInventoryId: number };
    expect(res.targetInventoryId).toBe(destId); // merged, not minted
    expect((await prisma.inventory.findUnique({ where: { id: destId } }))!.qty).toBe(25);
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(80);
    expect(await onHandForLot(prisma, 'L1')).toBe(105); // 100 + the pre-existing 5
  });

  it('does not merge into a destination parcel of a different status — mints a separate one', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, toLoc, subId } = await setup(100); // source status is null
    // A same-item + same-lot parcel at the destination, but ON HOLD.
    const holdId = (await prisma.inventory.create({ data: { itemId: 1, sublotId: subId, locationId: toLoc, qty: 5, status: 'HOLD' }, select: { id: true } })).id;

    const res = (await inventory.transfer({ inventoryId: invId, toLocationId: toLoc, qty: 20 }, actor)) as { targetInventoryId: number };
    expect(res.targetInventoryId).not.toBe(holdId); // didn't coalesce into the hold parcel
    expect(res.targetInventoryId).toBeGreaterThanOrEqual(1_000_000_000); // minted fresh
    expect((await prisma.inventory.findUnique({ where: { id: holdId } }))!.qty).toBe(5); // hold parcel untouched
    const minted = (await prisma.inventory.findUnique({ where: { id: res.targetInventoryId } }))!;
    expect(minted.status).toBeNull(); // carries the source's (null) status
    expect(minted.qty).toBe(20);
  });

  it('transfers a no-lot (null-sublot) parcel — merges by null sublot at the destination', async () => {
    const { inventory } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 2, code: 'BULK' });
    const fromLoc = await addLocation(prisma, { code: 'A' });
    const toLoc = await addLocation(prisma, { code: 'B' });
    const srcId = (await prisma.inventory.create({ data: { itemId: 2, sublotId: null, locationId: fromLoc, qty: 40 }, select: { id: true } })).id;
    const destId = (await prisma.inventory.create({ data: { itemId: 2, sublotId: null, locationId: toLoc, qty: 10 }, select: { id: true } })).id;

    const res = (await inventory.transfer({ inventoryId: srcId, toLocationId: toLoc, qty: 15 }, actor)) as { targetInventoryId: number };
    expect(res.targetInventoryId).toBe(destId); // matched the null-sublot destination parcel
    expect((await prisma.inventory.findUnique({ where: { id: destId } }))!.qty).toBe(25);
    expect((await prisma.inventory.findUnique({ where: { id: srcId } }))!.qty).toBe(25);
  });

  it('rejects moving more than on hand, a non-positive qty, and the same location', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, fromLoc, toLoc } = await setup(10);
    await expect(inventory.transfer({ inventoryId: invId, toLocationId: toLoc, qty: 11 }, actor)).rejects.toThrow(/only 10 on hand/i);
    await expect(inventory.transfer({ inventoryId: invId, toLocationId: toLoc, qty: 0 }, actor)).rejects.toThrow(/positive/i);
    await expect(inventory.transfer({ inventoryId: invId, toLocationId: fromLoc, qty: 5 }, actor)).rejects.toThrow(/different location/i);
    // Nothing moved.
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(10);
    expect(await prisma.changeSet.count()).toBe(0);
  });

  it('404s an unknown parcel and an unknown destination location', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, toLoc } = await setup(10);
    await expect(inventory.transfer({ inventoryId: 999999, toLocationId: toLoc, qty: 1 }, actor)).rejects.toThrow(/parcel not found/i);
    await expect(inventory.transfer({ inventoryId: invId, toLocationId: 888888, qty: 1 }, actor)).rejects.toThrow(/location not found/i);
  });

  it('a transfer racing a depletion of the same stock loses neither update (locked ascending scan)', async () => {
    // The transfer reads its quantities from the same single ascending-id
    // FOR UPDATE scan the depleters use — whatever the commit order, both
    // movements must land: 100 - 30 (moved, conserved) - 50 (depleted) and
    // the source ends at exactly 20 in EITHER interleaving. Before the fix
    // the transfer's unlocked read-modify-write could silently overwrite the
    // concurrent depletion (and its two-row lock order could deadlock
    // against an ascending scan).
    const { inventory } = services(prisma);
    const v = valuationService(prisma);
    const { actor, invId, toLoc } = await setup(100);

    const [, depletion] = await Promise.all([
      inventory.transfer({ inventoryId: invId, toLocationId: toLoc, qty: 30 }, actor),
      prisma.$transaction((tx) => v.depleteSpecific(tx, 'L1', 50)),
    ]);
    expect(depletion.depleted).toBe(50);
    expect(depletion.shortfall).toBe(0);
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(20);
    expect(await onHandForLot(prisma, 'L1')).toBe(50); // 100 - 50 depleted; the moved 30 conserved
  });
});
