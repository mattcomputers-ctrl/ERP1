import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth.service';
import { AuditService } from '../../src/audit/audit.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { makePrisma, resetDb, services } from './support';

// Flow integration test: the QA-disposition APPROVAL WORKFLOW (the approval
// engine's first enforcement) against a real Postgres. The release.disposition
// secured item is seeded RELAXED (no signature) so these tests exercise the
// capability routing + pending/approve/reject state machine, not the e-signature
// machinery (covered elsewhere).

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
  // Relaxed secured item: exists + all response flags false -> no signature/reason.
  await prisma.securedItem.create({ data: { key: 'release.disposition' } });
});

type Caps = Partial<{
  canRequestApproval: boolean; canApprove: boolean; canApproveUpdate: boolean;
  canApproveChange: boolean; canOverride: boolean; noApprovalRequired: boolean;
}>;

async function makeRole(code: string, policy?: Caps): Promise<string> {
  const r = await prisma.role.create({ data: { code, name: code }, select: { id: true } });
  if (policy) await prisma.roleApprovalPolicy.create({ data: { roleId: r.id, ...policy } });
  // L22 enforces the release.disposition PERFORM grant at the gate — every
  // role in this spec is about approval CAPABILITIES, so grant it uniformly.
  const item = await prisma.securedItem.findUnique({ where: { key: 'release.disposition' }, select: { id: true } });
  if (item) await prisma.roleSecuredItem.create({ data: { roleId: r.id, securedItemId: item.id, allow: true, allowWitness: true } });
  return r.id;
}
async function makeUser(email: string, roleIds: string[]): Promise<Actor> {
  const u = await prisma.user.create({
    data: { email, displayName: email, roles: { create: roleIds.map((roleId) => ({ roleId })) } },
    select: { id: true, displayName: true },
  });
  return { id: u.id, label: u.displayName };
}
async function makeRelease(status = 'Hold'): Promise<number> {
  const r = await prisma.release.create({ data: { status }, select: { id: true } });
  return r.id;
}

describe('ApprovalPolicyService.effectiveForUser', () => {
  it('OR-combines a user\'s roles, and a user with no roles holds nothing', async () => {
    const { approvalPolicy } = services(prisma);
    const a = await makeRole('A', { canApprove: true, canRequestApproval: false });
    const b = await makeRole('B', { canOverride: true, canRequestApproval: false });
    const user = await makeUser('multi@test.local', [a, b]);

    const caps = await approvalPolicy.effectiveForUser(user.id);
    expect(caps.canApprove).toBe(true); // from role A
    expect(caps.canOverride).toBe(true); // from role B
    expect(caps.canApproveChange).toBe(false);
    expect(caps.canRequestApproval).toBe(false);

    const noRole = await makeUser('lonely@test.local', []);
    const none = await approvalPolicy.effectiveForUser(noRole.id);
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });

  it('a role with no stored policy contributes the request-only default', async () => {
    const { approvalPolicy } = services(prisma);
    const role = await makeRole('PLAIN'); // no policy row
    const user = await makeUser('plain@test.local', [role]);
    const caps = await approvalPolicy.effectiveForUser(user.id);
    expect(caps.canRequestApproval).toBe(true);
    expect(caps.canApprove || caps.canApproveChange || caps.canOverride || caps.noApprovalRequired).toBe(false);
  });
});

