import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { EntitiesService } from '../../src/master-data/entities/entities.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { makePrisma, resetDb, seedActor } from './support';

// Flow integration test: entity role-flag management (§1 master data). Closes the
// Salesmen / Ship Via (carrier) gap — these flags are now settable on create and
// editable, and the role filter resolves them.

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

function entitiesService(): EntitiesService {
  const p = prisma as unknown as PrismaService;
  return new EntitiesService(p, new AuditService(p));
}

describe('EntitiesService role flags', () => {
  it('creates an entity with carrier + salesman flags and finds it by role filter', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const { id } = await svc.create({ entityCode: 'ACME', name: 'Acme Freight', isShipVia: true, isSalesman: true }, actor);

    const e = (await prisma.entity.findUnique({ where: { id } }))!;
    expect(e.isShipVia).toBe(true);
    expect(e.isSalesman).toBe(true);
    expect((await svc.list({ role: 'shipvia' })).rows.some((r) => r.id === id)).toBe(true);
    expect((await svc.list({ role: 'salesman' })).rows.some((r) => r.id === id)).toBe(true);
    expect((await svc.list({ role: 'supplier' })).rows.some((r) => r.id === id)).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'entity.create' } })).toBe(1);
  });

  it("updates an entity's role flags + status + terms, audited", async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    const { id } = await svc.create({ entityCode: 'X', isBillTo: true }, actor);

    await svc.update(id, { isShipVia: true, isBillTo: false, inactive: true, terms: 'NET30' }, actor);
    const e = (await prisma.entity.findUnique({ where: { id } }))!;
    expect(e.isShipVia).toBe(true);
    expect(e.isBillTo).toBe(false);
    expect(e.inactive).toBe(true);
    expect(e.terms).toBe('NET30');
    expect(await prisma.auditLog.count({ where: { action: 'entity.update' } })).toBe(1);
  });

  it('rejects a duplicate entity code and 404s an unknown update', async () => {
    const svc = entitiesService();
    const actor = await seedActor(prisma);
    await svc.create({ entityCode: 'DUP' }, actor);
    await expect(svc.create({ entityCode: 'DUP' }, actor)).rejects.toThrow(/already exists/i);
    await expect(svc.update(999999, { isSupplier: true }, actor)).rejects.toThrow(/not found/i);
  });
});
