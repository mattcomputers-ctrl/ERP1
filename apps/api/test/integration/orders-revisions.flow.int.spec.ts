import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { AuthService } from '../../src/auth/auth.service';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addItem, addOrdDetail, addOrdDetailCommit, addOrdDetailTest, addOrder, grantAllSecuredItems, makePrisma, resetDb, seedActor, services } from './support';

// Order-edit revisions (§5, UG §7): revise a RELEASED production order via a
// draft (OrdrEdit STD) that flips the order to EDT — blocking execution and
// lifecycle — and only takes effect when published (edit CMP, order back to
// RLS with the new revision number; the pre-edit order is snapshotted as
// revision 0 at first publish). Rejected drafts (REJ) leave the order
// untouched and free their revision number. The legacy tables are 0-row in
// this install, so this suite is the semantics of record.

const NATIVE = 1_000_000_000;
const ORDER = NATIVE + 900;
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
 * A Released MFBA order: PK product line, two UI ingredient lines, an
 * instruction, and an IPT step carrying one test. The order.revise secured
 * item is seeded ENABLED but signature-relaxed so the flows run without
 * password re-auth (the dedicated e-sig test tightens it).
 */
async function releasedBatch() {
  await addItem(prisma, { id: 1, code: 'PROD' });
  await addItem(prisma, { id: 2, code: 'RESIN' });
  await addItem(prisma, { id: 3, code: 'SOLVENT' });
  await addOrder(prisma, { id: ORDER, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
  await addOrdDetail(prisma, { id: 900, ordrId: ORDER, context: 'PK', itemId: 1, qtyReqd: 100 });
  await addOrdDetail(prisma, { id: 901, ordrId: ORDER, context: 'UI', itemId: 2, qtyReqd: 10 });
  await addOrdDetail(prisma, { id: 902, ordrId: ORDER, context: 'UI', itemId: 3, qtyReqd: 8 });
  await addOrdDetail(prisma, { id: 903, ordrId: ORDER, context: 'INSTR', description: 'Mix 10 minutes' });
  await addOrdDetail(prisma, { id: 904, ordrId: ORDER, context: 'IPT', itemId: 1, description: 'In-process testing' });
  await addOrdDetailTest(prisma, { id: 501, ordDetailId: 904, test: 'PH', min: 6, max: 8 });
  // The produced lot of record (recordLine consumption needs it).
  await prisma.lot.create({ data: { lot: 'PROD1', context: 'LOT', itemId: 1, ordDetailId: 900 } });
  await prisma.securedItem.create({
    data: { key: 'order.revise', description: 'revise', requireReason: false, requireSignature: false, requireWitness: false },
  });
  await grantAllSecuredItems(prisma, actor.id);
  await prisma.test.create({ data: { test: 'VISC' } });
}

const draftOf = async () => {
  const d = await prisma.ordrEdit.findFirst({ where: { ordrId: ORDER, status: 'STD' } });
  expect(d).not.toBeNull();
  return d!;
};
const draftLines = (editId: number) =>
  prisma.ordDetailEdit.findMany({ where: { ordrEditId: editId }, orderBy: { id: 'asc' } });
const draftLineFor = async (editId: number, sourceLineId: number) => {
  const row = await prisma.ordDetailEdit.findFirst({ where: { ordrEditId: editId, sourceLineId } });
  expect(row).not.toBeNull();
  return row!;
};

describe('order revisions: draft lifecycle', () => {
  it('opens a draft: order EDT, full line snapshot incl. IPT tests, audit', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    const res = await orders.createRevision(ORDER, actor);
    expect(res).toMatchObject({ orderId: ORDER, revision: 1, lines: 5 });
    expect(res.editId).toBeGreaterThan(NATIVE);

    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.status).toBe('EDT');
    const edit = await draftOf();
    expect(edit).toMatchObject({ revision: 1, context: 'MFBA', createdBy: 'Flow Test' });
    const lines = await draftLines(edit.id);
    expect(lines).toHaveLength(5);
    expect(new Set(lines.map((l) => l.sourceLineId))).toEqual(new Set([900, 901, 902, 903, 904]));
    for (const l of lines) expect(l.id).toBeGreaterThan(NATIVE);
    // The IPT step's test spec is snapshotted with a back-pointer.
    const iptCopy = await draftLineFor(edit.id, 904);
    const testCopies = await prisma.ordDetailTestEdit.findMany({ where: { ordDetailEditId: iptCopy.id } });
    expect(testCopies).toHaveLength(1);
    expect(testCopies[0]).toMatchObject({ test: 'PH', min: 6, max: 8, sourceTestId: 501 });

    expect(await prisma.auditLog.count({ where: { action: 'order.revise.open' } })).toBe(1);

    // The revisions view reflects the open draft.
    const view = await orders.revisions(ORDER);
    expect(view.status).toBe('EDT');
    expect(view.canRevise).toBe(false);
    expect(view.history).toEqual([]);
    expect(view.draft).not.toBeNull();
    expect(view.draft!.lines).toHaveLength(5);
    const pk = view.draft!.lines.find((l) => l.context === 'PK')!;
    expect(pk.locked).toBe(true);
  });

  it('refuses drafts on non-Released, non-production, and already-editing orders', async () => {
    await releasedBatch();
    await addOrder(prisma, { id: ORDER + 1, context: 'MFBA', status: 'NST' });
    await addOrder(prisma, { id: ORDER + 2, context: 'PO', status: 'RLS' });
    const { orders } = services(prisma);
    await expect(orders.createRevision(ORDER + 1, actor)).rejects.toThrow(/must be Released/);
    await expect(orders.createRevision(ORDER + 2, actor)).rejects.toThrow(/Only production/);
    await orders.createRevision(ORDER, actor);
    // Second draft: the order is now Being edited, not Released.
    await expect(orders.createRevision(ORDER, actor)).rejects.toThrow(/must be Released/);
  });

  it('EDT blocks execution and lifecycle transitions', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.createRevision(ORDER, actor);
    await expect(orders.recordLine(ORDER, 901, { actualQty: 10 }, actor)).rejects.toThrow(/must be Released/);
    await expect(orders.expressExecute(ORDER, {}, actor)).rejects.toThrow(/must be Released/);
    await expect(orders.complete(ORDER, { reason: 'x' }, actor)).rejects.toThrow(/must be Released/);
  });

  it('rejecting the draft frees the order and reuses the revision number', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    const first = await orders.createRevision(ORDER, actor);
    // The reject must pin the draft it cancels — a wrong pin is a conflict.
    await expect(orders.rejectRevision(ORDER, { editId: first.editId + 1, reason: 'x' }, actor)).rejects.toThrow(/changed since you reviewed/);
    const res = await orders.rejectRevision(ORDER, { editId: first.editId, reason: 'wrong batch' }, actor);
    expect(res.status).toBe('REJ');

    const ord = await prisma.ordr.findUnique({ where: { id: ORDER } });
    expect(ord!.status).toBe('RLS');
    expect(ord!.revision).toBeNull(); // never published — no revision stamped
    expect((await prisma.ordrEdit.findUnique({ where: { id: first.editId } }))!.status).toBe('REJ');

    // Rejected edits stay out of the history and their number is reused.
    const view = await orders.revisions(ORDER);
    expect(view.history).toEqual([]);
    expect(view.canRevise).toBe(true);
    const second = await orders.createRevision(ORDER, actor);
    expect(second.revision).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'order.revise.reject' } })).toBe(1);
  });
});