describe('QA disposition approval workflow (blocking)', () => {
  it('an approver group enacts the disposition immediately (no pending row)', async () => {
    const { releases } = services(prisma);
    const role = await makeRole('QA', { canApproveChange: true });
    const actor = await makeUser('qa@test.local', [role]);
    const releaseId = await makeRelease('Hold');

    const res = await releases.disposition(releaseId, { status: 'Approved', grade: 'A' }, actor);
    expect(res).toMatchObject({ id: releaseId, status: 'Approved' });
    expect((res as { pending?: boolean }).pending).toBeUndefined();

    const rel = (await prisma.release.findUnique({ where: { id: releaseId } }))!;
    expect(rel.status).toBe('Approved');
    expect(rel.grade).toBe('A');
    expect(rel.releasedBy).toBe(actor.label);
    expect(await prisma.approvalRequest.count({ where: { kind: 'release.disposition' } })).toBe(0); // direct enact, no request
    expect(await prisma.auditLog.count({ where: { action: 'release.disposition' } })).toBe(1);
  });

  it('a request-only group submits a PENDING request and leaves the Release unchanged', async () => {
    const { releases } = services(prisma);
    const role = await makeRole('OPS', { canRequestApproval: true });
    const actor = await makeUser('ops@test.local', [role]);
    const releaseId = await makeRelease('Hold');

    const res = (await releases.disposition(releaseId, { status: 'Approved', grade: 'B' }, actor)) as { pending: boolean; approvalId: number };
    expect(res.pending).toBe(true);
    expect(res.approvalId).toBeGreaterThan(0);

    // Release is untouched until approved.
    const rel = (await prisma.release.findUnique({ where: { id: releaseId } }))!;
    expect(rel.status).toBe('Hold');
    expect(rel.grade).toBeNull();

    const appr = (await prisma.approvalRequest.findFirst({ where: { kind: 'release.disposition' } }))!;
    expect(appr.state).toBe('PENDING');
    const payload = JSON.parse(appr.payload) as { status: string; grade?: string | null };
    expect(payload.status).toBe('Approved');
    expect(payload.grade).toBe('B');
    expect(appr.requestedById).toBe(actor.id);
    expect(await prisma.auditLog.count({ where: { action: 'release.disposition.request' } })).toBe(1);
  });

  it('refuses a group with neither enact nor request capability', async () => {
    const { releases } = services(prisma);
    const role = await makeRole('READONLY', { canRequestApproval: false }); // all caps false
    const actor = await makeUser('ro@test.local', [role]);
    const releaseId = await makeRelease('Hold');
    await expect(releases.disposition(releaseId, { status: 'Approved' }, actor)).rejects.toThrow(/not permitted/);
  });

  it('an approver approves a pending request, enacting it on the Release', async () => {
    const { releases } = services(prisma);
    const reqRole = await makeRole('OPS', { canRequestApproval: true });
    const apprRole = await makeRole('QA', { canApproveChange: true });
    const requester = await makeUser('ops@test.local', [reqRole]);
    const approver = await makeUser('qa@test.local', [apprRole]);
    const releaseId = await makeRelease('Hold');

    // Include purity + expiry so the full snapshot round-trip is exercised.
    const req = (await releases.disposition(releaseId, { status: 'Approved', grade: 'A', purity: 99.5, expiryDate: '2027-01-01' }, requester)) as { approvalId: number };
    const res = await releases.approveDisposition(req.approvalId, {}, approver);
    expect(res).toMatchObject({ approvalId: req.approvalId, releaseId, status: 'Approved', enacted: true });

    const rel = (await prisma.release.findUnique({ where: { id: releaseId } }))!;
    expect(rel.status).toBe('Approved');
    expect(rel.grade).toBe('A');
    expect(rel.purity).toBe(99.5);
    expect(rel.expiryDate?.toISOString().startsWith('2027-01-01')).toBe(true);
    expect(rel.releasedBy).toBe(approver.label); // enacted by the approver
    const appr = (await prisma.approvalRequest.findUnique({ where: { id: BigInt(req.approvalId) } }))!;
    expect(appr.state).toBe('APPROVED');
    expect(appr.decidedById).toBe(approver.id);
    expect(await prisma.auditLog.count({ where: { action: 'release.disposition.approve' } })).toBe(1);
  });

  it('rejects approve by a non-approver, a non-pending request, and an unknown id', async () => {
    const { releases } = services(prisma);
    const reqRole = await makeRole('OPS', { canRequestApproval: true });
    const requester = await makeUser('ops@test.local', [reqRole]);
    const approver = await makeUser('qa@test.local', [await makeRole('QA', { canApproveChange: true })]);
    const releaseId = await makeRelease('Hold');
    const req = (await releases.disposition(releaseId, { status: 'Approved' }, requester)) as { approvalId: number };

    // A request-only user can't approve.
    await expect(releases.approveDisposition(req.approvalId, {}, requester)).rejects.toThrow(/not permitted/);
    // Unknown id.
    await expect(releases.approveDisposition(999999, {}, approver)).rejects.toThrow(/not found/i);
    // Approve once, then a second approve fails (no longer pending).
    await releases.approveDisposition(req.approvalId, {}, approver);
    await expect(releases.approveDisposition(req.approvalId, {}, approver)).rejects.toThrow(/already approved/i);
  });

  it('forbids approving your own request (separation of duties)', async () => {
    const { releases } = services(prisma);
    // A user who can both request AND approve — but they still cannot approve a
    // request they themselves made. (Insert the PENDING row directly with this
    // actor as requester to reach the guard.)
    const role = await makeRole('LEAD', { canRequestApproval: true, canApproveChange: true });
    const actor = await makeUser('lead@test.local', [role]);
    const releaseId = await makeRelease('Hold');
    const appr = await prisma.approvalRequest.create({
      data: { kind: 'release.disposition', targetTable: 'Release', targetId: String(releaseId), payload: JSON.stringify({ status: 'Approved' }), requiredCapability: 'approveChange', state: 'PENDING', requestedById: actor.id, requestedByLabel: actor.label, requestedAt: new Date('2026-01-01T00:00:00Z') },
      select: { id: true },
    });
    await expect(releases.approveDisposition(Number(appr.id), {}, actor)).rejects.toThrow(/your own/i);
  });

  it('rejects a pending request (Release unchanged) and requires a reason', async () => {
    const { releases } = services(prisma);
    const requester = await makeUser('ops@test.local', [await makeRole('OPS', { canRequestApproval: true })]);
    const approver = await makeUser('qa@test.local', [await makeRole('QA', { canApproveChange: true })]);
    const releaseId = await makeRelease('Hold');
    const req = (await releases.disposition(releaseId, { status: 'Approved' }, requester)) as { approvalId: number };

    await expect(releases.rejectDisposition(req.approvalId, { reason: '' }, approver)).rejects.toThrow(/reason is required/i);
    const res = await releases.rejectDisposition(req.approvalId, { reason: 'Out of spec' }, approver);
    expect(res.state).toBe('REJECTED');
    const rel = (await prisma.release.findUnique({ where: { id: releaseId } }))!;
    expect(rel.status).toBe('Hold'); // unchanged
    const appr = (await prisma.approvalRequest.findUnique({ where: { id: BigInt(req.approvalId) } }))!;
    expect(appr.state).toBe('REJECTED');
    expect(appr.decisionReason).toBe('Out of spec');
  });

  it('a No-approval-required group enacts directly but cannot approve others’ requests', async () => {
    const { releases } = services(prisma);
    const exempt = await makeUser('exempt@test.local', [await makeRole('EXEMPT', { canRequestApproval: false, noApprovalRequired: true })]);
    const releaseId = await makeRelease('Hold');

    // noApprovalRequired alone routes to direct enact (no pending row).
    const res = (await releases.disposition(releaseId, { status: 'Approved' }, exempt)) as { pending?: boolean; status?: string };
    expect(res.pending).toBeUndefined();
    expect(res.status).toBe('Approved');
    expect((await prisma.release.findUnique({ where: { id: releaseId } }))!.status).toBe('Approved');
    expect(await prisma.approvalRequest.count({ where: { kind: 'release.disposition' } })).toBe(0);

    // But exemption does NOT confer approver authority over someone else's request.
    const requester = await makeUser('ops@test.local', [await makeRole('OPS', { canRequestApproval: true })]);
    const r2 = await makeRelease('Hold');
    const req = (await releases.disposition(r2, { status: 'Approved' }, requester)) as { approvalId: number };
    await expect(releases.approveDisposition(req.approvalId, {}, exempt)).rejects.toThrow(/not permitted/);
  });

  it('two concurrent approves enact exactly once (compare-and-swap on the pending state)', async () => {
    const { releases } = services(prisma);
    const requester = await makeUser('ops@test.local', [await makeRole('OPS', { canRequestApproval: true })]);
    const a1 = await makeUser('qa1@test.local', [await makeRole('QA1', { canApproveChange: true })]);
    const a2 = await makeUser('qa2@test.local', [await makeRole('QA2', { canApproveChange: true })]);
    const releaseId = await makeRelease('Hold');
    const req = (await releases.disposition(releaseId, { status: 'Approved' }, requester)) as { approvalId: number };

    const results = await Promise.allSettled([
      releases.approveDisposition(req.approvalId, {}, a1),
      releases.approveDisposition(req.approvalId, {}, a2),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // Enacted exactly once: a single approve audit row, one APPROVED terminal state.
    expect(await prisma.auditLog.count({ where: { action: 'release.disposition.approve' } })).toBe(1);
    expect((await prisma.approvalRequest.findUnique({ where: { id: BigInt(req.approvalId) } }))!.state).toBe('APPROVED');
  });

  it('signs the request (requester) and the approval (approver) when the secured item requires it', async () => {
    const { releases } = services(prisma);
    const auth = new AuthService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
    const pwHash = await auth.hashPassword('Sup3rSecret!!');
    await prisma.securedItem.update({ where: { key: 'release.disposition' }, data: { requireSignature: true } });

    const reqRole = await makeRole('OPS', { canRequestApproval: true });
    const apprRole = await makeRole('QA', { canApproveChange: true });
    const ru = await prisma.user.create({ data: { email: 'r@test.local', displayName: 'Requester', status: 'ACTIVE', passwordHash: pwHash, roles: { create: { roleId: reqRole } } }, select: { id: true, displayName: true } });
    const au = await prisma.user.create({ data: { email: 'a@test.local', displayName: 'Approver', status: 'ACTIVE', passwordHash: pwHash, roles: { create: { roleId: apprRole } } }, select: { id: true, displayName: true } });
    const requester: Actor = { id: ru.id, label: ru.displayName };
    const approver: Actor = { id: au.id, label: au.displayName };
    const releaseId = await makeRelease('Hold');

    const req = (await releases.disposition(releaseId, { status: 'Approved', password: 'Sup3rSecret!!' }, requester)) as { approvalId: number; signed: boolean };
    expect(req.signed).toBe(true);
    await releases.approveDisposition(req.approvalId, { password: 'Sup3rSecret!!' }, approver);

    const reqSig = await prisma.eSignature.findFirst({ where: { meaning: 'QA disposition request' } });
    expect(reqSig?.userId).toBe(requester.id);
    expect(reqSig?.masterTable).toBe('Release');
    const apprSig = await prisma.eSignature.findFirst({ where: { meaning: 'QA disposition approval' } });
    expect(apprSig?.userId).toBe(approver.id);
    expect(apprSig?.masterId).toBe(String(releaseId));
  });

  it('lists pending requests decorated with the lot / item context', async () => {
    const { releases } = services(prisma);
    const requester = await makeUser('ops@test.local', [await makeRole('OPS', { canRequestApproval: true })]);
    // Release -> Sublot -> Lot -> Item context for the queue.
    await prisma.item.create({ data: { id: 1, itemCode: 'WIDGET', description: 'Test widget', unit: 'ea' } });
    await prisma.lot.create({ data: { lot: 'L1', context: 'LOT', itemId: 1 } });
    await prisma.sublot.create({ data: { id: 10, lot: 'L1', sublotCode: 'L1', context: 'LOT' } });
    const releaseId = (await prisma.release.create({ data: { status: 'Hold', sublotId: 10 }, select: { id: true } })).id;

    await releases.disposition(releaseId, { status: 'Approved' }, requester);
    const list = await releases.listApprovals();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ releaseId, state: 'PENDING', requestedStatus: 'Approved', lot: 'L1', itemCode: 'WIDGET' });

    // An APPROVED/REJECTED filter excludes the pending one.
    expect((await releases.listApprovals('APPROVED')).rows).toHaveLength(0);
  });
});
