import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addItem, makePrisma, resetDb, services } from './support';

// Flow integration test: ItemTestsService (qa.itemTests) — the read-only viewer
// of item testing requirements (ItemTest), with formatted specifications.

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

async function addTest(itemId: number, data: { test: string; min?: number | null; max?: number | null; specification?: string | null; line?: number | null; onProduction?: boolean }) {
  await prisma.itemTest.create({
    data: { itemId, test: data.test, min: data.min ?? null, max: data.max ?? null, specification: data.specification ?? null, line: data.line ?? null, onProduction: data.onProduction ?? null },
  });
}

describe('ItemTestsService (qa.itemTests)', () => {
  it('returns an item\'s tests in line order with formatted specifications', async () => {
    await addItem(prisma, { id: 1, code: 'UV3305' });
    await addTest(1, { test: 'VISC', min: 28, max: 33, line: 2, onProduction: true });
    await addTest(1, { test: 'GRIND', max: 2, line: 1, onProduction: true });
    await addTest(1, { test: 'APPEARANCE', specification: 'Clear blue', line: 3 });
    const { itemTests } = services(prisma);

    const res = await itemTests.forItem(1);
    expect(res.item.itemCode).toBe('UV3305');
    expect(res.tests.map((t) => t.test)).toEqual(['GRIND', 'VISC', 'APPEARANCE']); // line order
    expect(res.tests.find((t) => t.test === 'VISC')!.specification).toBe('28 - 33');
    expect(res.tests.find((t) => t.test === 'GRIND')!.specification).toBe('- 2');
    expect(res.tests.find((t) => t.test === 'APPEARANCE')!.specification).toBe('Clear blue');
    expect(res.tests.find((t) => t.test === 'VISC')!.stages).toBe('Production');
  });

  it('404s an unknown item', async () => {
    const { itemTests } = services(prisma);
    await expect(itemTests.forItem(999)).rejects.toThrow(/not found/i);
  });

  it('item-options requires a term and returns only items that have tests, with a count', async () => {
    await addItem(prisma, { id: 1, code: 'TESTED' });
    await addItem(prisma, { id: 2, code: 'TESTEDTOO' });
    await addItem(prisma, { id: 3, code: 'UNTESTED' });
    await addTest(1, { test: 'A' });
    await addTest(1, { test: 'B' });
    // item 2 also matches "TESTED" but has no tests; item 3 has none either.
    const { itemTests } = services(prisma);

    expect((await itemTests.itemOptions('')).rows).toHaveLength(0); // term required
    const res = await itemTests.itemOptions('TESTED');
    expect(res.rows.map((r) => r.itemCode)).toEqual(['TESTED']); // only the one with tests
    expect(res.rows[0].testCount).toBe(2);
  });
});
