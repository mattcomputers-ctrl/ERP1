import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addEntity, addItem, addOrder, addOrdDetail, makePrisma, resetDb, services } from './support';

// Flow integration test: the PO + SH LINE-EDIT blocking approval workflow (the
// reusable ApprovalRequest engine's second + third consumers). A request-only
// group's line edit (add / update / remove) is held PENDING until a qualified
// approver (canApproveUpdate) enacts it or rejects it. A capable group enacts
// directly. Mirrors the order-edit workflow but with three sub-actions per kind.

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

type Caps = Partial<{ canRequestApproval: boolean; canApprove: boolean; canApproveUpdate: boolean; canApproveChange: boolean; canOverride: boolean; noApprovalRequired: boolean }>;
async function userWithPolicy(email: string, caps: Caps): Promise<Actor> {
  const role = await prisma.role.create({
    data: { code: email, name: email, approvalPolicy: { create: { canRequestApproval: false, canApprove: false, canApproveUpdate: false, canApproveChange: false, canOverride: false, noApprovalRequired: false, ...caps } } },
    select: { id: true },
  });
  const u = await prisma.user.create({ data: { email, displayName: email, roles: { create: { roleId: role.id } } }, select: { id: true, displayName: true } });
  return { id: u.id, label: u.displayName };
}

const poLines = (po: number) => prisma.ordDetail.count({ where: { ordrId: po, context: 'PO' } });
async function setupPo(po = 700) {
  const supplier = await addEntity(prisma, { id: 900, code: 'SUP', isSupplier: true });
  await addItem(prisma, { id: 800, code: 'ITM800' });
  await addOrder(prisma, { id: po, context: 'PO', status: 'NST', entityId: supplier, poNumber: 'PO-700' });
  const lineId = await addOrdDetail(prisma, { id: 810, ordrId: po, context: 'PO', itemId: 800, qtyReqd: 5, price: 2 });
  return { po, supplier, itemId: 800, lineId };
}

describe('PO line-edit approval workflow', () => {
  it('a request-only group submits a PENDING add (PO unchanged); a capable group enacts directly', async () => {
    const { purchasing } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    const { po } = await setupPo();

    const res = (await purchasing.addLine(po, { itemId: 800, qtyReqd: 3 }, requester)) as { pending?: boolean; requestId?: number };
    expect(res.pending).toBe(true);
    expect(await poLines(po)).toBe(1); // PO unchanged
    const req = (await prisma.approvalRequest.findFirst({ where: { kind: 'po.line.edit' } }))!;
    expect(req.state).toBe('PENDING');
    expect(req.requestedById).toBe(requester.id);

    await purchasing.addLine(po, { itemId: 800, qtyReqd: 4 }, capable);
    expect(await poLines(po)).toBe(2); // capable enacts directly
    expect(await prisma.approvalRequest.count({ where: { kind: 'po.line.edit' } })).toBe(1);
  });

  it('approving a pending add enacts it (CAS); a non-approver cannot; re-approve fails', async () => {
    const { purchasing } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    const { po } = await setupPo();
    const r = (await purchasing.addLine(po, { itemId: 800, qtyReqd: 3 }, requester)) as { requestId: number };

    await expect(purchasing.approvePoLineEdit(r.requestId, requester)).rejects.toThrow(/not permitted/i);
    await purchasing.approvePoLineEdit(r.requestId, capable);
    expect(await poLines(po)).toBe(2);
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'po.line.edit' } }))!.state).toBe('APPROVED');
    await expect(purchasing.approvePoLineEdit(r.requestId, capable)).rejects.toThrow(/already approved/i);
  });

  it('rejecting leaves the PO unchanged and requires a reason', async () => {
    const { purchasing } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    const { po } = await setupPo();
    const r = (await purchasing.addLine(po, { itemId: 800, qtyReqd: 3 }, requester)) as { requestId: number };

    await expect(purchasing.rejectPoLineEdit(r.requestId, { reason: '' }, capable)).rejects.toThrow(/reason is required/i);
    await purchasing.rejectPoLineEdit(r.requestId, { reason: 'out of scope' }, capable);
    expect(await poLines(po)).toBe(1); // unchanged
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'po.line.edit' } }))!.state).toBe('REJECTED');
  });

  it('holds a remove/update request PENDING and enacts the exact op on approve', async () => {
    const { purchasing } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    const { po, lineId } = await setupPo();
    // Add a second line directly (capable) so a remove won't hit the last-line guard.
    await purchasing.addLine(po, { itemId: 800, qtyReqd: 9 }, capable);
    expect(await poLines(po)).toBe(2);

    // Request an UPDATE of the original line's qty; enact on approve.
    const up = (await purchasing.updateLine(po, lineId, { qtyReqd: 12 }, requester)) as { pending?: boolean; requestId: number };
    expect(up.pending).toBe(true);
    expect((await prisma.ordDetail.findUnique({ where: { id: lineId } }))!.qtyReqd).toBe(5); // unchanged while pending
    await purchasing.approvePoLineEdit(up.requestId, capable);
    expect((await prisma.ordDetail.findUnique({ where: { id: lineId } }))!.qtyReqd).toBe(12);

    // Request a REMOVE of the original line; enact on approve.
    const rm = (await purchasing.removeLine(po, lineId, requester)) as { pending?: boolean; requestId: number };
    expect(rm.pending).toBe(true);
    expect(await poLines(po)).toBe(2); // still there while pending
    await purchasing.approvePoLineEdit(rm.requestId, capable);
    expect(await poLines(po)).toBe(1);
    expect(await prisma.ordDetail.findUnique({ where: { id: lineId } })).toBeNull();
  });

  it('forbids approving your own request (separation of duties)', async () => {
    const { purchasing } = services(prisma);
    const lead = await userWithPolicy('lead@test.local', { canRequestApproval: true, canApproveUpdate: true });
    const { po } = await setupPo();
    // A request+approve-capable user enacts directly, so insert a PENDING request owned by them to reach the guard.
    const req = await prisma.approvalRequest.create({
      data: { kind: 'po.line.edit', targetTable: 'Ordr', targetId: String(po), payload: JSON.stringify({ op: 'add', dto: { itemId: 800, qtyReqd: 1 } }), requiredCapability: 'approveUpdate', state: 'PENDING', requestedById: lead.id, requestedByLabel: lead.label, requestedAt: new Date('2026-01-01T00:00:00Z') },
      select: { id: true },
    });
    await expect(purchasing.approvePoLineEdit(Number(req.id), lead)).rejects.toThrow(/your own/i);
  });

  it('lists pending PO line-edit requests with op + summary', async () => {
    const { purchasing } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const { po } = await setupPo();
    await purchasing.addLine(po, { itemId: 800, qtyReqd: 3 }, requester);

    const list = await purchasing.listPoLineApprovals();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ orderId: po, op: 'add', poNumber: 'PO-700' });
    expect(list.rows[0].summary).toMatch(/Add ITM800/);
    expect(list.rows[0].requestedBy).toBe(requester.label);
  });

  it('blocks a no-capability group entirely (cannot even request)', async () => {
    const { purchasing } = services(prisma);
    const none = await userWithPolicy('none@test.local', {}); // all false
    const { po } = await setupPo();
    await expect(purchasing.addLine(po, { itemId: 800, qtyReqd: 1 }, none)).rejects.toThrow(/not permitted to edit purchase order lines or request/i);
  });
});

