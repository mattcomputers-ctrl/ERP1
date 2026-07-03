import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addItem, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the ingredient mass-REPLACEMENT tool (legacy
// RecipeReplacement*) rebuilt on the native lifecycle — per selected recipe:
// clone to the next .NN, swap the ingredient, publish (single-active rule
// deactivates the source). Per-row failures don't abort the job.

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
  const item = await prisma.securedItem.create({ data: { key: 'recipe.publish' } });
  const role = await prisma.role.create({ data: { code: 'PUBLISHER', name: 'Publisher' }, select: { id: true } });
  await prisma.roleSecuredItem.create({ data: { roleId: role.id, securedItemId: item.id, allow: true } });
  await prisma.user.update({ where: { id: actor.id }, data: { roles: { create: { roleId: role.id } } } });
});

const PROD_A = 601;
const PROD_B = 602;
const OLD_RESIN = 611;
const NEW_RESIN = 612;
const FILLER = 613;

async function seedRecipes(svc: ReturnType<typeof services>) {
  await addItem(prisma, { id: PROD_A, code: 'INK-A' });
  await addItem(prisma, { id: PROD_B, code: 'INK-B' });
  await addItem(prisma, { id: OLD_RESIN, code: 'RES-OLD' });
  await addItem(prisma, { id: NEW_RESIN, code: 'RES-NEW' });
  await addItem(prisma, { id: FILLER, code: 'FILLER' });

  const a = await svc.recipeEditor.create(
    { context: 'RMBA', recipeNumber: 'INKA.01', productItemId: PROD_A, comment: 'NEW' }, actor,
  );
  await svc.recipeEditor.saveProcedure(a.id, {
    basis: 100,
    lines: [
      { kind: 'ingredient', itemId: OLD_RESIN, qty: 70 },
      { kind: 'ingredient', itemId: FILLER, qty: 30 },
    ],
  }, actor);
  await svc.recipeEditor.publish(a.id, {}, actor);

  const b = await svc.recipeEditor.create(
    { context: 'RMBA', recipeNumber: 'INKB.01', productItemId: PROD_B, comment: 'NEW' }, actor,
  );
  await svc.recipeEditor.saveProcedure(b.id, {
    basis: 100,
    lines: [{ kind: 'ingredient', itemId: OLD_RESIN, qty: 55 }, { kind: 'ingredient', itemId: FILLER, qty: 45 }],
  }, actor);
  await svc.recipeEditor.publish(b.id, {}, actor);

  // A recipe that does NOT use the old resin — must not appear in the preview.
  const c = await svc.recipeEditor.create(
    { context: 'RMBA', recipeNumber: 'CLEAN.01', productItemId: PROD_A, comment: 'NEW' }, actor,
  );
  await svc.recipeEditor.saveProcedure(c.id, {
    basis: 100, lines: [{ kind: 'ingredient', itemId: FILLER, qty: 100 }],
  }, actor);

  return { a: a.id, b: b.id, c: c.id };
}

describe('recipe ingredient replacement', () => {
  it('previews the active recipes using the ingredient', async () => {
    const svc = services(prisma);
    await seedRecipes(svc);
    const preview = await svc.recipeReplacement.preview(OLD_RESIN);
    expect(preview.rows.map((r) => r.recipeNumber).sort()).toEqual(['INKA.01', 'INKB.01']);
    const inkA = preview.rows.find((r) => r.recipeNumber === 'INKA.01')!;
    expect(inkA.productCode).toBe('INK-A');
    expect(inkA.qtyPerUnit).toBeCloseTo(0.7, 9);
  });

  it('clones, swaps, and publishes new revisions; the old ones deactivate; failures are per-row', async () => {
    const svc = services(prisma);
    const ids = await seedRecipes(svc);

    const out = await svc.recipeReplacement.run(
      {
        fromItemId: OLD_RESIN,
        toItemId: NEW_RESIN,
        // Include the non-user recipe deliberately: it must fail per-row
        // without aborting the other two.
        recipeIds: [ids.a, ids.b, ids.c],
        description: 'RES-OLD to RES-NEW',
        publish: true,
      },
      actor,
    );

    const byNumber = new Map(out.results.map((r) => [r.recipeNumber, r]));
    expect(byNumber.get('INKA.01')).toMatchObject({ newRecipeNumber: 'INKA.02', published: true, replacedLines: 1, error: null });
    expect(byNumber.get('INKB.01')).toMatchObject({ newRecipeNumber: 'INKB.02', published: true, replacedLines: 1, error: null });
    expect(byNumber.get('CLEAN.01')!.error).toMatch(/Only active published|Does not use/);

    // Old revisions superseded; new revisions carry the new resin at the SAME qty.
    const oldA = await prisma.recipe.findUniqueOrThrow({ where: { id: ids.a } });
    expect(oldA.inactive).toBe(true);
    const newA = await prisma.recipe.findFirstOrThrow({ where: { recipeNumber: 'INKA.02' } });
    expect(newA.isPublished).toBe(true);
    expect(newA.inactive).toBe(false);
    expect(newA.comment).toBe('RES-OLD to RES-NEW');
    const newALines = await prisma.recipeDetail.findMany({ where: { recipeId: newA.id, context: 'UI' } });
    expect(newALines.map((l) => l.itemId).sort()).toEqual([NEW_RESIN, FILLER].sort());
    expect(newALines.find((l) => l.itemId === NEW_RESIN)!.qtyReqd).toBeCloseTo(0.7, 9);
    // The untouched filler line is preserved verbatim.
    expect(newALines.find((l) => l.itemId === FILLER)!.qtyReqd).toBeCloseTo(0.3, 9);

    // The job + per-recipe operations are audited.
    expect(await prisma.auditLog.count({ where: { action: 'recipe.replacement' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'recipe.replaceIngredient' } })).toBe(2);

    // The order picker now offers only the new revisions.
    const options = await svc.orders.recipeOptions('INK');
    expect(options.rows.map((r) => r.recipeNumber).sort()).toEqual(['INKA.02', 'INKB.02']);
  });

  it('leaves drafts (no publish) when asked, and validates inputs', async () => {
    const svc = services(prisma);
    const ids = await seedRecipes(svc);

    await expect(
      svc.recipeReplacement.run({ fromItemId: OLD_RESIN, toItemId: OLD_RESIN, recipeIds: [ids.a] }, actor),
    ).rejects.toThrow(/must differ/);

    const out = await svc.recipeReplacement.run(
      { fromItemId: OLD_RESIN, toItemId: NEW_RESIN, recipeIds: [ids.a], publish: false },
      actor,
    );
    expect(out.results[0]).toMatchObject({ newRecipeNumber: 'INKA.02', published: false, error: null });
    const draft = await prisma.recipe.findFirstOrThrow({ where: { recipeNumber: 'INKA.02' } });
    expect(draft.isPublished).toBe(false);
    // Source stays active until the draft is published.
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id: ids.a } })).inactive).toBe(false);
  });
});
