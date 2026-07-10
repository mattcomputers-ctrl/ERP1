import type { PrismaClient } from '@erp1/db';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { buildHttpApp, hashPassword, loginAgent, seedUserWithPrograms } from './http-support';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addPriceDetail,
  addPriceVersion,
  addSublot,
  grantAllSecuredItems,
  makePrisma,
  resetDb,
  seedActor,
  services,
} from './support';

// Costing & documents bundle (L75 + L153 + L64): sub-recipe expected-cost
// rollup (CostingRecipe resolve-to-active + recursion + ReplacementCost
// fallback), document branding (company logo setting -> session-only
// /settings/branding), and the container/lot label endpoint.

const PASSWORD = 'Sup3rSecretPw!';

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
  // Relaxed publish gate for recipe fixtures (L22 enforces the perform grant).
  await prisma.securedItem.create({ data: { key: 'recipe.publish' } });
  await grantAllSecuredItems(prisma, actor.id);
});

const PROD = 1;
const SUB = 2; // made intermediate (costing recipe)
const RAW = 3; // supplier-priced
const RAW2 = 4; // priced only via ReplacementCost
const NOPRICE = 5; // priced nowhere

/** An active published RMBA recipe with the given per-1-lb UI lines. */
async function publishedRecipe(svc: ReturnType<typeof services>, recipeNumber: string, productItemId: number, lines: { itemId: number; qty: number }[]) {
  const draft = await svc.recipeEditor.create({ context: 'RMBA', recipeNumber, productItemId, comment: 'NEW' }, actor);
  await svc.recipeEditor.saveProcedure(
    draft.id,
    { basis: 100, lines: lines.map((l) => ({ kind: 'ingredient' as const, itemId: l.itemId, qty: l.qty })) },
    actor,
  );
  await svc.recipeEditor.publish(draft.id, {}, actor);
  return draft.id;
}

describe('L75 — sub-recipe expected-cost rollup', () => {
  async function seedCosting(svc: ReturnType<typeof services>) {
    await addItem(prisma, { id: PROD, code: 'PROD' });
    await addItem(prisma, { id: SUB, code: 'SUB' });
    await addItem(prisma, { id: RAW, code: 'RAW' });
    await addItem(prisma, { id: RAW2, code: 'RAW2' });
    // RAW: one supplier, flat $2/lb. RAW2: replacement cost $3/lb only.
    await addEntity(prisma, { id: 50, code: 'SUP1', isSupplier: true });
    await addPriceVersion(prisma, { id: 500, entityId: 50, effectiveDate: new Date(Date.now() - 86_400_000) });
    await addPriceDetail(prisma, { id: 5000, priceVersionId: 500, itemId: RAW, minOrder1: 0, price1: 2 });
    // The legacy import stamps an explicit StandardCost of 0 on thousands of
    // items — 0 is NOT a price and must not shadow the replacement fallback
    // (review §26 major).
    await prisma.item.update({ where: { id: RAW2 }, data: { standardCost: 0, replacementCost: 3 } });

    // SUB is MADE: its costing recipe uses 0.5 lb RAW per 1 lb of SUB.
    const subRecipeId = await publishedRecipe(svc, 'SUBR.01', SUB, [{ itemId: RAW, qty: 50 }]); // 50 per 100 lb = 0.5/lb
    await prisma.item.update({ where: { id: SUB }, data: { costingRecipeId: subRecipeId } });

    // Parent: 0.4 lb SUB + 0.6 lb RAW2 per lb.
    const parentId = await publishedRecipe(svc, 'PAR.01', PROD, [
      { itemId: SUB, qty: 40 },
      { itemId: RAW2, qty: 60 },
    ]);
    return { parentId, subRecipeId };
  }

  it('rolls an unpriced made ingredient up from its ACTIVE costing recipe; ReplacementCost is the terminal fallback', async () => {
    const svc = services(prisma);
    const { parentId } = await seedCosting(svc);

    const p = await svc.recipes.pricing(parentId, 100);
    const sub = p.rows.find((r) => r.itemId === SUB)!;
    // 40 lb SUB needed -> 20 lb RAW in the sub-recipe -> 20 × $2 = $40.
    expect(sub.source).toBe('subRecipe');
    expect(sub.costingRecipeNumber).toBe('SUBR.01');
    expect(sub.totalCost).toBeCloseTo(40, 9);
    expect(sub.unitPrice).toBeCloseTo(1, 9); // $40 / 40 lb

    const raw2 = p.rows.find((r) => r.itemId === RAW2)!;
    expect(raw2.source).toBe('replacement');
    expect(raw2.totalCost).toBeCloseTo(60 * 3, 9);

    expect(p.totals.unpriced).toBe(0);
    expect(p.totals.expected).toBeCloseTo(40 + 180, 9);
  });

  it('a stale CostingRecipe pointer resolves to the ACTIVE revision of the family', async () => {
    const svc = services(prisma);
    const { parentId, subRecipeId } = await seedCosting(svc);

    // Publish SUBR.02 with double the RAW content — the .01 pointer must lag-resolve to .02.
    const clone = await svc.recipeEditor.clone(subRecipeId, { comment: 'rev' }, actor);
    await svc.recipeEditor.saveProcedure(clone.id, { basis: 100, lines: [{ kind: 'ingredient', itemId: RAW, qty: 100 }] }, actor);
    await svc.recipeEditor.publish(clone.id, {}, actor); // deactivates .01 (single-active)

    const p = await svc.recipes.pricing(parentId, 100);
    const sub = p.rows.find((r) => r.itemId === SUB)!;
    expect(sub.source).toBe('subRecipe');
    expect(sub.costingRecipeNumber).toBe('SUBR.02');
    expect(sub.totalCost).toBeCloseTo(40 * 1 * 2, 9); // 40 lb × 1.0 RAW/lb × $2
  });

  it('is all-or-nothing per sub-recipe and cycle-guarded', async () => {
    const svc = services(prisma);
    await addItem(prisma, { id: PROD, code: 'PROD' });
    await addItem(prisma, { id: SUB, code: 'SUB' });
    await addItem(prisma, { id: NOPRICE, code: 'NOPRICE' });

    // SUB's recipe uses an item priced NOWHERE -> the SUB line stays unpriced.
    const subRecipeId = await publishedRecipe(svc, 'SUBX.01', SUB, [{ itemId: NOPRICE, qty: 100 }]);
    await prisma.item.update({ where: { id: SUB }, data: { costingRecipeId: subRecipeId } });
    const parentId = await publishedRecipe(svc, 'PARX.01', PROD, [{ itemId: SUB, qty: 100 }]);

    const p = await svc.recipes.pricing(parentId, 100);
    expect(p.rows.find((r) => r.itemId === SUB)!.source).toBeNull();
    expect(p.totals.unpriced).toBe(1);

    // Cycle: point NOPRICE's costing recipe back at the PARENT (PROD ∈ its own
    // chain via SUB -> NOPRICE -> parent). Must terminate, still unpriced.
    await prisma.item.update({ where: { id: NOPRICE }, data: { costingRecipeId: parentId } });
    const p2 = await svc.recipes.pricing(parentId, 100);
    expect(p2.rows.find((r) => r.itemId === SUB)!.totalCost).toBeNull();
  });
});

