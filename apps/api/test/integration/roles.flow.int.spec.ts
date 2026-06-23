import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: RolesService (the admin.roles surface) against a real
// Postgres — create groups + grant Programs, the unblocker for using RBAC + the
// approval engine with non-ADMIN groups.

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

async function addProgram(key: string, name = key, folder: string | null = null): Promise<string> {
  return (await prisma.program.create({ data: { key, name, folder }, select: { id: true } })).id;
}
async function makeRole(code: string, name = code, isSystem = false): Promise<string> {
  return (await prisma.role.create({ data: { code, name, isSystem }, select: { id: true } })).id;
}

describe('RolesService (admin.roles)', () => {
  it('creates a non-system role (audited) and rejects a duplicate code', async () => {
    const { roles } = services(prisma);
    const r = await roles.create({ code: 'QA', name: 'Quality' }, actor);
    expect(r.code).toBe('QA');
    const row = (await prisma.role.findUnique({ where: { id: r.id } }))!;
    expect(row.isSystem).toBe(false);
    expect(row.name).toBe('Quality');
    expect(await prisma.auditLog.count({ where: { action: 'role.create' } })).toBe(1);

    await expect(roles.create({ code: 'QA', name: 'dup' }, actor)).rejects.toThrow(/already exists/);
    // Blank-after-trim code/name are rejected (the API is the security boundary).
    await expect(roles.create({ code: '   ', name: 'x' }, actor)).rejects.toThrow(/required/i);
  });

  it('lists roles with user + program counts, system role first', async () => {
    const { roles } = services(prisma);
    const adminId = await makeRole('ADMIN', 'Administrator', true);
    const p1 = await addProgram('p1');
    await addProgram('p2');
    await prisma.roleProgram.create({ data: { roleId: adminId, programId: p1, allow: true } });
    await makeRole('OPS', 'Operators');

    const res = await roles.list();
    expect(res.rows[0].code).toBe('ADMIN'); // isSystem desc sorts it first
    const admin = res.rows.find((r) => r.code === 'ADMIN')!;
    expect(admin.isSystem).toBe(true);
    expect(admin.programCount).toBe(1);
    expect(res.rows.find((r) => r.code === 'OPS')!.programCount).toBe(0);
  });

  it('get returns the full program catalogue with this role\'s grant flags', async () => {
    const { roles } = services(prisma);
    const a = await addProgram('a', 'A', 'Folder');
    await addProgram('b', 'B', 'Folder');
    const id = await makeRole('OPS');
    await prisma.roleProgram.create({ data: { roleId: id, programId: a, allow: true } });

    const r = await roles.get(id);
    expect(r.programs).toHaveLength(2);
    expect(r.programs.find((p) => p.key === 'a')!.granted).toBe(true);
    expect(r.programs.find((p) => p.key === 'b')!.granted).toBe(false);
  });

  it('replaces a role\'s program grants and rejects unknown keys', async () => {
    const { roles } = services(prisma);
    await addProgram('a');
    await addProgram('b');
    await addProgram('c');
    const id = await makeRole('OPS');

    await roles.setPrograms(id, { programKeys: ['a', 'b'] }, actor);
    expect(await prisma.roleProgram.count({ where: { roleId: id } })).toBe(2);

    // Replacing with a smaller set drops the others.
    await roles.setPrograms(id, { programKeys: ['c'] }, actor);
    const grants = await prisma.roleProgram.findMany({ where: { roleId: id }, include: { program: true } });
    expect(grants.map((g) => g.program.key)).toEqual(['c']);

    await expect(roles.setPrograms(id, { programKeys: ['nope'] }, actor)).rejects.toThrow(/Unknown program/);
    expect(await prisma.auditLog.count({ where: { action: 'role.setPrograms' } })).toBe(2);

    // The audit row captures what was revoked (before) -> granted (after).
    const lastAudit = (await prisma.auditLog.findFirst({ where: { action: 'role.setPrograms' }, orderBy: { id: 'desc' }, include: { changes: true } }))!;
    const ch = lastAudit.changes.find((c) => c.fieldName === 'programs')!;
    expect(ch.oldValue).toBe('a, b');
    expect(ch.newValue).toBe('c');
  });

  it('protects system roles from program edits, updates, and deletion', async () => {
    const { roles } = services(prisma);
    const sysId = await makeRole('ADMIN', 'Administrator', true);
    await addProgram('a');
    await expect(roles.setPrograms(sysId, { programKeys: ['a'] }, actor)).rejects.toThrow(/system role/i);
    await expect(roles.update(sysId, { name: 'x' }, actor)).rejects.toThrow(/cannot be modified/i);
    await expect(roles.remove(sysId, actor)).rejects.toThrow(/cannot be deleted/i);
  });

  it('updates name/description and treats an empty update as a no-op', async () => {
    const { roles } = services(prisma);
    const id = await makeRole('OPS', 'Operators');
    await roles.update(id, { name: 'Shop Floor', description: 'Line operators' }, actor);
    const row = (await prisma.role.findUnique({ where: { id } }))!;
    expect(row.name).toBe('Shop Floor');
    expect(row.description).toBe('Line operators');

    const r = await roles.update(id, {}, actor);
    expect(r).toMatchObject({ unchanged: true });
  });

  it('deletes a non-system role with no users (cascading grants) but refuses if users are assigned', async () => {
    const { roles } = services(prisma);
    await addProgram('a');
    const id = await makeRole('TEMP');
    await roles.setPrograms(id, { programKeys: ['a'] }, actor);
    await prisma.user.create({ data: { email: 'u@test.local', displayName: 'U', roles: { create: { roleId: id } } } });

    await expect(roles.remove(id, actor)).rejects.toThrow(/users assigned/);

    await prisma.userRole.deleteMany({ where: { roleId: id } });
    await roles.remove(id, actor);
    expect(await prisma.role.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.roleProgram.count({ where: { roleId: id } })).toBe(0); // cascaded
  });
});
