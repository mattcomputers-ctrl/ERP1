import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: SecuredItemsService (admin.securedItems) — editing a
// secured item's response level + its per-group allow/witness grants.

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

async function makeItem(key: string, flags: Partial<{ requireReason: boolean; requireSignature: boolean; requireWitness: boolean; disabled: boolean }> = {}): Promise<string> {
  return (await prisma.securedItem.create({ data: { key, description: key, ...flags }, select: { id: true } })).id;
}
async function makeRole(code: string, isSystem = false): Promise<string> {
  return (await prisma.role.create({ data: { code, name: code, isSystem }, select: { id: true } })).id;
}

describe('SecuredItemsService (admin.securedItems)', () => {
  it('lists items and returns the per-group grant matrix', async () => {
    const { securedItems } = services(prisma);
    const id = await makeItem('order.complete', { requireSignature: true });
    const adminRole = await makeRole('ADMIN', true);
    await makeRole('OPS');
    await prisma.roleSecuredItem.create({ data: { roleId: adminRole, securedItemId: id, allow: true, allowWitness: true } });

    const list = await securedItems.list();
    expect(list.rows.find((r) => r.key === 'order.complete')!.requireSignature).toBe(true);

    const detail = await securedItems.get(id);
    expect(detail.grants).toHaveLength(2); // ADMIN + OPS
    const admin = detail.grants.find((g) => g.code === 'ADMIN')!;
    expect(admin).toMatchObject({ allow: true, allowWitness: true });
    expect(detail.grants.find((g) => g.code === 'OPS')!).toMatchObject({ allow: false, allowWitness: false });
  });

  it('updates response-level flags (only the supplied ones), audited, with a no-op short-circuit', async () => {
    const { securedItems } = services(prisma);
    const id = await makeItem('release.disposition', { requireSignature: true, requireReason: true });

    await securedItems.update(id, { requireWitness: true, requireReason: false }, actor);
    const row = (await prisma.securedItem.findUnique({ where: { id } }))!;
    expect(row.requireWitness).toBe(true);
    expect(row.requireReason).toBe(false);
    expect(row.requireSignature).toBe(true); // untouched
    expect(await prisma.auditLog.count({ where: { action: 'securedItem.update' } })).toBe(1);

    const r = await securedItems.update(id, { requireSignature: true }, actor);
    expect(r).toMatchObject({ unchanged: true });
    expect(await prisma.auditLog.count({ where: { action: 'securedItem.update' } })).toBe(1);
  });

  it('replaces grants (witness-only allowed), ignores all-false entries, rejects unknown roles', async () => {
    const { securedItems } = services(prisma);
    const id = await makeItem('order.complete');
    await makeRole('QA');
    await makeRole('SUP');

    await securedItems.setGrants(id, { grants: [
      { roleCode: 'QA', allow: true, allowWitness: true },
      { roleCode: 'SUP', allow: false, allowWitness: true }, // witness-only
    ] }, actor);
    let rows = await prisma.roleSecuredItem.findMany({ where: { securedItemId: id }, include: { role: true } });
    expect(rows.map((r) => r.role.code).sort()).toEqual(['QA', 'SUP']);
    expect(rows.find((r) => r.role.code === 'QA')).toMatchObject({ allow: true, allowWitness: true });
    expect(rows.find((r) => r.role.code === 'SUP')).toMatchObject({ allow: false, allowWitness: true });

    // Replace: only QA; an all-false SUP entry is ignored, and replace semantics drop the old SUP grant.
    await securedItems.setGrants(id, { grants: [{ roleCode: 'QA', allow: true }, { roleCode: 'SUP', allow: false, allowWitness: false }] }, actor);
    rows = await prisma.roleSecuredItem.findMany({ where: { securedItemId: id }, include: { role: true } });
    expect(rows.map((r) => r.role.code)).toEqual(['QA']);

    await expect(securedItems.setGrants(id, { grants: [{ roleCode: 'NOPE', allow: true }] }, actor)).rejects.toThrow(/Unknown role/);
  });

  it('404s an unknown secured item', async () => {
    const { securedItems } = services(prisma);
    await expect(securedItems.get('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/i);
    await expect(securedItems.update('00000000-0000-0000-0000-000000000000', { disabled: true }, actor)).rejects.toThrow(/not found/i);
  });
});
