import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addItem, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the Test-catalog admin (qa.testCatalogEdit) — CRUD on
// the master `Test` table the test-name pickers offer. Natural-key PK (the NAME),
// so no native-id range: uniqueness is case-insensitive and deletes are guarded
// by ItemTest references (order/sample snapshots link by copied name — not a guard,
// matching legacy Test Update semantics).

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

async function addGroup(name: string, description?: string) {
  await prisma.testGroup.create({ data: { testGroup: name, description: description ?? null } });
}

describe('Test-catalog admin (qa.testCatalogEdit)', () => {
  it('adds a catalog test (trimmed, prototype explicit false, version 0); audited', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT', 'Lot sampling');

    const res = await itemTests.addCatalogTest(
      { test: '  BROOKFIELD #4  ', description: 'Viscosity @20RPM', testResultType: 'NUM', precision: 2, testGroup: 'LOT', unit: 'CPS' },
      actor,
    );
    expect(res.test).toBe('BROOKFIELD #4');

    const row = await prisma.test.findUnique({ where: { test: 'BROOKFIELD #4' } });
    expect(row).toMatchObject({ description: 'Viscosity @20RPM', testResultType: 'NUM', precision: 2, testGroup: 'LOT', unit: 'CPS', prototype: false, version: 0 });
    expect(await prisma.auditLog.count({ where: { action: 'qa.testCatalog.add' } })).toBe(1);
  });

  it('refuses a duplicate name case-insensitively, a missing group, an unknown group, and precision on BOOL', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT');
    await itemTests.addCatalogTest({ test: 'pH', testResultType: 'NUM', testGroup: 'LOT' }, actor);

    await expect(itemTests.addCatalogTest({ test: 'PH', testResultType: 'NUM', testGroup: 'LOT' }, actor)).rejects.toThrow(/already exists/i);
    await expect(itemTests.addCatalogTest({ test: 'GRIND', testResultType: 'NUM', testGroup: '' }, actor)).rejects.toThrow(/test group is required/i);
    await expect(itemTests.addCatalogTest({ test: 'GRIND', testResultType: 'NUM', testGroup: 'NOPE' }, actor)).rejects.toThrow(/does not exist/i);
    await expect(itemTests.addCatalogTest({ test: 'ODOR', testResultType: 'BOOL', precision: 2, testGroup: 'LOT' }, actor)).rejects.toThrow(/numeric/i);
    expect(await prisma.test.count()).toBe(1);
  });

  it('updates only supplied fields; switching to BOOL clears precision; no-op short-circuits; audited', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT');
    await addGroup('BATCH');
    await itemTests.addCatalogTest({ test: 'VISC', description: 'Laray', testResultType: 'NUM', precision: 1, testGroup: 'LOT' }, actor);

    await itemTests.updateCatalogTest('VISC', { description: 'Laray falling rod', testGroup: 'BATCH' }, actor);
    let row = await prisma.test.findUnique({ where: { test: 'VISC' } });
    expect(row).toMatchObject({ description: 'Laray falling rod', testGroup: 'BATCH', testResultType: 'NUM', precision: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'qa.testCatalog.update' } })).toBe(1);

    // Same values again — no-op, no new audit row.
    const noop = (await itemTests.updateCatalogTest('VISC', { description: 'Laray falling rod' }, actor)) as { unchanged?: boolean };
    expect(noop.unchanged).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'qa.testCatalog.update' } })).toBe(1);

    // Flip to BOOL — stored precision must clear with it.
    await itemTests.updateCatalogTest('VISC', { testResultType: 'BOOL' }, actor);
    row = await prisma.test.findUnique({ where: { test: 'VISC' } });
    expect(row).toMatchObject({ testResultType: 'BOOL', precision: null });

    // Explicit-null result type is refused (the @IsOptional-null trap re-assert).
    await expect(itemTests.updateCatalogTest('VISC', { testResultType: null as unknown as string }, actor)).rejects.toThrow(/cannot be cleared/i);
    await expect(itemTests.updateCatalogTest('NOPE', { description: 'x' }, actor)).rejects.toThrow(/not in the catalog/i);
  });

  it('refuses removing a test referenced by ItemTest (case-insensitive); removes cleanly once unreferenced; audited', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT');
    await addItem(prisma, { id: 1, code: 'WIDGET' });
    await itemTests.addCatalogTest({ test: 'GLOSS', testResultType: 'NUM', testGroup: 'LOT' }, actor);
    const { testId } = await itemTests.addTest(1, { test: 'gloss', max: 90 }, actor); // links by name, case differs

    await expect(itemTests.removeCatalogTest('GLOSS', actor)).rejects.toThrow(/1 item test requirement/i);

    await itemTests.removeTest(1, testId, actor);
    const res = await itemTests.removeCatalogTest('GLOSS', actor);
    expect(res.removed).toBe(true);
    expect(await prisma.test.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'qa.testCatalog.remove' } })).toBe(1);
  });

  it('explicit prototype:null is coerced to false, never stored as NULL (boolean mirror convention)', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT');
    await itemTests.addCatalogTest({ test: 'VISC', testResultType: 'NUM', testGroup: 'LOT', prototype: true }, actor);

    // @IsOptional skips validators on explicit null, so null reaches the service.
    await itemTests.updateCatalogTest('VISC', { prototype: null as unknown as boolean }, actor);
    const row = await prisma.test.findUnique({ where: { test: 'VISC' } });
    expect(row!.prototype).toBe(false); // not NULL
  });

  it('the delete guard matches whitespace-padded ItemTest references; a double remove 404s', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT');
    await addItem(prisma, { id: 1 });
    await itemTests.addCatalogTest({ test: 'GRIND', testResultType: 'NUM', testGroup: 'LOT' }, actor);
    // Reference with padding + different case — the guard must still catch it.
    await prisma.itemTest.create({ data: { itemId: 1, test: ' grind ' } });

    await expect(itemTests.removeCatalogTest('GRIND', actor)).rejects.toThrow(/1 item test requirement/i);

    await prisma.itemTest.deleteMany({ where: { itemId: 1 } });
    await itemTests.removeCatalogTest('GRIND', actor);
    await expect(itemTests.removeCatalogTest('GRIND', actor)).rejects.toThrow(/not in the catalog/i); // 404, not a P2025 500
  });

  it('catalog() lists rows alphabetically with case-insensitive usage counts + the group options', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addGroup('LOT', 'Lot sampling');
    await addItem(prisma, { id: 1 });
    await addItem(prisma, { id: 2 });
    await itemTests.addCatalogTest({ test: 'VISC', testResultType: 'NUM', testGroup: 'LOT' }, actor);
    await itemTests.addCatalogTest({ test: 'APPEARANCE', testResultType: 'BOOL', testGroup: 'LOT' }, actor);
    await itemTests.addTest(1, { test: 'visc' }, actor);
    await itemTests.addTest(2, { test: 'VISC' }, actor);

    const res = await itemTests.catalog();
    expect(res.rows.map((r) => r.test)).toEqual(['APPEARANCE', 'VISC']);
    expect(res.rows.find((r) => r.test === 'VISC')!.usedBy).toBe(2);
    expect(res.rows.find((r) => r.test === 'APPEARANCE')!.usedBy).toBe(0);
    expect(res.groups).toEqual([{ testGroup: 'LOT', description: 'Lot sampling' }]);
  });
});
