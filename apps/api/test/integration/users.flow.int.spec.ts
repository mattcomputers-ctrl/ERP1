import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: UsersService.setRoles (group membership management) +
// the last-admin lockout guard, against a real Postgres.

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

async function makeRole(code: string, isSystem = false): Promise<string> {
  return (await prisma.role.create({ data: { code, name: code, isSystem }, select: { id: true } })).id;
}
async function makeUser(email: string, roleIds: string[] = [], status = 'ACTIVE'): Promise<string> {
  return (await prisma.user.create({ data: { email, displayName: email, status: status as 'ACTIVE' | 'DISABLED', roles: { create: roleIds.map((roleId) => ({ roleId })) } }, select: { id: true } })).id;
}

describe('UsersService.setRoles', () => {
  it('replaces a user\'s group membership and audits it', async () => {
    const { users } = services(prisma);
    const a = await makeRole('A');
    const b = await makeRole('B');
    const c = await makeRole('C');
    const userId = await makeUser('u@test.local', [a]);

    await users.setRoles(userId, { roleCodes: ['B', 'C'] }, actor);
    const roles = await prisma.userRole.findMany({ where: { userId }, include: { role: true } });
    expect(roles.map((r) => r.role.code).sort()).toEqual(['B', 'C']);
    expect(await prisma.auditLog.count({ where: { action: 'user.set_roles' } })).toBe(1);

    // A no-op (same set) writes no audit row.
    const r = await users.setRoles(userId, { roleCodes: ['C', 'B'] }, actor);
    expect(r).toMatchObject({ unchanged: true });
    expect(await prisma.auditLog.count({ where: { action: 'user.set_roles' } })).toBe(1);
  });

  it('rejects an unknown role code', async () => {
    const { users } = services(prisma);
    const userId = await makeUser('u@test.local');
    await expect(users.setRoles(userId, { roleCodes: ['NOPE'] }, actor)).rejects.toThrow(/Unknown role/);
  });

  it('refuses to remove the last holder of a system role, but allows it when another holder exists', async () => {
    const { users } = services(prisma);
    const adminRole = await makeRole('ADMIN', true);
    const plain = await makeRole('PLAIN');
    const onlyAdmin = await makeUser('admin1@test.local', [adminRole]);

    // Removing ADMIN from the sole admin is refused.
    await expect(users.setRoles(onlyAdmin, { roleCodes: ['PLAIN'] }, actor)).rejects.toThrow(/last active administrator/i);

    // A DISABLED second admin does NOT count (it can't log in) — still refused.
    await makeUser('disabled@test.local', [adminRole], 'DISABLED');
    await expect(users.setRoles(onlyAdmin, { roleCodes: ['PLAIN'] }, actor)).rejects.toThrow(/last active administrator/i);

    // An ACTIVE second admin DOES count — the first can now be moved off ADMIN.
    await makeUser('admin2@test.local', [adminRole]);
    await users.setRoles(onlyAdmin, { roleCodes: ['PLAIN'] }, actor);
    const roles = await prisma.userRole.findMany({ where: { userId: onlyAdmin }, include: { role: true } });
    expect(roles.map((r) => r.role.code)).toEqual(['PLAIN']);
  });

  it('lists role options (system role first)', async () => {
    const { users } = services(prisma);
    await makeRole('ADMIN', true);
    await makeRole('OPS');
    const opts = await users.roleOptions();
    expect(opts.rows[0].code).toBe('ADMIN');
    expect(opts.rows.map((r) => r.code)).toContain('OPS');
  });
});
