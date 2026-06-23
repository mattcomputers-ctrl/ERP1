import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addOrder, makePrisma, resetDb, services } from './support';

// Flow integration test: the ORDER-EDIT blocking approval workflow (the reusable
// ApprovalRequest engine's first consumer). A request-only group's edit is held
// PENDING until a qualified approver (canApproveUpdate) approves it (enacting the
// edit) or rejects it. A capable group enacts directly.

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

describe('Order-edit approval workflow', () => {
  it('a request-only group submits a PENDING edit (order unchanged); a capable group enacts directly', async () => {
    const { orders } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const approver = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    await addOrder(prisma, { id: 500, context: 'MFBA', status: 'NST' });

    const res = (await orders.edit(500, { reference: 'requested' }, requester)) as { pending?: boolean; requestId?: number };
    expect(res.pending).toBe(true);
    expect((await prisma.ordr.findUnique({ where: { id: 500 } }))!.reference).toBeNull(); // unchanged
    const req = (await prisma.approvalRequest.findFirst({ where: { kind: 'order.edit' } }))!;
    expect(req.state).toBe('PENDING');
    expect(req.requestedById).toBe(requester.id);

    // A capable group enacts directly (no pending request).
    await orders.edit(500, { reference: 'direct' }, approver);
    expect((await prisma.ordr.findUnique({ where: { id: 500 } }))!.reference).toBe('direct');
    expect(await prisma.approvalRequest.count({ where: { kind: 'order.edit' } })).toBe(1); // still just the requester's
  });

  it('approving a pending edit enacts it (CAS); a non-approver cannot; re-approve fails', async () => {
    const { orders } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const approver = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    await addOrder(prisma, { id: 500, context: 'MFBA', status: 'NST' });
    const r = (await orders.edit(500, { reference: 'wanted' }, requester)) as { requestId: number };

    await expect(orders.approveEdit(r.requestId, requester)).rejects.toThrow(/not permitted/i); // requester can't approve
    await orders.approveEdit(r.requestId, approver);
    expect((await prisma.ordr.findUnique({ where: { id: 500 } }))!.reference).toBe('wanted');
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'order.edit' } }))!.state).toBe('APPROVED');
    await expect(orders.approveEdit(r.requestId, approver)).rejects.toThrow(/already approved/i);
  });

  it('rejecting leaves the order unchanged and requires a reason', async () => {
    const { orders } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const approver = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    await addOrder(prisma, { id: 501, context: 'MFBA', status: 'NST' });
    const r = (await orders.edit(501, { reference: 'wanted2' }, requester)) as { requestId: number };

    await expect(orders.rejectEdit(r.requestId, { reason: '' }, approver)).rejects.toThrow(/reason is required/i);
    await orders.rejectEdit(r.requestId, { reason: 'out of scope' }, approver);
    expect((await prisma.ordr.findUnique({ where: { id: 501 } }))!.reference).toBeNull(); // unchanged
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'order.edit' } }))!.state).toBe('REJECTED');
  });

  it('refuses to approve an edit once the order has left Not-started (NST re-asserted at enact time)', async () => {
    const { orders } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    const approver = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    await addOrder(prisma, { id: 502, context: 'MFBA', status: 'NST' });
    const r = (await orders.edit(502, { batchSize: 7 }, requester)) as { requestId: number };

    // The order is released after the request is raised but before it's approved.
    await prisma.ordr.update({ where: { id: 502 }, data: { status: 'RLS' } });
    await expect(orders.approveEdit(r.requestId, approver)).rejects.toThrow(/Not started/i);
    // The request stays PENDING (the CAS-decide rolls back with the refused enact).
    expect((await prisma.approvalRequest.findFirst({ where: { kind: 'order.edit' } }))!.state).toBe('PENDING');
  });

  it('forbids approving your own request (separation of duties)', async () => {
    const { orders } = services(prisma);
    const lead = await userWithPolicy('lead@test.local', { canRequestApproval: true, canApproveUpdate: true });
    await addOrder(prisma, { id: 500, context: 'MFBA', status: 'NST' });
    // A request+approve-capable user enacts directly, so insert a PENDING request owned by them to reach the guard.
    const req = await prisma.approvalRequest.create({
      data: { kind: 'order.edit', targetTable: 'Ordr', targetId: '500', payload: JSON.stringify({ reference: 'x' }), requiredCapability: 'approveUpdate', state: 'PENDING', requestedById: lead.id, requestedByLabel: lead.label, requestedAt: new Date('2026-01-01T00:00:00Z') },
      select: { id: true },
    });
    await expect(orders.approveEdit(Number(req.id), lead)).rejects.toThrow(/your own/i);
  });

  it('lists pending order-edit requests with order context', async () => {
    const { orders } = services(prisma);
    const requester = await userWithPolicy('req@test.local', { canRequestApproval: true });
    await addOrder(prisma, { id: 500, context: 'MFBA', status: 'NST', poNumber: 'X' });
    await orders.edit(500, { reference: 'wanted', batchSize: undefined }, requester);

    const list = await orders.listEditApprovals();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ orderId: 500, context: 'MFBA', reference: 'wanted' });
    expect(list.rows[0].requestedBy).toBe(requester.label);
  });
});