describe('order revisions: draft editing', () => {
  it('edits quantities/comments on unexecuted material lines only', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    // Execute the instruction BEFORE the draft opens — its copy must be locked.
    await orders.recordLine(ORDER, 903, {}, actor);
    const { editId } = await orders.createRevision(ORDER, actor);

    const ui = await draftLineFor(editId, 901);
    const upd = await orders.updateRevisionLine(ORDER, ui.id, { qtyReqd: 12, comment: 'raised for rework' }, actor);
    expect(upd.changed).toBe(true);
    const after = await prisma.ordDetailEdit.findUnique({ where: { id: ui.id } });
    expect(after).toMatchObject({ qtyReqd: 12, comment: 'raised for rework' });
    // The LIVE line is untouched until publish.
    expect((await prisma.ordDetail.findUnique({ where: { id: 901 } }))!.qtyReqd).toBe(10);

    const pk = await draftLineFor(editId, 900);
    await expect(orders.updateRevisionLine(ORDER, pk.id, { qtyReqd: 90 }, actor)).rejects.toThrow(/cannot be changed/);
    const instr = await draftLineFor(editId, 903);
    await expect(orders.updateRevisionLine(ORDER, instr.id, { comment: 'x' }, actor)).rejects.toThrow(/already executed/);
    const ipt = await draftLineFor(editId, 904);
    await expect(orders.updateRevisionLine(ORDER, ipt.id, { qtyReqd: 1 }, actor)).rejects.toThrow(/carry a quantity/);
    // A line from another order's edit is not addressable.
    await expect(orders.updateRevisionLine(ORDER, 999999, { qtyReqd: 1 }, actor)).rejects.toThrow(/not part of/);
  });

  it('adds ingredient / instruction / IPT lines with validation', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.createRevision(ORDER, actor);

    await expect(orders.addRevisionLine(ORDER, { context: 'UI', qty: 5 }, actor)).rejects.toThrow(/needs an item/);
    await expect(orders.addRevisionLine(ORDER, { context: 'UI', itemId: 3 }, actor)).rejects.toThrow(/positive quantity/);
    await expect(orders.addRevisionLine(ORDER, { context: 'UI', itemId: 777, qty: 5 }, actor)).rejects.toThrow(/not found/);
    await expect(orders.addRevisionLine(ORDER, { context: 'INSTR' }, actor)).rejects.toThrow(/needs a description/);
    await expect(
      orders.addRevisionLine(ORDER, { context: 'INSTR', description: 'Stir', tests: [{ test: 'VISC' }] }, actor),
    ).rejects.toThrow(/Only IPT lines/);
    await expect(
      orders.addRevisionLine(ORDER, { context: 'IPT', tests: [{ test: 'NOPE' }] }, actor),
    ).rejects.toThrow(/Unknown test/);

    const ui = await orders.addRevisionLine(ORDER, { context: 'UI', itemId: 3, qty: 5, phase: 'FIX', comment: 'corrective' }, actor);
    const uiRow = await prisma.ordDetailEdit.findUnique({ where: { id: ui.lineId } });
    expect(uiRow).toMatchObject({ sourceLineId: null, context: 'UI', itemId: 3, qtyReqd: 5, stdQty: 5, phase: 'FIX' });

    const ipt = await orders.addRevisionLine(
      ORDER,
      { context: 'IPT', phase: 'FIX', tests: [{ test: 'VISC', min: 40, max: 60, target: 50 }] },
      actor,
    );
    const iptTests = await prisma.ordDetailTestEdit.findMany({ where: { ordDetailEditId: ipt.lineId } });
    expect(iptTests).toHaveLength(1);
    expect(iptTests[0]).toMatchObject({ test: 'VISC', min: 40, max: 60, target: 50, sourceTestId: null });

    // The draft view shows both as added/unlocked.
    const view = await orders.revisions(ORDER);
    const added = view.draft!.lines.filter((l) => l.added);
    expect(added).toHaveLength(2);
    expect(added.every((l) => !l.locked)).toBe(true);
    expect(view.draft!.lines).toHaveLength(7);
  });

  it('removes lines with dependency guards (executed / PK / commits / results)', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    // Record a result on the IPT's test pre-draft: the step becomes unremovable.
    await orders.recordIptResults(ORDER, { results: [{ testId: 501, result: '7' }] }, actor);
    await orders.recordLine(ORDER, 903, {}, actor); // executed instruction
    const { editId } = await orders.createRevision(ORDER, actor);

    const pk = await draftLineFor(editId, 900);
    await expect(orders.deleteRevisionLine(ORDER, pk.id, actor)).rejects.toThrow(/cannot be removed/);
    const instr = await draftLineFor(editId, 903);
    await expect(orders.deleteRevisionLine(ORDER, instr.id, actor)).rejects.toThrow(/already executed/);
    const ipt = await draftLineFor(editId, 904);
    await expect(orders.deleteRevisionLine(ORDER, ipt.id, actor)).rejects.toThrow(/recorded results/);

    // A committed line (packout/demand allocation) is refused.
    await addOrdDetailCommit(prisma, { ordDetailId: 902, srcOrdDetailId: 900, qty: 5 });
    const committed = await draftLineFor(editId, 902);
    await expect(orders.deleteRevisionLine(ORDER, committed.id, actor)).rejects.toThrow(/allocation/);
    // ...and a quantity edit may not drop below the committed floor.
    await expect(orders.updateRevisionLine(ORDER, committed.id, { qtyReqd: 4 }, actor)).rejects.toThrow(/allocated to packouts/);
    const view = await orders.revisions(ORDER);
    expect(view.draft!.lines.find((l) => l.sourceLineId === 902)!.committedQty).toBe(5);
    await prisma.ordDetailCommit.deleteMany({});

    // Now removable — the copied row is MARKED, never deleted (the draft keeps
    // its baseline); restore undoes the mark; a second remove is refused.
    await orders.deleteRevisionLine(ORDER, committed.id, actor);
    const marked = await prisma.ordDetailEdit.findUnique({ where: { id: committed.id } });
    expect(marked).toMatchObject({ sourceLineId: 902, removed: true });
    await expect(orders.deleteRevisionLine(ORDER, committed.id, actor)).rejects.toThrow(/already marked/);
    await expect(orders.updateRevisionLine(ORDER, committed.id, { qtyReqd: 9 }, actor)).rejects.toThrow(/restore it/);
    await orders.restoreRevisionLine(ORDER, committed.id, actor);
    expect((await prisma.ordDetailEdit.findUnique({ where: { id: committed.id } }))!.removed).toBe(false);
    await orders.deleteRevisionLine(ORDER, committed.id, actor);

    // An added line is withdrawn by hard delete (it never had a live source).
    const add = await orders.addRevisionLine(ORDER, { context: 'UI', itemId: 3, qty: 2 }, actor);
    await orders.deleteRevisionLine(ORDER, add.lineId, actor);
    expect(await prisma.ordDetailEdit.count({ where: { id: add.lineId } })).toBe(0);
    // Explicit-null quantity must not slip past validation onto a draft line.
    const ui = await draftLineFor(editId, 901);
    await expect(
      orders.updateRevisionLine(ORDER, ui.id, { qtyReqd: null as unknown as number }, actor),
    ).rejects.toThrow(/positive number/);
  });
});