describe('L153 + L64 over HTTP — branding + container label', () => {
  let app: NestExpressApplication;
  let passwordHash: string;

  beforeAll(async () => {
    app = await buildHttpApp(prisma);
    passwordHash = await hashPassword(prisma, PASSWORD);
  });
  afterAll(async () => {
    await app.close();
  });

  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('branding is session-only, reflects the logo setting, and the PUT validates data URLs', async () => {
    await seedUserWithPrograms(prisma, { email: 'admin@test.local', passwordHash, programs: ['admin.config'] });
    const admin = await loginAgent(app, 'admin@test.local', PASSWORD);

    const before = await admin.get('/api/settings/branding').expect(200);
    expect(before.body).toEqual({ companyName: 'Precision Ink Corporation', logoDataUrl: null });

    // Not an image / oversized / valid.
    await admin.put('/api/settings/company.logoDataUrl').send({ value: 'data:text/html;base64,PGI+' }).expect(400);
    await admin.put('/api/settings/company.logoDataUrl').send({ value: `data:image/png;base64,${'A'.repeat(400_001)}` }).expect(400);
    await admin.put('/api/settings/company.logoDataUrl').send({ value: PNG_1PX }).expect(200);

    // The 1 MB body limit exists FOR the image type only — every other
    // setting keeps a sane length ceiling (review §26 minor).
    await admin.put('/api/settings/company.name').send({ value: 'X'.repeat(10_001) }).expect(400);
    await admin.put('/api/settings/some.unregistered.key').send({ value: 'X'.repeat(10_001) }).expect(400);

    // Any session (no program) reads the branding the documents print.
    await seedUserWithPrograms(prisma, { email: 'user@test.local', passwordHash, programs: [] });
    const user = await loginAgent(app, 'user@test.local', PASSWORD);
    const after = await user.get('/api/settings/branding').expect(200);
    expect(after.body.logoDataUrl).toBe(PNG_1PX);

    // Clearing works (empty value = text-only header).
    await admin.put('/api/settings/company.logoDataUrl').send({ value: '' }).expect(200);
    expect((await user.get('/api/settings/branding').expect(200)).body.logoDataUrl).toBeNull();
  });

  it('serves the container/lot label for a parcel (recall keys + QA disposition)', async () => {
    await seedUserWithPrograms(prisma, { email: 'inv@test.local', passwordHash, programs: ['inventory.browser'] });
    const agent = await loginAgent(app, 'inv@test.local', PASSWORD);

    await addItem(prisma, { id: 10, code: 'RESIN', unit: 'kg' });
    await prisma.item.update({ where: { id: 10 }, data: { description: 'Epoxy resin' } });
    await addLocation(prisma, { id: 1, code: 'WH-A' });
    await addLot(prisma, { lot: 'L260710', itemId: 10 });
    await prisma.lot.update({
      where: { lot: 'L260710' },
      data: { supLot: 'S-9', manfLot: 'M-77', receivedDate: new Date('2026-07-01T00:00:00Z') },
    });
    await addSublot(prisma, { id: 20, lot: 'L260710' });
    await addInventory(prisma, { id: 30, itemId: 10, sublotId: 20, locationId: 1, qty: 25.5 });
    await prisma.release.create({ data: { sublotId: 20, status: 'Approved', grade: 'GMP' } });

    const res = await agent.get('/api/inventory/30/label').expect(200);
    expect(res.body).toMatchObject({
      inventoryId: 30,
      itemCode: 'RESIN',
      description: 'Epoxy resin',
      qty: 25.5,
      unit: 'kg',
      locationCode: 'WH-A',
      lot: 'L260710',
      supLot: 'S-9',
      manfLot: 'M-77',
      madeHere: false,
      status: 'Approved',
      grade: 'GMP',
    });

    await agent.get('/api/inventory/999/label').expect(404);
  });
});
