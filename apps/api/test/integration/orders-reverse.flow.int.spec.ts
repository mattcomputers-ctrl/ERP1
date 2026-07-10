import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addConsumptionEdge, addInventory, addItem, addLocation, addLot, addOrdDetail, addOrder, addShipmentLot, addSublot, grantAllSecuredItems, makePrisma, onHandForLot, resetDb, seedActor, services } from './support';

// Order reversal (§5): un-complete a batch ERP1 completed — produced on-hand
// un-minted (identity Lot/Sublot kept), consumed materials restored from the
// consumption edge set, procedure lines reset (QtyUsed NULL / ExecStatus NST,
// the legacy full-reversal shape), order back to RLS under a reversing RVSMFP
// change set effective-dated to the completion. Guarded by the vendor's 7.17
// rule: refused unless the produced stock is exactly as minted.

const D = (iso: string) => new Date(iso);
const NATIVE = 1_000_000_000;
const ORDER = NATIVE + 800; // reversal is native-order-only — use a native id
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

/**
 * A Released NATIVE MFBA order shaped like the execution suite's fixture: PK
 * product line (+ produced lot of record), a lot-traced UI line, a FIFO UI
 * line, and an instruction. Raw stock: traced lot 'RT' (cost 5/unit, 100 on
 * hand), FIFO lots OLD/NEW (6 + 6). Both order secured items are seeded
 * ENABLED but signature-relaxed so the flows run without password re-auth.
 */
async function releasedNativeBatch() {
  await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  await addItem(prisma, { id: 1, code: 'PROD' });
  await addItem(prisma, { id: 2, code: 'TRACED', lotTracked: true });
  await addItem(prisma, { id: 3, code: 'BULK', lotTracked: false, purchasePrice: 4 });
  await addOrder(prisma, { id: ORDER, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
  await addOrdDetail(prisma, { id: 900, ordrId: ORDER, context: 'PK', itemId: 1, qtyReqd: 100 });
  await addOrdDetail(prisma, { id: 901, ordrId: ORDER, context: 'UI', itemId: 2, qtyReqd: 10 });
  await addOrdDetail(prisma, { id: 902, ordrId: ORDER, context: 'UI', itemId: 3, qtyReqd: 8 });
  await addOrdDetail(prisma, { id: 903, ordrId: ORDER, context: 'INSTR', description: 'Mix 10 minutes' });
  await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: 900 });
  await addLot(prisma, { lot: 'RT', itemId: 2, unitCost: 5 });
  await addSublot(prisma, { id: 1, lot: 'RT' });
  await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 100 });
  await addLot(prisma, { lot: 'NEW', itemId: 3, unitCost: 9, receivedDate: D('2020-06-01') });
  await addLot(prisma, { lot: 'OLD', itemId: 3, unitCost: 3, receivedDate: D('2020-01-01') });
  await addSublot(prisma, { id: 2, lot: 'NEW' });
  await addSublot(prisma, { id: 3, lot: 'OLD' });
  await addInventory(prisma, { itemId: 3, sublotId: 2, locationId: 1, qty: 6 });
  await addInventory(prisma, { itemId: 3, sublotId: 3, locationId: 1, qty: 6 });
  for (const key of ['order.complete', 'order.reverse']) {
    await prisma.securedItem.create({
      data: { key, description: key, requireReason: true, requireSignature: false, requireWitness: false },
    });
  }
  await grantAllSecuredItems(prisma, actor.id);
}

