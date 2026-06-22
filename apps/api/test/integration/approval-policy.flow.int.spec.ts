import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../../src/approval/approval-policy.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import { makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the real ApprovalPolicyService against a real Postgres.
// Per-user-group (Role) approval capabilities — config for the approval engine
// (not yet enforced on a specific action).

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

async function addRole(code: string, name = code, isSystem = false): Promise<string> {
  const r = await prisma.role.create({ data: { code, name, isSystem }, select: { id: true } });
  return r.id;
}

const auditCount = (p: PrismaClient) => p.auditLog.count({ where: { action: 'approvalPolicy.set' } });

describe('ApprovalPolicyService (per-group approval capabilities)', () => {
  it('lists every group with the default policy when none is stored; orders system-first then name-asc', async () => {
    // Names chosen so the two sort rules DISAGREE: the system role's name sorts
    // LAST, so a passing order can only come from isSystem being the primary key.
    await addRole('SYS', 'Zzz System', true);
    await addRole('BBB', 'Bbb Group');
    await addRole('AAA', 'Aaa Group');
    const { approvalPolicy } = services(prisma);

    const res = await approvalPolicy.list();
    expect(res.capabilities).toEqual([
      'canRequestApproval', 'canApprove', 'canApproveUpdate', 'canApproveChange', 'canOverride', 'noApprovalRequired',
    ]);
    expect(res.rows).toHaveLength(3);
    // Primary isSystem:desc puts the system role first despite its name sorting last.
    expect(res.rows[0].code).toBe('SYS');
    // Secondary name:asc orders the non-system groups (Aaa before Bbb).
    expect(res.rows.slice(1).map((r) => r.code)).toEqual(['AAA', 'BBB']);
    for (const row of res.rows) {
      expect(row.customized).toBe(false);
      expect(row.policy).toEqual(DEFAULT_POLICY);
    }
  });

  it('sets a group policy, merges over the default, audits it, and flips customized', async () => {
    const roleId = await addRole('SUPERVISOR', 'Supervisor');
    const { approvalPolicy } = services(prisma);

    const r = await approvalPolicy.set(roleId, { canApprove: true, canOverride: true }, actor);
    expect(r.policy).toEqual({
      canRequestApproval: true, // default preserved (not supplied)
      canApprove: true,
      canApproveUpdate: false,
      canApproveChange: false,
      canOverride: true,
      noApprovalRequired: false,
    });

    const stored = (await prisma.roleApprovalPolicy.findUnique({ where: { roleId } }))!;
    expect(stored.canApprove).toBe(true);
    expect(stored.canOverride).toBe(true);
    expect(stored.canRequestApproval).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'approvalPolicy.set' }, include: { changes: true } });
    expect(audit).not.toBeNull();
    expect(audit!.summary).toContain('SUPERVISOR');
    expect(await auditCount(prisma)).toBe(1);
    // Field-level before/after: exactly the two flags that actually changed get a
    // change row (old 'false' -> new 'true'); an unsupplied default flag gets none.
    const changed = audit!.changes.filter((c) => c.tableName === 'role_approval_policy');
    expect(new Set(changed.map((c) => c.fieldName))).toEqual(new Set(['canApprove', 'canOverride']));
    for (const c of changed) {
      expect(c.recordId).toBe(roleId);
      expect(c.oldValue).toBe('false');
      expect(c.newValue).toBe('true');
    }

    const list = await approvalPolicy.list();
    expect(list.rows[0].customized).toBe(true);
    expect(list.rows[0].policy.canApprove).toBe(true);
  });

  it('applies a partial update without disturbing the other capabilities', async () => {
    const roleId = await addRole('QA_MANAGER', 'QA Manager');
    const { approvalPolicy } = services(prisma);

    await approvalPolicy.set(roleId, { canApprove: true, canOverride: true }, actor);
    // A second PUT touching only one flag must leave the earlier ones intact.
    const r = await approvalPolicy.set(roleId, { canApproveChange: true }, actor);
    expect(r.policy).toMatchObject({ canApprove: true, canOverride: true, canApproveChange: true });

    const stored = (await prisma.roleApprovalPolicy.findUnique({ where: { roleId } }))!;
    expect(stored.canApprove).toBe(true);
    expect(stored.canOverride).toBe(true);
    expect(stored.canApproveChange).toBe(true);
    expect(await auditCount(prisma)).toBe(2);
  });

  it('treats an unchanged set as a no-op (returns unchanged, writes no audit row)', async () => {
    const roleId = await addRole('OPERATOR', 'Operator');
    const { approvalPolicy } = services(prisma);

    await approvalPolicy.set(roleId, { canApprove: true }, actor);
    expect(await auditCount(prisma)).toBe(1);

    // Re-asserting the same value changes nothing.
    const r = await approvalPolicy.set(roleId, { canApprove: true }, actor);
    expect(r).toMatchObject({ unchanged: true });
    expect(await auditCount(prisma)).toBe(1);

    // Supplying only default-valued flags that are already at the default is also a no-op.
    const r2 = await approvalPolicy.set(roleId, { canRequestApproval: true }, actor);
    expect(r2).toMatchObject({ unchanged: true });
    expect(await auditCount(prisma)).toBe(1);
  });

  it('rejects setting a policy on an unknown role', async () => {
    const { approvalPolicy } = services(prisma);
    await expect(approvalPolicy.set('00000000-0000-0000-0000-000000000000', { canApprove: true }, actor)).rejects.toThrow(/Role not found/);
  });
});