async function setupSh(sh = 750) {
  const cust = await addEntity(prisma, { id: 950, code: 'CUST', isBillTo: true });
  await addItem(prisma, { id: 850, code: 'ITM850' });
  await addOrder(prisma, { id: sh, context: 'SH', status: 'NST', billToId: cust });
  const lineId = await addOrdDetail(prisma, { id: 860, ordrId: sh, context: 'SH', itemId: 850, qtyReqd: 2, price: 5 });
  return { sh, itemId: 850, lineId };
}
const shLines = (sh: number) => prisma.ordDetail.count({ where: { ordrId: sh, context: 'SH' } });

describe('SH line-edit approval workflow', () => {
  it('a request-only group submits a PENDING add (order unchanged); approve enacts it', async () => {
    const { shipping } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    const { sh } = await setupSh();

    const res = (await shipping.addLine(sh, { itemId: 850, qtyReqd: 4 }, requester)) as { pending?: boolean; requestId: number };
    expect(res.pending).toBe(true);
    expect(await shLines(sh)).toBe(1); // unchanged
    const req = (await prisma.approvalRequest.findFirst({ where: { kind: 'sh.line.edit' } }))!;
    expect(req.state).toBe('PENDING');

    await expect(shipping.approveShLineEdit(res.requestId, requester)).rejects.toThrow(/not permitted/i);
    await shipping.approveShLineEdit(res.requestId, capable);
    expect(await shLines(sh)).toBe(2);
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'sh.line.edit' } }))!.state).toBe('APPROVED');
  });

  it('a capable group enacts directly; reject requires a reason and leaves the order unchanged', async () => {
    const { shipping } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    const { sh } = await setupSh();

    await shipping.addLine(sh, { itemId: 850, qtyReqd: 7 }, capable);
    expect(await shLines(sh)).toBe(2); // enacted directly

    const r = (await shipping.addLine(sh, { itemId: 850, qtyReqd: 1 }, requester)) as { requestId: number };
    await expect(shipping.rejectShLineEdit(r.requestId, { reason: '' }, capable)).rejects.toThrow(/reason is required/i);
    await shipping.rejectShLineEdit(r.requestId, { reason: 'nope' }, capable);
    expect(await shLines(sh)).toBe(2); // request didn't add a line
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'sh.line.edit' } }))!.state).toBe('REJECTED');
  });
});
