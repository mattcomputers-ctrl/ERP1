import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addItem, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the EDITABLE ItemTest (QA master data). Add / update /
// remove an item's QC test requirements — the rows that drive native order QC
// specs + the CofA. Native ids (≥ 1e9) so a later legacy re-import can't clobber.

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

describe('ItemTestsService editing', () => {
  it('adds a test requirement with a native id + the next line, then lists it', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET' });

    const res = await itemTests.addTest(1, { test: 'Viscosity', min: 28, max: 33, onProduction: true }, actor);
    expect(res.testId).toBeGreaterThanOrEqual(1_000_000_000);
    expect(res.line).toBe(1);
    const view = await itemTests.forItem(1);
    expect(view.tests).toHaveLength(1);
    expect(view.tests[0]).toMatchObject({ test: 'Viscosity', specification: '28 - 33', onProduction: true, stages: 'Production' });
    expect(await prisma.auditLog.count({ where: { action: 'qa.itemTest.add' } })).toBe(1);

    // A second add takes the next line.
    const res2 = await itemTests.addTest(1, { test: 'Gloss', specification: 'pass' }, actor);
    expect(res2.line).toBe(2);
  });

  it('updates only the supplied fields (partial); a no-op short-circuits; audited', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET' });
    const { testId } = await itemTests.addTest(1, { test: 'Gloss', max: 90, onProduction: true }, actor);

    await itemTests.updateTest(1, testId, { min: 85, grade: 'A' }, actor);
    const row = (await prisma.itemTest.findUnique({ where: { id: testId } }))!;
    expect(row.min).toBe(85);
    expect(row.max).toBe(90); // untouched
    expect(row.grade).toBe('A');
    expect(row.test).toBe('Gloss'); // untouched
    expect(await prisma.auditLog.count({ where: { action: 'qa.itemTest.update' } })).toBe(1);

    const noop = (await itemTests.updateTest(1, testId, { grade: 'A' }, actor)) as { unchanged?: boolean };
    expect(noop.unchanged).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'qa.itemTest.update' } })).toBe(1); // no new audit
  });

  it('clears a previously-set field when sent null, and accepts a 0 value (not a clear)', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET' });
    const { testId } = await itemTests.addTest(1, { test: 'Gloss', min: 5, max: 90, grade: 'A' }, actor);

    // null clears max + grade (the web's edit affordance); min set to 0 is kept.
    await itemTests.updateTest(1, testId, { max: null as unknown as undefined, grade: null as unknown as undefined, min: 0 }, actor);
    const row = (await prisma.itemTest.findUnique({ where: { id: testId } }))!;
    expect(row.max).toBeNull();
    expect(row.grade).toBeNull();
    expect(row.min).toBe(0); // 0 is a real value, not a clear
    // formatSpec recomputes: min 0 only -> "0 -"
    const view = await itemTests.forItem(1);
    expect(view.tests[0].specification).toBe('0 -');
  });

  it('removes a test requirement (audited)', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET' });
    const { testId } = await itemTests.addTest(1, { test: 'Purity', min: 99 }, actor);

    await itemTests.removeTest(1, testId, actor);
    expect(await prisma.itemTest.count({ where: { itemId: 1 } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'qa.itemTest.remove' } })).toBe(1);
  });

  it('rejects a blank name, an unknown item, and cross-item edits (IDOR)', async () => {
    const { itemTests } = services(prisma);
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 1, code: 'A' });
    await addItem(prisma, { id: 2, code: 'B' });
    const { testId } = await itemTests.addTest(1, { test: 'X' }, actor);

    await expect(itemTests.addTest(1, { test: '   ' }, actor)).rejects.toThrow(/test name is required/i);
    await expect(itemTests.updateTest(1, testId, { test: '  ' }, actor)).rejects.toThrow(/cannot be blank/i);
    await expect(itemTests.addTest(999, { test: 'X' }, actor)).rejects.toThrow(/item not found/i);
    // The test belongs to item 1, so editing it via item 2 is refused.
    await expect(itemTests.updateTest(2, testId, { min: 1 }, actor)).rejects.toThrow(/not on item/i);
    await expect(itemTests.removeTest(2, testId, actor)).rejects.toThrow(/not on item/i);
  });
});