describe('order revisions: publish', () => {
  async function draftedChanges(orders: ReturnType<typeof services>['orders']) {
    const { editId } = await orders.createRevision(ORDER, actor);
    const ui = await draftLineFor(editId, 901);
    await orders.updateRevisionLine(ORDER, ui.id, { qtyReqd: 12 }, actor);
    const gone = await draftLineFor(editId, 902);
    await orders.deleteRevisionLine(ORDER, gone.id, actor);
    await orders.addRevisionLine(ORDER, { context: 'UI', itemId: 3, qty: 5, phase: 'FIX' }, actor);
    await orders.addRevisionLine(ORDER, { context: 'IPT', phase: 'FIX', tests: [{ test: 'VISC', min: 40, max: 60 }] }, actor);
    await orders.updateRevision(ORDER, { revisionComment: 'viscosity fix' }, actor);
    return editId;
  }

  it('applies the draft to the order with a revision-0 snapshot at first publish', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    const editId = await draftedChanges(orders);

    // The signature is pinned to the reviewed draft: wrong id or a stale
    // content token is a conflict, not a publish.
    await expect(orders.publishRevision(ORDER, { editId: editId + 1 }, actor)).rejects.toThrow(/changed since you reviewed/);
    await expect(
      orders.publishRevision(ORDER, { editId, draftUpdatedAt: '2001-01-01T00:00:00.000Z' }, actor),
    ).rejects.toThrow(/edited since you reviewed/);
    const token = (await prisma.ordrEdit.findUnique({ where: { id: editId } }))!.updatedAt!.toISOString();
    const res = await orders.publishRevision(ORDER, { editId, draftUpdatedAt: token }, actor);
    expect(res).toMatchObject({
      orderId: ORDER, revision: 1, status: 'RLS',
      applied: { updated: 1, added: 2, removed: 1 }, signed: false,
    });

    // Live order: qty applied, line removed (with nothing orphaned), lines added.
    const ord = await prisma.ordr.findUnique({ where: { id: ORDER } });
    expect(ord).toMatchObject({ status: 'RLS', revision: 1 });
    expect((await prisma.ordDetail.findUnique({ where: { id: 901 } }))!.qtyReqd).toBe(12);
    expect(await prisma.ordDetail.findUnique({ where: { id: 902 } })).toBeNull();
    // The published edit keeps the removed line's row as history (marked).
    expect(await prisma.ordDetailEdit.findFirst({ where: { ordrEditId: editId, sourceLineId: 902, removed: true } })).not.toBeNull();

    const newLines = await prisma.ordDetail.findMany({ where: { ordrId: ORDER, id: { gte: NATIVE } }, orderBy: { id: 'asc' } });
    expect(newLines).toHaveLength(2);
    const [newUi, newIpt] = newLines;
    expect(newUi).toMatchObject({ context: 'UI', itemId: 3, qtyReqd: 5, stdQty: 5, phase: 'FIX', execStatus: null, qtyUsed: null, isOpen: true });
    expect(newIpt).toMatchObject({ context: 'IPT', phase: 'FIX' });
    const newTests = await prisma.ordDetailTest.findMany({ where: { ordDetailId: newIpt.id } });
    expect(newTests).toHaveLength(1);
    expect(newTests[0]).toMatchObject({ test: 'VISC', min: 40, max: 60 });
    expect(newTests[0].id).toBeGreaterThan(NATIVE);
    // Appended to the procedure: execOrder after every pre-existing line.
    expect(newUi.execOrder).toBeGreaterThan(0);
    expect(newIpt.execOrder).toBe(newUi.execOrder! + 1);

    // Revision 0 snapshot: the PRE-edit order (901 at 10; 902 present).
    const revZero = await prisma.ordrEdit.findFirst({ where: { ordrId: ORDER, revision: 0 } });
    expect(revZero).not.toBeNull();
    expect(revZero!.status).toBe('CMP');
    const zeroLines = await draftLines(revZero!.id);
    expect(zeroLines).toHaveLength(5);
    expect(zeroLines.find((l) => l.sourceLineId === 901)!.qtyReqd).toBe(10);
    expect(zeroLines.find((l) => l.sourceLineId === 902)).toBeTruthy();

    // The published edit's added lines now point at the live lines they created.
    const publishedLines = await draftLines(editId);
    const linked = publishedLines.filter((l) => l.sourceLineId != null && l.sourceLineId >= NATIVE);
    expect(linked).toHaveLength(2);

    // History: rev 0 + rev 1; no draft; revisable again; execution unblocked.
    const view = await orders.revisions(ORDER);
    expect(view.history.map((h) => h.revision)).toEqual([0, 1]);
    expect(view.draft).toBeNull();
    expect(view.canRevise).toBe(true);
    await orders.recordLine(ORDER, 903, {}, actor); // RLS again — records fine

    expect(await prisma.auditLog.count({ where: { action: 'order.revise.publish' } })).toBe(1);
    expect(await prisma.eSignature.count()).toBe(0); // signature-relaxed fixture
  });

  it('publish requires a revision comment and a non-empty diff; draft is single-use', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    const { editId } = await orders.createRevision(ORDER, actor);
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/revision comment/i);
    await orders.updateRevision(ORDER, { revisionComment: 'no-op' }, actor);
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/no changes/);
    await orders.rejectRevision(ORDER, { editId }, actor);
    // No open draft anymore: draft endpoints refuse.
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/must be Being edited/);
    await expect(orders.updateRevision(ORDER, { revisionComment: 'x' }, actor)).rejects.toThrow(/no longer Being edited|not found|no revision/i);
  });

  it('publish-time re-check: drift after the draft edit refuses the publish', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    const { editId } = await orders.createRevision(ORDER, actor);
    const gone = await draftLineFor(editId, 902);
    await orders.deleteRevisionLine(ORDER, gone.id, actor);
    await orders.updateRevision(ORDER, { revisionComment: 'drop solvent' }, actor);

    // (a) An allocation lands on the to-be-removed line AFTER the draft edit
    // (e.g. written by a parallel-running import) — publish must refuse.
    await addOrdDetailCommit(prisma, { ordDetailId: 902, srcOrdDetailId: 900, qty: 5 });
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/allocation/);
    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.status).toBe('EDT');
    expect(await prisma.ordDetail.findUnique({ where: { id: 902 } })).not.toBeNull();
    await prisma.ordDetailCommit.deleteMany({});

    // (b) The to-be-removed line got EXECUTED behind the draft's back
    // (simulated direct write — EDT blocks the native path).
    await prisma.ordDetail.update({ where: { id: 902 }, data: { execStatus: 'CMP', qtyUsed: 8 } });
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/cannot be removed/);
    await prisma.ordDetail.update({ where: { id: 902 }, data: { execStatus: null, qtyUsed: null } });

    // (c) A CHANGED line got executed behind the draft's back.
    const ui = await draftLineFor(editId, 901);
    await orders.updateRevisionLine(ORDER, ui.id, { qtyReqd: 12 }, actor);
    await prisma.ordDetail.update({ where: { id: 901 }, data: { execStatus: 'CMP', qtyUsed: 10 } });
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/executed since the draft/);
    await prisma.ordDetail.update({ where: { id: 901 }, data: { execStatus: null, qtyUsed: null } });

    // (d) A live line APPEARED after the snapshot (parallel-running import) —
    // it must never be silently deleted as a "removal".
    await addOrdDetail(prisma, { id: 905, ordrId: ORDER, context: 'UI', itemId: 3, qtyReqd: 1 });
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/appeared since the draft/);
    expect(await prisma.ordDetail.findUnique({ where: { id: 905 } })).not.toBeNull();
    await prisma.ordDetail.delete({ where: { id: 905 } });

    // (e) A snapshotted live line VANISHED (legacy delete propagated by sync).
    await prisma.ordDetailTest.deleteMany({ where: { ordDetailId: 904 } });
    await prisma.ordDetail.delete({ where: { id: 904 } });
    await expect(orders.publishRevision(ORDER, { editId }, actor)).rejects.toThrow(/no longer exists/);

    // Nothing was half-applied across all five refusals.
    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.status).toBe('EDT');
    expect(await prisma.auditLog.count({ where: { action: 'order.revise.publish' } })).toBe(0);
  });

  it('reads a reversal-reset line (ExecStatus NST) as unexecuted and revisable', async () => {
    await releasedBatch();
    // A line as reverse() leaves it: ExecStatus 'NST', QtyUsed cleared.
    await addOrdDetail(prisma, { id: 906, ordrId: ORDER, context: 'UI', itemId: 3, qtyReqd: 4, execStatus: 'NST' });
    const { orders } = services(prisma);
    const { editId } = await orders.createRevision(ORDER, actor);
    const view = await orders.revisions(ORDER);
    expect(view.draft!.lines.find((l) => l.sourceLineId === 906)!.locked).toBe(false);
    const row = await draftLineFor(editId, 906);
    await orders.updateRevisionLine(ORDER, row.id, { qtyReqd: 6 }, actor);
    await orders.updateRevision(ORDER, { revisionComment: 'post-reversal fix' }, actor);
    const res = await orders.publishRevision(ORDER, { editId }, actor);
    expect(res.applied.updated).toBe(1);
    expect((await prisma.ordDetail.findUnique({ where: { id: 906 } }))!.qtyReqd).toBe(6);
  });

  it('refuses IPT additions on packaging (MFPP) orders — results are MFBA-only', async () => {
    await releasedBatch();
    await addOrder(prisma, { id: ORDER + 3, context: 'MFPP', status: 'RLS' });
    await addOrdDetail(prisma, { id: 910, ordrId: ORDER + 3, context: 'PK', itemId: 1, qtyReqd: 10 });
    await addOrdDetail(prisma, { id: 911, ordrId: ORDER + 3, context: 'UI', itemId: 3, qtyReqd: 2 });
    const { orders } = services(prisma);
    await orders.createRevision(ORDER + 3, actor);
    await expect(
      orders.addRevisionLine(ORDER + 3, { context: 'IPT', tests: [{ test: 'VISC' }] }, actor),
    ).rejects.toThrow(/Only batch \(MFBA\) orders/);
    // UI additions on MFPP stay legal (§9 packaging order edit).
    const ok = await orders.addRevisionLine(ORDER + 3, { context: 'UI', itemId: 3, qty: 1 }, actor);
    expect(ok.lineId).toBeGreaterThan(NATIVE);
  });

  it('second revision publishes as rev 2 with a single rev-0 snapshot', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    const firstEditId = await draftedChanges(orders);
    await orders.publishRevision(ORDER, { editId: firstEditId }, actor);

    const { editId } = await orders.createRevision(ORDER, actor);
    expect((await prisma.ordrEdit.findUnique({ where: { id: editId } }))!.revision).toBe(2);
    const ui = await draftLineFor(editId, 901);
    await orders.updateRevisionLine(ORDER, ui.id, { qtyReqd: 14 }, actor);
    await orders.updateRevision(ORDER, { revisionComment: 'raise again' }, actor);
    const res = await orders.publishRevision(ORDER, { editId }, actor);
    expect(res.revision).toBe(2);

    expect((await prisma.ordr.findUnique({ where: { id: ORDER } }))!.revision).toBe(2);
    expect((await prisma.ordDetail.findUnique({ where: { id: 901 } }))!.qtyReqd).toBe(14);
    expect(await prisma.ordrEdit.count({ where: { ordrId: ORDER, revision: 0 } })).toBe(1);
    const view = await orders.revisions(ORDER);
    expect(view.history.map((h) => h.revision)).toEqual([0, 1, 2]);
    // The second edit's draft baseline captured the post-rev-1 state (12).
    const rev2 = view.history.find((h) => h.revision === 2)!;
    const rev2Lines = await orders.revisionLines(ORDER, rev2.editId);
    expect(rev2Lines.lines.find((l) => l.sourceLineId === 901)!.qtyReqd).toBe(14);
  });

  it('publish is an e-signable act when the secured item demands a signature', async () => {
    await releasedBatch();
    await prisma.securedItem.update({ where: { key: 'order.revise' }, data: { requireSignature: true } });
    const auth = new AuthService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
    const pwHash = await auth.hashPassword('Sup3rSecret!!');
    const u = await prisma.user.create({
      data: { email: 'signer@test.local', displayName: 'Signer', status: 'ACTIVE', passwordHash: pwHash },
      select: { id: true, displayName: true },
    });
    const signer: Actor = { id: u.id, label: u.displayName };
    // The signer needs the PERFORM grant (enforced since L22) — this test is
    // about the SIGNATURE requirement, not the grant gate.
    await grantAllSecuredItems(prisma, u.id);

    const { orders } = services(prisma);
    const { editId } = await orders.createRevision(ORDER, signer);
    const ui = await draftLineFor(editId, 901);
    await orders.updateRevisionLine(ORDER, ui.id, { qtyReqd: 11 }, signer);
    await orders.updateRevision(ORDER, { revisionComment: 'sign me' }, signer);

    await expect(orders.publishRevision(ORDER, { editId }, signer)).rejects.toThrow(/password is required/i);
    await expect(orders.publishRevision(ORDER, { editId, password: 'wrong' }, signer)).rejects.toThrow();
    const ok = await orders.publishRevision(ORDER, { editId, password: 'Sup3rSecret!!' }, signer);
    expect(ok.signed).toBe(true);

    const sig = await prisma.eSignature.findFirst({ where: { securedItemKey: 'order.revise' } });
    expect(sig).not.toBeNull();
    expect(sig!.masterId).toBe(String(ORDER));
    // Wrong-password attempts must not have half-published: exactly one publish.
    expect(await prisma.auditLog.count({ where: { action: 'order.revise.publish' } })).toBe(1);
  });
});
