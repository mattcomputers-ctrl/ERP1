import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addInventory, addItem, addLocation, addLot, addOrdDetail, addOrder, addSublot, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: native RECEIPT REVERSAL (§3). Reverse a posted purchase
// (PO) or miscellaneous (MISC) receipt while its stock is still untouched —
// removes the minted on-hand, writes a reversing ChangeSet (RVS+context, pointing
// back), and for a PO unwinds the OrdDetail.QtyUsed bump. Touched stock is refused.

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

const AT = new Date('2026-01-01T00:00:00Z');

async function setupMisc(qty = 50): Promise<{ actor: Actor; invId: number; csId: number }> {
  const actor = await seedActor(prisma);
  await addItem(prisma, { id: 1, code: 'WIDGET' });
  await addLot(prisma, { lot: '100', itemId: 1, supLot: 'MFR1' });
  const subId = await addSublot(prisma, { id: 10, lot: '100' });
  const locId = await addLocation(prisma, { code: 'WH1' });
  const invId = await addInventory(prisma, { itemId: 1, sublotId: subId, locationId: locId, qty });
  const csId = 500;
  await prisma.changeSet.create({ data: { id: csId, context: 'MISC', changeDate: AT } });
  await prisma.changeSetReceipt.create({ data: { changeSetId: csId, sublotId: subId, itemId: 1, psQty: qty } });
  return { actor, invId, csId };
}

describe('InventoryService.reverseReceipt', () => {
  it('reverses an untouched MISC receipt — removes on-hand, writes a back-pointing RVSMISC change set; re-reverse refused', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, csId } = await setupMisc(50);

    const res = (await inventory.reverseReceipt(csId, { reason: 'wrong item' }, actor)) as { reversedBy: number; removedQty: number; context: string };
    expect(res).toMatchObject({ changeSetId: csId, removedQty: 50, context: 'MISC' });
    expect(res.reversedBy).toBeGreaterThanOrEqual(1_000_000_000);
    expect(await prisma.inventory.findUnique({ where: { id: invId } })).toBeNull(); // on-hand removed
    const rev = (await prisma.changeSet.findUnique({ where: { id: res.reversedBy } }))!;
    expect(rev.context).toBe('RVSMISC');
    expect(rev.reverseChangeSetId).toBe(csId);
    expect(await prisma.auditLog.count({ where: { action: 'inventory.reverseReceipt' } })).toBe(1);

    await expect(inventory.reverseReceipt(csId, { reason: 'again' }, actor)).rejects.toThrow(/already been reversed/i);
  });

  it('reverses an untouched PO receipt — also unwinds the OrdDetail.QtyUsed bump', async () => {
    const { inventory } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'W' });
    await addLot(prisma, { lot: '100', itemId: 1 });
    const subId = await addSublot(prisma, { id: 10, lot: '100' });
    const locId = await addLocation(prisma, { code: 'WH1' });
    const invId = await addInventory(prisma, { itemId: 1, sublotId: subId, locationId: locId, qty: 20 });
    await addOrder(prisma, { id: 700, context: 'PO', status: 'NST' });
    const lineId = await addOrdDetail(prisma, { id: 710, ordrId: 700, context: 'PO', itemId: 1, qtyReqd: 100 });
    await prisma.ordDetail.update({ where: { id: lineId }, data: { qtyUsed: 20 } });
    const csId = 600;
    await prisma.changeSet.create({ data: { id: csId, context: 'PO', ordrId: 700, changeDate: AT } });
    await prisma.changeSetReceipt.create({ data: { changeSetId: csId, sublotId: subId, itemId: 1, psQty: 20, ordDetailId: lineId } });

    await inventory.reverseReceipt(csId, { reason: 'over-received' }, actor);
    expect(await prisma.inventory.findUnique({ where: { id: invId } })).toBeNull();
    expect((await prisma.ordDetail.findUnique({ where: { id: lineId } }))!.qtyUsed).toBe(0); // bump unwound
    expect((await prisma.changeSet.findFirst({ where: { reverseChangeSetId: csId } }))!.context).toBe('RVSPO');
  });

  it('refuses to reverse once the received stock has been touched (adjusted / split)', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, csId } = await setupMisc(50);
    await prisma.inventory.update({ where: { id: invId }, data: { qty: 40 } }); // consumed/adjusted
    await expect(inventory.reverseReceipt(csId, { reason: 'x' }, actor)).rejects.toThrow(/moved, split, consumed, or adjusted/i);
    // The change set was NOT reversed.
    expect(await prisma.changeSet.count({ where: { reverseChangeSetId: csId } })).toBe(0);

    // Splitting into a second parcel for the same sublot also blocks it.
    await prisma.inventory.update({ where: { id: invId }, data: { qty: 50 } });
    await addInventory(prisma, { itemId: 1, sublotId: 10, locationId: await addLocation(prisma, { code: 'WH2' }), qty: 5 });
    await expect(inventory.reverseReceipt(csId, { reason: 'x' }, actor)).rejects.toThrow(/moved, split, consumed, or adjusted/i);
  });

  it('two concurrent reversals of the same receipt enact exactly once (lock serializes the dup-check)', async () => {
    const { inventory } = services(prisma);
    const { actor, invId, csId } = await setupMisc(50);
    const results = await Promise.allSettled([
      inventory.reverseReceipt(csId, { reason: 'a' }, actor),
      inventory.reverseReceipt(csId, { reason: 'b' }, actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.changeSet.count({ where: { reverseChangeSetId: csId } })).toBe(1); // exactly one reversal
    expect(await prisma.inventory.findUnique({ where: { id: invId } })).toBeNull(); // removed once
  });

  it('reverses a receipt that minted no on-hand (no parcel) — nothing to remove', async () => {
    const { inventory } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'W' });
    await addLot(prisma, { lot: '100', itemId: 1 });
    await addSublot(prisma, { id: 10, lot: '100' });
    // No Inventory parcel (e.g. a location-less install where mintInventory no-ops).
    await prisma.changeSet.create({ data: { id: 500, context: 'MISC', changeDate: AT } });
    await prisma.changeSetReceipt.create({ data: { changeSetId: 500, sublotId: 10, itemId: 1, psQty: 50 } });

    const res = (await inventory.reverseReceipt(500, { reason: 'no stock' }, actor)) as { removedQty: number; context: string };
    expect(res).toMatchObject({ removedQty: 0, context: 'MISC' });
    expect((await prisma.changeSet.findFirst({ where: { reverseChangeSetId: 500 } }))!.context).toBe('RVSMISC');
  });

  it('rejects a blank reason, an unknown change set, a non-receipt, and a non-PO/MISC context', async () => {
    const { inventory } = services(prisma);
    const actor = await seedActor(prisma);
    await expect(inventory.reverseReceipt(999, { reason: '   ' }, actor)).rejects.toThrow(/reason is required/i);
    await expect(inventory.reverseReceipt(999, { reason: 'x' }, actor)).rejects.toThrow(/not found/i);
    // A PO change set with no ChangeSetReceipt → not a receipt.
    await prisma.changeSet.create({ data: { id: 800, context: 'PO', changeDate: AT } });
    await expect(inventory.reverseReceipt(800, { reason: 'x' }, actor)).rejects.toThrow(/not a receipt/i);
    // A shipment change set is not a receipt context.
    await prisma.changeSet.create({ data: { id: 801, context: 'SH', changeDate: AT } });
    await expect(inventory.reverseReceipt(801, { reason: 'x' }, actor)).rejects.toThrow(/purchase or miscellaneous/i);
  });
});
