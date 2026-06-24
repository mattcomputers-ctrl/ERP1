import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addInventory, addItem, addLocation, addLot, addSublot, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: native inventory ADJUSTMENT (§3 adjust / count). Sets an
// on-hand parcel to a counted quantity (write-on / write-off), records a legacy
// ChangeSet Context='COUNT' header + the Inventory.qty change, and audits it.

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

async function setupParcel(qty: number): Promise<{ actor: Actor; invId: number }> {
  const actor = await seedActor(prisma);
  await addItem(prisma, { id: 1, code: 'WIDGET' });
  await addLot(prisma, { lot: 'L1', itemId: 1 });
  const subId = await addSublot(prisma, { id: 10, lot: 'L1' });
  const locId = await addLocation(prisma, { code: 'WH1' });
  const invId = await addInventory(prisma, { itemId: 1, sublotId: subId, locationId: locId, qty });
  return { actor, invId };
}

describe('InventoryService.adjust', () => {
  it('adjusts a parcel down to a counted qty, records a COUNT change set, and audits it', async () => {
    const { inventory } = services(prisma);
    const { actor, invId } = await setupParcel(100);

    const res = (await inventory.adjust({ inventoryId: invId, newQty: 92, reason: 'cycle count' }, actor)) as { changeSetId: number; oldQty: number; newQty: number; delta: number };
    expect(res).toMatchObject({ inventoryId: invId, oldQty: 100, newQty: 92, delta: -8 });
    expect(res.changeSetId).toBeGreaterThanOrEqual(1_000_000_000); // native id range
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(92);
    const cs = (await prisma.changeSet.findUnique({ where: { id: res.changeSetId } }))!;
    expect(cs.context).toBe('COUNT');
    expect(await prisma.auditLog.count({ where: { action: 'inventory.adjust' } })).toBe(1);
  });

  it('write-on (found stock) increases the parcel', async () => {
    const { inventory } = services(prisma);
    const { actor, invId } = await setupParcel(50);
    const res = (await inventory.adjust({ inventoryId: invId, newQty: 75, reason: 'found stock' }, actor)) as { delta: number };
    expect(res.delta).toBe(25);
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(75);
  });

  it('rejects a negative quantity and a blank reason', async () => {
    const { inventory } = services(prisma);
    const { actor, invId } = await setupParcel(10);
    await expect(inventory.adjust({ inventoryId: invId, newQty: -1, reason: 'x' }, actor)).rejects.toThrow(/negative/i);
    await expect(inventory.adjust({ inventoryId: invId, newQty: 5, reason: '   ' }, actor)).rejects.toThrow(/reason is required/i);
    // Neither bad call mutated the parcel or wrote a change set / audit row.
    expect((await prisma.inventory.findUnique({ where: { id: invId } }))!.qty).toBe(10);
    expect(await prisma.changeSet.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'inventory.adjust' } })).toBe(0);
  });

  it('a no-op (same qty) makes no change set and no audit row', async () => {
    const { inventory } = services(prisma);
    const { actor, invId } = await setupParcel(100);
    const res = (await inventory.adjust({ inventoryId: invId, newQty: 100, reason: 'recount, no change' }, actor)) as { unchanged?: boolean };
    expect(res.unchanged).toBe(true);
    expect(await prisma.changeSet.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'inventory.adjust' } })).toBe(0);
  });

  it('404s an unknown parcel', async () => {
    const { inventory } = services(prisma);
    const actor = await seedActor(prisma);
    await expect(inventory.adjust({ inventoryId: 999999, newQty: 1, reason: 'x' }, actor)).rejects.toThrow(/not found/i);
  });
});