/** Execute the fixture order (traced + FIFO + instruction) and complete it. */
async function executedAndCompleted() {
  const { orders } = services(prisma);
  await orders.recordLine(ORDER, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
  await orders.recordLine(ORDER, 902, { actualQty: 8 }, actor); // FIFO: OLD 6 + NEW 2
  await orders.recordLine(ORDER, 903, {}, actor); // instruction check-off
  await orders.complete(ORDER, { reason: 'batch done', actualBatchSize: 102 }, actor);
  return orders;
}

describe('OrdersService.reverse (un-complete a batch)', () => {
  it('reverses the full completion: stock, cost, lines, status, change set, audit', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted();

    // Completion minted 102 of PROD1 and consumed RT 12 / OLD 6 / NEW 2.
    expect(await onHandForLot(prisma, 'PROD1')).toBe(102);
    const completedAt = (await prisma.ordr.findUnique({ where: { id: ORDER } }))!.dateCompleted!;

    const res = await orders.reverse(ORDER, { reason: 'wrong charge weights' }, actor);
    expect(res.status).toBe('RLS');
    expect(res.removedOnHand).toEqual([{ lot: 'PROD1', qty: 102 }]);
    expect(res.restored).toEqual([
      { lot: 'NEW', qty: 2 },
      { lot: 'OLD', qty: 6 },
      { lot: 'RT', qty: 12 },
    ]); // sorted lot order
    expect(res.linesReset).toBe(4); // both UI lines + the instruction + the PK un-stamp
    expect(res.skippedRestores).toEqual([]);

    // Order back to Released; the actual-yield recording is undone (planned size).
    const ord = await prisma.ordr.findUnique({ where: { id: ORDER } });
    expect(ord!.status).toBe('RLS');
    expect(ord!.dateCompleted).toBeNull();
    expect(ord!.actualBatchSize).toBe(100);

    // Produced on-hand gone; the Lot/Sublot identity rows survive (legacy shape);
    // the rolled-up cost is cleared with its basis.
    expect(await onHandForLot(prisma, 'PROD1')).toBe(0);
    const prodLot = await prisma.lot.findUnique({ where: { lot: 'PROD1' } });
    expect(prodLot).not.toBeNull();
    expect(prodLot!.unitCost).toBeNull();
    expect(await prisma.sublot.count({ where: { lot: 'PROD1' } })).toBe(1);

    // Consumed materials are back and the consumption record is unwound.
    expect(await onHandForLot(prisma, 'RT')).toBe(100);
    expect(await onHandForLot(prisma, 'OLD')).toBe(6);
    expect(await onHandForLot(prisma, 'NEW')).toBe(6);
    expect(await prisma.lotGenealogy.count()).toBe(0);

    // Lines reset to the legacy full-reversal shape: QtyUsed NULL, ExecStatus NST.
    for (const lineId of [901, 902, 903]) {
      const line = await prisma.ordDetail.findUnique({ where: { id: lineId } });
      expect(line!.qtyUsed).toBeNull();
      expect(line!.execStatus).toBe('NST');
    }
    expect((await prisma.ordDetail.findUnique({ where: { id: 900 } }))!.execStatus).toBe('NST'); // PK un-stamped

    // Reversing change set: RVSMFP, linked to the order, effective-dated to the
    // completion it reverses (the legacy convention).
    const cs = await prisma.changeSet.findFirst({ where: { context: 'RVSMFP' } });
    expect(cs).not.toBeNull();
    expect(cs!.ordrId).toBe(ORDER);
    expect(cs!.id).toBeGreaterThanOrEqual(NATIVE);
    expect(cs!.changeDate!.getTime()).toBe(completedAt.getTime());

    expect(await prisma.auditLog.count({ where: { action: 'order.reverse' } })).toBe(1);
  });

  it('the reversed order is re-executable: record again, complete again, re-mint', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted();
    await orders.reverse(ORDER, { reason: 'redo' }, actor);

    // Re-execute with corrected actuals — the reset lines accept a new record.
    await orders.recordLine(ORDER, 901, { actualQty: 10, lots: [{ lot: 'RT', qty: 10 }] }, actor);
    expect(await onHandForLot(prisma, 'RT')).toBe(90);
    await orders.complete(ORDER, { reason: 'batch done right', actualBatchSize: 100 }, actor);

    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.status).toBe('CMP');
    expect(await onHandForLot(prisma, 'PROD1')).toBe(100); // re-minted at the new yield
    // Cost re-rolled from the fresh edge set: 10 × 5 / 100.
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PROD1' } }))!.unitCost)).toBeCloseTo(0.5, 5);
  });

  it('resets a batch-addition line like any recorded line (kept, re-recordable)', async () => {
    await releasedNativeBatch();
    const { orders } = services(prisma);
    const added = await orders.addExecutionLine(ORDER, { itemId: 3, qty: 5 }, actor); // FIFO: OLD 5
    await orders.complete(ORDER, { reason: 'done' }, actor);

    await orders.reverse(ORDER, { reason: 'undo' }, actor);
    const line = await prisma.ordDetail.findUnique({ where: { id: added.lineId } });
    expect(line).not.toBeNull(); // stays on the procedure as the record of the addition
    expect(line!.qtyUsed).toBeNull();
    expect(line!.execStatus).toBe('NST');
    expect(await onHandForLot(prisma, 'OLD')).toBe(6); // restored
  });

  it('restores a recorded shortfall by minting a parcel when none is left to credit', async () => {
    await releasedNativeBatch();
    // A second traced lot with a sublot but NO on-hand: recording against it
    // consumes as a full shortfall (recorded, not blocked).
    await addLot(prisma, { lot: 'RT2', itemId: 2, unitCost: 7 });
    await addSublot(prisma, { id: 4, lot: 'RT2' });
    const { orders } = services(prisma);
    await orders.recordLine(ORDER, 901, { actualQty: 12, lots: [{ lot: 'RT2', qty: 12 }] }, actor);
    expect(await onHandForLot(prisma, 'RT2')).toBe(0);
    await orders.complete(ORDER, { reason: 'done' }, actor);

    await orders.reverse(ORDER, { reason: 'undo' }, actor);
    // The full recorded consumption returns — minted fresh at the stock location.
    expect(await onHandForLot(prisma, 'RT2')).toBe(12);
  });

  it('refuses when the produced stock is not exactly as minted (adjusted / split)', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted();

    // Adjusted: the parcel no longer holds the produced quantity.
    const sub = await prisma.sublot.findFirst({ where: { lot: 'PROD1' } });
    const parcel = await prisma.inventory.findFirst({ where: { sublotId: sub!.id } });
    await prisma.inventory.update({ where: { id: parcel!.id }, data: { qty: 90 } });
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/moved, split, consumed, or adjusted/);

    // Split: a second parcel for the produced sublot.
    await prisma.inventory.update({ where: { id: parcel!.id }, data: { qty: 102 } });
    await addInventory(prisma, { itemId: 1, sublotId: sub!.id, locationId: 1, qty: 1 });
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/moved, split, consumed, or adjusted/);

    // Nothing was reversed by the refusals.
    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.status).toBe('CMP');
    expect(await onHandForLot(prisma, 'RT')).toBe(88);
  });

  it('refuses when the produced lot was consumed downstream or shipped', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted();

    await addConsumptionEdge(prisma, { childLot: 'OTHERBATCH', parentLot: 'PROD1', qty: 5, viaOrdrId: 999 });
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/already consumed/);
    await prisma.lotGenealogy.deleteMany({ where: { parentLot: 'PROD1' } });

    await addShipmentLot(prisma, { lot: 'PROD1', ordrId: 999, itemId: 1, qty: 10 });
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/already shipped/);
  });

  it('refuses non-Completed, non-production, imported, and repeat reversals', async () => {
    await releasedNativeBatch();
    const { orders } = services(prisma);

    // Still Released — nothing to reverse.
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/must be Completed/);

    // Closed is final.
    await prisma.ordr.update({ where: { id: ORDER }, data: { status: 'CLS' } });
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/must be Completed/);
    await prisma.ordr.update({ where: { id: ORDER }, data: { status: 'RLS' } });

    // A completed order imported from legacy (non-native id) is not reversible.
    await addOrder(prisma, { id: 800, context: 'MFBA', status: 'CMP' });
    await expect(orders.reverse(800, { reason: 'x' }, actor)).rejects.toThrow(/imported from the legacy system/);

    // A completed non-production order is not reversible.
    await addOrder(prisma, { id: NATIVE + 900, context: 'PO', status: 'CMP' });
    await expect(orders.reverse(NATIVE + 900, { reason: 'x' }, actor)).rejects.toThrow(/Only production/);

    // Reverse once, then again — the second finds it no longer Completed.
    const o = await executedAndCompleted();
    await o.reverse(ORDER, { reason: 'undo' }, actor);
    await expect(o.reverse(ORDER, { reason: 'again' }, actor)).rejects.toThrow(/must be Completed/);
  });

  it('reverses an MFPP order: minted PK qty removed, ActualBatchSize cleared to its creation-seeded null', async () => {
    // A packaging order: PK output line + one component; creation seeds
    // ActualBatchSize only for MFBA, so a reversed MFPP goes back to null.
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PACKOUT' });
    await addItem(prisma, { id: 3, code: 'BULK', lotTracked: false, purchasePrice: 4 });
    const MFPP = NATIVE + 810;
    await addOrder(prisma, { id: MFPP, context: 'MFPP', status: 'RLS' });
    await addOrdDetail(prisma, { id: 950, ordrId: MFPP, context: 'PK', itemId: 1, qtyReqd: 40 });
    await addOrdDetail(prisma, { id: 951, ordrId: MFPP, context: 'UI', itemId: 3, qtyReqd: 40 });
    await addLot(prisma, { lot: 'PK1', itemId: 1, ordDetailId: 950 });
    await addLot(prisma, { lot: 'B1', itemId: 3 });
    await addSublot(prisma, { id: 5, lot: 'B1' });
    await addInventory(prisma, { itemId: 3, sublotId: 5, locationId: 1, qty: 50 });
    for (const key of ['order.complete', 'order.reverse']) {
      await prisma.securedItem.create({
        data: { key, description: key, requireReason: true, requireSignature: false, requireWitness: false },
      });
    }
    await grantAllSecuredItems(prisma, actor.id);
    const { orders } = services(prisma);
    await orders.recordLine(MFPP, 951, { actualQty: 40 }, actor);
    await orders.complete(MFPP, { reason: 'packed', actualBatchSize: 38 }, actor);
    expect(await onHandForLot(prisma, 'PK1')).toBe(40); // MFPP mints the PK line qty

    const res = await orders.reverse(MFPP, { reason: 'wrong packout' }, actor);
    expect(res.removedOnHand).toEqual([{ lot: 'PK1', qty: 40 }]);
    const ord = await prisma.ordr.findUnique({ where: { id: MFPP } });
    expect(ord!.status).toBe('RLS');
    expect(ord!.actualBatchSize).toBeNull(); // not left holding the reversed actual
    expect(await onHandForLot(prisma, 'B1')).toBe(50);
  });

  it('a close racing a reversal enacts exactly one outcome (in-tx status re-assert)', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted();

    const results = await Promise.allSettled([
      orders.reverse(ORDER, { reason: 'undo' }, actor),
      orders.close(ORDER, { reason: 'done' }, actor),
    ]);
    const ord = await prisma.ordr.findUnique({ where: { id: ORDER } });
    const [rev, cls] = results;
    if (rev.status === 'fulfilled') {
      // Reversal won: the queued close must have been refused by the in-tx
      // re-assert — never stamping the terminal CLS onto a reversed order.
      expect(cls.status).toBe('rejected');
      expect(String((cls as PromiseRejectedResult).reason.message)).toMatch(/no longer Completed|must be Completed/);
      expect(ord!.status).toBe('RLS');
      expect(await onHandForLot(prisma, 'PROD1')).toBe(0);
    } else {
      // Close won: the reversal must have been refused and nothing unwound.
      expect(cls.status).toBe('fulfilled');
      expect(String((rev as PromiseRejectedResult).reason.message)).toMatch(/no longer Completed|must be Completed/);
      expect(ord!.status).toBe('CLS');
      expect(await onHandForLot(prisma, 'PROD1')).toBe(102);
      expect(await prisma.lotGenealogy.count()).toBeGreaterThan(0);
    }
  });

  it('a reversal restoring a lot races a dispense of the same lot: both land, stock conserved, no deadlock', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted(); // consumed RT 12 -> RT on hand 88

    // A second Released order dispensing the SAME raw lot the reversal will
    // restore — the restore credit and the depletion serialize on the single
    // ascending parcel scan (the system-wide lock order).
    const OTHER = NATIVE + 820;
    await addOrder(prisma, { id: OTHER, context: 'MFBA', status: 'RLS', actualBatchSize: 50 });
    await addOrdDetail(prisma, { id: 960, ordrId: OTHER, context: 'PK', itemId: 1, qtyReqd: 50 });
    await addOrdDetail(prisma, { id: 961, ordrId: OTHER, context: 'UI', itemId: 2, qtyReqd: 50 });
    await addLot(prisma, { lot: 'PROD2', itemId: 1, ordDetailId: 960 });

    const results = await Promise.allSettled([
      orders.reverse(ORDER, { reason: 'undo' }, actor),
      orders.recordLine(OTHER, 961, { actualQty: 50, lots: [{ lot: 'RT', qty: 50 }] }, actor),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // 100 - 12 (consumed) + 12 (restored) - 50 (dispensed) = 50, whatever the order.
    expect(await onHandForLot(prisma, 'RT')).toBe(50);
  });

  it('enforces the secured item: reason always, signature fail-safe when the item is missing', async () => {
    await releasedNativeBatch();
    const orders = await executedAndCompleted();

    // Reason demanded by the (enabled, signature-relaxed) seeded item.
    await expect(orders.reverse(ORDER, {}, actor)).rejects.toThrow(/reason is required/i);

    // With NO order.reverse secured item the control fails safe: signature required.
    await prisma.securedItem.delete({ where: { key: 'order.reverse' } });
    await expect(orders.reverse(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/password is required/i);
    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.status).toBe('CMP');
  });
});
