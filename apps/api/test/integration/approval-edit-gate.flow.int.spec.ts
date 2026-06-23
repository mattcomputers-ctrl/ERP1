import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { makePrisma, resetDb, services } from './support';

// Flow integration test: the approval-policy GATE on edit actions. A group may
// edit (order edit / PO + SH line edits) directly only if it can approve updates
// (canApproveUpdate / canApprove / canOverride / noApprovalRequired). A
// request-only group is refused. The gate runs FIRST, so we can assert it by
// error discrimination (Forbidden = blocked at the gate; NotFound = past the gate).

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

type Caps = Partial<{
  canRequestApproval: boolean; canApprove: boolean; canApproveUpdate: boolean;
  canApproveChange: boolean; canOverride: boolean; noApprovalRequired: boolean;
}>;
async function userWithPolicy(email: string, caps: Caps): Promise<Actor> {
  const role = await prisma.role.create({
    data: {
      code: email,
      name: email,
      approvalPolicy: { create: { canRequestApproval: false, canApprove: false, canApproveUpdate: false, canApproveChange: false, canOverride: false, noApprovalRequired: false, ...caps } },
    },
    select: { id: true },
  });
  const u = await prisma.user.create({ data: { email, displayName: email, roles: { create: { roleId: role.id } } }, select: { id: true, displayName: true } });
  return { id: u.id, label: u.displayName };
}

describe('Approval policy gate on edits (canApproveUpdate)', () => {
  it('blocks order edit / PO line add / SH line add for a request-only group', async () => {
    const { orders, purchasing, shipping } = services(prisma);
    const noCap = await userWithPolicy('req@test.local', { canRequestApproval: true });
    await expect(orders.edit(123, { batchSize: 5 }, noCap)).rejects.toThrow(/not permitted to edit orders/i);
    await expect(purchasing.addLine(123, { itemId: 1, qtyReqd: 1 }, noCap)).rejects.toThrow(/not permitted to edit purchase order lines/i);
    await expect(shipping.addLine(123, { itemId: 1, qtyReqd: 1 }, noCap)).rejects.toThrow(/not permitted to edit shipping order lines/i);
  });

  it('lets a group with canApproveUpdate past the gate (then hits the normal not-found)', async () => {
    const { orders, purchasing, shipping } = services(prisma);
    const capable = await userWithPolicy('upd@test.local', { canApproveUpdate: true });
    // Past the gate -> the normal "order not found" for a bogus id (proves the gate let it through).
    await expect(orders.edit(123, { batchSize: 5 }, capable)).rejects.toThrow(/not found/i);
    await expect(purchasing.addLine(123, { itemId: 1, qtyReqd: 1 }, capable)).rejects.toThrow(/not found/i);
    await expect(shipping.addLine(123, { itemId: 1, qtyReqd: 1 }, capable)).rejects.toThrow(/not found/i);
  });

  it('also lets override / exempt groups edit, but not a no-capability group', async () => {
    const { orders } = services(prisma);
    const override = await userWithPolicy('ovr@test.local', { canOverride: true });
    const exempt = await userWithPolicy('exempt@test.local', { noApprovalRequired: true });
    const none = await userWithPolicy('none@test.local', {}); // all false
    await expect(orders.edit(123, { batchSize: 5 }, override)).rejects.toThrow(/not found/i);
    await expect(orders.edit(123, { batchSize: 5 }, exempt)).rejects.toThrow(/not found/i);
    await expect(orders.edit(123, { batchSize: 5 }, none)).rejects.toThrow(/not permitted to edit/i);
  });
});
