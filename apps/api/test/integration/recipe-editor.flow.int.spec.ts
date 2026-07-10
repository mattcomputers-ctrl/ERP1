import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generate as generateTotp } from 'otplib';
import { AuthService } from '../../src/auth/auth.service';
import { AuditService } from '../../src/audit/audit.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addEntity, addItem, addPriceDetail, addPriceVersion, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the RECIPE LIFECYCLE (§4) against a real Postgres —
// draft creation, procedure editing (per-1-lb normalization), publish with
// verification + the single-active-recipe rule, `.NN` version cloning,
// activate/deactivate, draft deletion, the order-creation enforcement it makes
// load-bearing, batch-record preview, and the §5.3.1 expected-cost rollup.
// The recipe.publish secured item is seeded RELAXED except in the e-sig test.

let prisma: PrismaClient;
let actor: Actor;
let publisherRoleId: string;

const NATIVE = 1_000_000_000;

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
  // Relaxed secured item (all response flags false -> no reason/signature),
  // with the actor's group granted the PERFORM right — publish enforces the
  // allow grant, so a bare actor would be 403'd.
  const item = await prisma.securedItem.create({ data: { key: 'recipe.publish' } });
  const role = await prisma.role.create({ data: { code: 'PUBLISHER', name: 'Publisher' }, select: { id: true } });
  publisherRoleId = role.id;
  await prisma.roleSecuredItem.create({ data: { roleId: role.id, securedItemId: item.id, allow: true, allowWitness: true } });
  await prisma.user.update({ where: { id: actor.id }, data: { roles: { create: { roleId: role.id } } } });
});

const PRODUCT = 501;
const RESIN = 502;
const PIGMENT = 503;
const TINT = 504;

async function seedItems() {
  await addItem(prisma, { id: PRODUCT, code: 'UV9001' });
  await addItem(prisma, { id: RESIN, code: 'RES100' });
  await addItem(prisma, { id: PIGMENT, code: 'PIG200' });
  await addItem(prisma, { id: TINT, code: 'TNT300' });
}

/** Create a draft batching recipe with a simple 2-ingredient procedure at a
 * 100 lb formula basis (60 resin / 40 pigment + one instruction). */
async function draftBatchingRecipe(svc: ReturnType<typeof services>, number = 'UV9001.01') {
  const created = await svc.recipeEditor.create(
    { context: 'RMBA', recipeNumber: number, productItemId: PRODUCT, comment: 'NEW' },
    actor,
  );
  await svc.recipeEditor.saveProcedure(
    created.id,
    {
      basis: 100,
      lines: [
        { kind: 'instruction', description: 'ADD IN ORDER' },
        { kind: 'ingredient', itemId: RESIN, qty: 60 },
        { kind: 'ingredient', itemId: PIGMENT, qty: 40 },
      ],
    },
    actor,
  );
  return created;
}

describe('draft creation & structure', () => {
  it('creates a batching draft with the legacy structural lines and native ids', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await svc.recipeEditor.create(
      { context: 'RMBA', recipeNumber: 'UV9001.01', productItemId: PRODUCT, comment: 'NEW' },
      actor,
    );
    expect(created.id).toBeGreaterThan(NATIVE);
    expect(created.isPublished).toBe(false);

    const lines = await prisma.recipeDetail.findMany({ where: { recipeId: created.id }, orderBy: { id: 'asc' } });
    expect(lines.map((l) => l.context)).toEqual(['BA', 'PK']);
    const [ba, pk] = lines;
    expect(ba.phase).toBe('PHASE');
    expect(ba.execOrder).toBe(1);
    expect(ba.batchType).toBe('2');
    expect(ba.totalWeight).toBeCloseTo(0.45359237, 8); // 1 lb in kg, full factor (matches live rows)
    expect(pk.parentId).toBe(ba.id);
    expect(pk.itemId).toBe(PRODUCT);
    expect(pk.qtyReqd).toBe(1);
    expect(pk.totalWeightPercent).toBe(100);
    expect(pk.id).toBeGreaterThan(NATIVE);

    expect(await prisma.auditLog.count({ where: { action: 'recipe.create' } })).toBe(1);
  });

  it('creates a packaging draft as a flat PK root', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await svc.recipeEditor.create(
      { context: 'RMPP', recipeNumber: 'UV9001-5GR', productItemId: PRODUCT, comment: '5 GALLON PAIL' },
      actor,
    );
    const lines = await prisma.recipeDetail.findMany({ where: { recipeId: created.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].context).toBe('PK');
    expect(lines[0].parentId).toBeNull();
  });

  it('rejects a duplicate recipe number (case-insensitive)', async () => {
    await seedItems();
    const svc = services(prisma);
    await svc.recipeEditor.create({ context: 'RMBA', recipeNumber: 'UV9001.01', productItemId: PRODUCT, comment: 'NEW' }, actor);
    await expect(
      svc.recipeEditor.create({ context: 'RMBA', recipeNumber: 'uv9001.01', productItemId: PRODUCT, comment: 'DUP' }, actor),
    ).rejects.toThrow(/already exists/);
  });
});

describe('procedure editing', () => {
  it('normalizes quantities to per-1-lb and numbers lines like the legacy data', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await draftBatchingRecipe(svc);

    const lines = await prisma.recipeDetail.findMany({
      where: { recipeId: created.id },
      orderBy: [{ execOrder: 'asc' }, { id: 'asc' }],
    });
    // BA(1) INSTR(2) UI(3) UI(4) then PK (no exec order).
    const ba = lines.find((l) => l.context === 'BA')!;
    const instr = lines.find((l) => l.context === 'INSTR')!;
    const uis = lines.filter((l) => l.context === 'UI');
    expect(ba.execOrder).toBe(1);
    expect(instr.execOrder).toBe(2);
    expect(instr.parentId).toBe(ba.id);
    expect(uis.map((l) => l.execOrder)).toEqual([3, 4]);
    expect(uis.map((l) => l.qtyReqd)).toEqual([0.6, 0.4]); // 60/100, 40/100
    expect(uis.map((l) => Number(l.line))).toEqual([1, 2]);
    expect(uis.every((l) => l.id > NATIVE)).toBe(true);
  });

  it('updates in place, adds, and removes lines on re-save', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await draftBatchingRecipe(svc);
    const before = await svc.recipes.get(created.id);
    const resin = before.lines.find((l) => l.itemCode === 'RES100')!;
    const pigment = before.lines.find((l) => l.itemCode === 'PIG200')!;
    const instr = before.lines.find((l) => l.kind === 'instruction')!;

    const result = await svc.recipeEditor.saveProcedure(
      created.id,
      {
        basis: 100,
        lines: [
          { id: instr.id, kind: 'instruction', description: 'ADD IN ORDER' },
          { id: resin.id, kind: 'ingredient', itemId: RESIN, qty: 55 }, // changed qty
          { kind: 'ingredient', itemId: TINT, qty: 5 }, // added
          // pigment omitted -> removed
        ],
      },
      actor,
    );
    expect(result).toMatchObject({ added: 1, updated: 1, removed: 1 });

    const after = await svc.recipes.get(created.id);
    const ingredients = after.lines.filter((l) => l.kind === 'ingredient');
    expect(ingredients.map((l) => l.itemCode)).toEqual(['RES100', 'TNT300']);
    expect(ingredients.map((l) => l.qtyReqd)).toEqual([0.55, 0.05]);
    expect(after.lines.find((l) => l.id === pigment.id)).toBeUndefined();
    // The resin row was updated IN PLACE (same id), preserving identity.
    expect(ingredients[0].id).toBe(resin.id);
  });

  it('refuses procedure edits on a published recipe (immutability)', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await draftBatchingRecipe(svc);
    await svc.recipeEditor.publish(created.id, {}, actor);
    await expect(
      svc.recipeEditor.saveProcedure(created.id, { lines: [] }, actor),
    ).rejects.toThrow(/published and immutable/);
    await expect(svc.recipeEditor.updateHeader(created.id, { comment: 'X' }, actor)).rejects.toThrow(/immutable/);
    await expect(svc.recipeEditor.remove(created.id, actor)).rejects.toThrow(/immutable/);
  });

  it('rejects IDOR line ids and kind changes', async () => {
    await seedItems();
    const svc = services(prisma);
    const a = await draftBatchingRecipe(svc, 'UV9001.01');
    const b = await svc.recipeEditor.create(
      { context: 'RMBA', recipeNumber: 'OTHER.01', productItemId: PRODUCT, comment: 'B' },
      actor,
    );
    const aLines = await svc.recipes.get(a.id);
    const resin = aLines.lines.find((l) => l.itemCode === 'RES100')!;
    // A line of recipe A used in recipe B's payload -> rejected.
    await expect(
      svc.recipeEditor.saveProcedure(b.id, { lines: [{ id: resin.id, kind: 'ingredient', itemId: RESIN, qty: 1 }] }, actor),
    ).rejects.toThrow(/not an editable procedure line/);
    // Changing a line's kind -> rejected.
    await expect(
      svc.recipeEditor.saveProcedure(a.id, { basis: 100, lines: [{ id: resin.id, kind: 'instruction', description: 'X' }] }, actor),
    ).rejects.toThrow(/delete it and add a new line/);
  });

  it('updates the header and re-points the product line', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await draftBatchingRecipe(svc);
    const res = await svc.recipeEditor.updateHeader(
      created.id,
      { comment: 'REVISED PROCEDURE', leadTime: 5, productItemId: TINT },
      actor,
    );
    expect(res).toMatchObject({ changed: 3 });
    const after = await svc.recipes.get(created.id);
    expect(after.comment).toBe('REVISED PROCEDURE');
    expect(after.leadTime).toBe(5);
    expect(after.product?.itemId).toBe(TINT);
    // No-op update short-circuits without an audit row.
    const noop = await svc.recipeEditor.updateHeader(created.id, { leadTime: 5 }, actor);
    expect(noop).toMatchObject({ unchanged: true });
  });
});

describe('publish, versioning & the single-active rule', () => {
  it('verifies before publishing: no ingredients -> refused', async () => {
    await seedItems();
    const svc = services(prisma);
    const created = await svc.recipeEditor.create(
      { context: 'RMBA', recipeNumber: 'UV9001.01', productItemId: PRODUCT, comment: 'NEW' },
      actor,
    );
    await expect(svc.recipeEditor.publish(created.id, {}, actor)).rejects.toThrow(/no ingredient lines/);
  });

  it('publishes, then a clone suggests .NN+1 and publishing it deactivates the old revision', async () => {
    await seedItems();
    const svc = services(prisma);
    const v1 = await draftBatchingRecipe(svc, 'UV9001.01');
    const pub1 = await svc.recipeEditor.publish(v1.id, { reason: 'initial release' }, actor);
    expect(pub1.published).toBe(true);
    expect(pub1.deactivated).toEqual([]);

    const v2 = await svc.recipeEditor.clone(v1.id, { comment: 'REPLACED DEFOAMER' }, actor);
    expect(v2.recipeNumber).toBe('UV9001.02');
    // The clone copied every line (BA + PK + INSTR + 2 UI).
    expect(v2.lines).toBe(5);
    const v2Lines = await prisma.recipeDetail.findMany({ where: { recipeId: v2.id } });
    expect(v2Lines).toHaveLength(5);
    // Parent tree remapped to the new ids, not pointing at the source rows.
    const ba2 = v2Lines.find((l) => l.context === 'BA')!;
    const pk2 = v2Lines.find((l) => l.context === 'PK')!;
    expect(pk2.parentId).toBe(ba2.id);

    const pub2 = await svc.recipeEditor.publish(v2.id, {}, actor);
    expect(pub2.deactivated).toEqual(['UV9001.01']);
    const one = await prisma.recipe.findUniqueOrThrow({ where: { id: v1.id } });
    expect(one.inactive).toBe(true);
    const two = await prisma.recipe.findUniqueOrThrow({ where: { id: v2.id } });
    expect(two.isPublished).toBe(true);
    expect(two.inactive).toBe(false);
  });

  it('rework revisions do not deactivate the active recipe when published', async () => {
    await seedItems();
    const svc = services(prisma);
    const v1 = await draftBatchingRecipe(svc, 'UV9001.01');
    await svc.recipeEditor.publish(v1.id, {}, actor);
    const rw = await svc.recipeEditor.clone(v1.id, { recipeNumber: 'UV9001-RW', comment: 'REWORK' }, actor);
    await svc.recipeEditor.updateHeader(rw.id, { rework: true }, actor);
    const pub = await svc.recipeEditor.publish(rw.id, {}, actor);
    expect(pub.deactivated).toEqual([]);
    const one = await prisma.recipe.findUniqueOrThrow({ where: { id: v1.id } });
    expect(one.inactive).toBe(false);
  });

  it('re-activating an old revision deactivates the current one atomically', async () => {
    await seedItems();
    const svc = services(prisma);
    const v1 = await draftBatchingRecipe(svc, 'UV9001.01');
    await svc.recipeEditor.publish(v1.id, {}, actor);
    const v2 = await svc.recipeEditor.clone(v1.id, {}, actor);
    await svc.recipeEditor.publish(v2.id, {}, actor); // v1 now inactive

    const res = await svc.recipeEditor.setActive(v1.id, { active: true, reason: 'rollback' }, actor);
    expect(res).toMatchObject({ active: true, deactivated: ['UV9001.02'] });
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id: v2.id } })).inactive).toBe(true);
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id: v1.id } })).inactive).toBe(false);
    // Draft recipes cannot be toggled.
    const draft = await svc.recipeEditor.clone(v1.id, {}, actor);
    await expect(svc.recipeEditor.setActive(draft.id, { active: false }, actor)).rejects.toThrow(/Only published/);
  });

  it('deletes drafts but never published recipes; audit trail records everything', async () => {
    await seedItems();
    const svc = services(prisma);
    const draft = await draftBatchingRecipe(svc);
    const removed = await svc.recipeEditor.remove(draft.id, actor);
    expect(removed).toMatchObject({ removed: true });
    expect(await prisma.recipe.count({ where: { id: draft.id } })).toBe(0);
    expect(await prisma.recipeDetail.count({ where: { recipeId: draft.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'recipe.delete' } })).toBe(1);
  });

  it('requires an e-signature on publish when the secured item demands one', async () => {
    await seedItems();
    await prisma.securedItem.update({ where: { key: 'recipe.publish' }, data: { requireSignature: true } });
    const svc = services(prisma);
    const auth = new AuthService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
    const pwHash = await auth.hashPassword('Sup3rSecret!!');
    const u = await prisma.user.create({
      data: {
        email: 'signer@test.local', displayName: 'Signer', status: 'ACTIVE', passwordHash: pwHash,
        roles: { create: { roleId: publisherRoleId } },
      },
      select: { id: true, displayName: true },
    });
    const signer: Actor = { id: u.id, label: u.displayName };

    const draft = await draftBatchingRecipe(svc);
    await expect(svc.recipeEditor.publish(draft.id, {}, signer)).rejects.toThrow(/password is required/);
    await expect(svc.recipeEditor.publish(draft.id, { password: 'wrong' }, signer)).rejects.toThrow();

    const ok = await svc.recipeEditor.publish(draft.id, { password: 'Sup3rSecret!!' }, signer);
    expect(ok.published).toBe(true);
    const sig = await prisma.eSignature.findFirst({ where: { securedItemKey: 'recipe.publish' } });
    expect(sig).not.toBeNull();
    expect(sig!.masterId).toBe(String(draft.id));
  });

  it('demands the TOTP second factor from an MFA-enrolled signer (L19 e-sig plumbing)', async () => {
    await seedItems();
    await prisma.securedItem.update({ where: { key: 'recipe.publish' }, data: { requireSignature: true } });
    const svc = services(prisma);
    const auth = new AuthService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService));
    const pwHash = await auth.hashPassword('Sup3rSecret!!');
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const u = await prisma.user.create({
      data: {
        email: 'mfa-signer@test.local', displayName: 'MFA Signer', status: 'ACTIVE', passwordHash: pwHash,
        mfaEnabled: true, mfaSecret: secret,
        roles: { create: { roleId: publisherRoleId } },
      },
      select: { id: true, displayName: true },
    });
    const signer: Actor = { id: u.id, label: u.displayName };
    const draft = await draftBatchingRecipe(svc);

    // Password alone no longer signs; a wrong code is refused; the DTO's
    // totpCode reaches the shared credential check and the publish goes through.
    await expect(svc.recipeEditor.publish(draft.id, { password: 'Sup3rSecret!!' }, signer))
      .rejects.toMatchObject({ response: { code: 'MFA_REQUIRED' } });
    await expect(
      svc.recipeEditor.publish(draft.id, { password: 'Sup3rSecret!!', totpCode: '000000' }, signer),
    ).rejects.toThrow(/multi-factor/i);
    const code = await generateTotp({ secret });
    const ok = await svc.recipeEditor.publish(draft.id, { password: 'Sup3rSecret!!', totpCode: code }, signer);
    expect(ok.published).toBe(true);
  });

  it('refuses publishing twice and enforces the perform grant + required reason', async () => {
    await seedItems();
    const svc = services(prisma);
    const draft = await draftBatchingRecipe(svc);

    // A user whose groups lack the recipe.publish allow grant is refused.
    const outsider = await prisma.user.create({
      data: { email: 'outsider@test.local', displayName: 'Outsider' },
      select: { id: true, displayName: true },
    });
    await expect(
      svc.recipeEditor.publish(draft.id, {}, { id: outsider.id, label: outsider.displayName }),
    ).rejects.toThrow(/not permitted to publish/);

    // requireReason forces a contemporaneous justification (the stored recipe
    // comment does NOT satisfy it).
    await prisma.securedItem.update({ where: { key: 'recipe.publish' }, data: { requireReason: true } });
    await expect(svc.recipeEditor.publish(draft.id, {}, actor)).rejects.toThrow(/reason is required/);
    const ok = await svc.recipeEditor.publish(draft.id, { reason: 'initial release' }, actor);
    expect(ok.published).toBe(true);

    // Double publish is refused (also guarded in-transaction against races).
    await expect(svc.recipeEditor.publish(draft.id, { reason: 'again' }, actor)).rejects.toThrow(/already published/);
    expect(await prisma.auditLog.count({ where: { action: 'recipe.publish' } })).toBe(1);
  });
});

describe('order-creation enforcement (now load-bearing)', () => {
  it('refuses orders from drafts and superseded revisions; allows the active one', async () => {
    await seedItems();
    const svc = services(prisma);
    const v1 = await draftBatchingRecipe(svc, 'UV9001.01');
    // Draft -> refused.
    await expect(svc.orders.create({ recipeId: v1.id, batchSize: 100 }, actor)).rejects.toThrow(/not published/);

    await svc.recipeEditor.publish(v1.id, {}, actor);
    const v2 = await svc.recipeEditor.clone(v1.id, {}, actor);
    await svc.recipeEditor.publish(v2.id, {}, actor); // v1 superseded

    // Superseded -> refused; active -> works and scales from the per-1-lb base.
    await expect(svc.orders.create({ recipeId: v1.id, batchSize: 100 }, actor)).rejects.toThrow(/inactive/);
    const order = await svc.orders.create({ recipeId: v2.id, batchSize: 200 }, actor);
    expect(order.status).toBe('NST');
    const uiLines = await prisma.ordDetail.findMany({ where: { ordrId: order.id, context: 'UI' } });
    expect(uiLines.map((l) => l.qtyReqd).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([80, 120]); // 0.4×200, 0.6×200
    // The picker offers only the active revision.
    const options = await svc.orders.recipeOptions('UV9001');
    expect(options.rows.map((r) => r.recipeNumber)).toEqual(['UV9001.02']);
  });
});

describe('preview & pricing', () => {
  it('renders the batch-record preview scaled to the requested batch size', async () => {
    await seedItems();
    await prisma.itemTest.create({
      data: { id: 9001, itemId: PRODUCT, test: 'VISCOSITY', min: 10, max: 20, onProduction: true, line: 1 },
    });
    const svc = services(prisma);
    const draft = await draftBatchingRecipe(svc);

    const sheet = await svc.recipes.preview(draft.id, 250);
    expect(sheet.preview).toBe(true);
    expect(sheet.header.recipeNumber).toBe('UV9001.01');
    expect(sheet.header.productCode).toBe('UV9001');
    expect(sheet.header.totalWeight).toBe(250);
    expect(sheet.header.thisLot).toBeNull(); // no lot without an order (vendor caution)
    const materials = sheet.procedure.filter((p) => p.kind === 'material');
    expect(materials.map((m) => m.pounds)).toEqual([150, 100]); // 0.6×250, 0.4×250
    expect(sheet.procedure[0]).toMatchObject({ kind: 'instruction', description: 'ADD IN ORDER' });
    expect(sheet.tests).toEqual([{ test: 'VISCOSITY', specification: expect.stringContaining('10') }]);
  });

  it('rolls up expected cost per §5.3.1: cheapest supplier tier, excess, and standard-cost fallback', async () => {
    await seedItems();
    const svc = services(prisma);
    const draft = await draftBatchingRecipe(svc); // 0.6 resin + 0.4 pigment per lb

    // Supplier A prices RESIN with a qty-break: min 1 @ $10, min 200 @ $8.
    const supA = await addEntity(prisma, { id: 71, code: 'SUPA', isSupplier: true });
    await addPriceVersion(prisma, { id: 81, entityId: supA, effectiveDate: new Date('2026-01-01') });
    await addPriceDetail(prisma, { id: 91, priceVersionId: 81, itemId: RESIN, minOrder1: 1, price1: 10, minOrder2: 200, price2: 8 });
    // Supplier B prices RESIN flat $9 — loses to A's break at 60 lb? A: 60×10=600 vs 200×8=1600 -> $600; B: 60×9=540 wins.
    const supB = await addEntity(prisma, { id: 72, code: 'SUPB', isSupplier: true });
    await addPriceVersion(prisma, { id: 82, entityId: supB, effectiveDate: new Date('2026-01-01') });
    await addPriceDetail(prisma, { id: 92, priceVersionId: 82, itemId: RESIN, minOrder1: 1, price1: 9 });
    // PIGMENT: only a big-minimum tier -> forced excess. min 100 @ $2.
    await addPriceDetail(prisma, { id: 93, priceVersionId: 82, itemId: PIGMENT, minOrder1: 100, price1: 2 });

    const pricing = await svc.recipes.pricing(draft.id, 100); // needs 60 resin + 40 pigment
    const resin = pricing.rows.find((r) => r.itemCode === 'RES100')!;
    expect(resin).toMatchObject({ source: 'supplier', supplierCode: 'SUPB', unitPrice: 9, orderQty: 60, totalCost: 540, excessQty: 0 });
    const pigment = pricing.rows.find((r) => r.itemCode === 'PIG200')!;
    expect(pigment).toMatchObject({ source: 'supplier', supplierCode: 'SUPB', unitPrice: 2, orderQty: 100, totalCost: 200, excessQty: 60, excessCost: 120 });
    expect(pricing.totals.expected).toBe(740);
    expect(pricing.totals.excess).toBe(120);
    expect(pricing.totals.unpriced).toBe(0);
  });

  it('ignores superseded price versions and falls back to standard cost', async () => {
    await seedItems();
    await prisma.item.update({ where: { id: PIGMENT }, data: { standardCost: 3.5 } });
    const svc = services(prisma);
    const draft = await draftBatchingRecipe(svc);

    const sup = await addEntity(prisma, { id: 71, code: 'SUPA', isSupplier: true });
    // Old version priced RESIN at $4; the NEWER effective version dropped it.
    await addPriceVersion(prisma, { id: 81, entityId: sup, effectiveDate: new Date('2025-01-01') });
    await addPriceDetail(prisma, { id: 91, priceVersionId: 81, itemId: RESIN, minOrder1: 1, price1: 4 });
    await addPriceVersion(prisma, { id: 82, entityId: sup, effectiveDate: new Date('2026-01-01') });

    const pricing = await svc.recipes.pricing(draft.id, 100);
    const resin = pricing.rows.find((r) => r.itemCode === 'RES100')!;
    expect(resin.source).toBeNull(); // stale $4 offer NOT used
    const pigment = pricing.rows.find((r) => r.itemCode === 'PIG200')!;
    expect(pigment).toMatchObject({ source: 'standard', unitPrice: 3.5, totalCost: 140 });
    expect(pricing.totals.unpriced).toBe(1);
  });
});

describe('read side', () => {
  it('returns the version family and editability on get()', async () => {
    await seedItems();
    const svc = services(prisma);
    const v1 = await draftBatchingRecipe(svc, 'UV9001.01');
    await svc.recipeEditor.publish(v1.id, {}, actor);
    const v2 = await svc.recipeEditor.clone(v1.id, {}, actor);

    const got = await svc.recipes.get(v2.id);
    expect(got.editable).toBe(true);
    expect(got.family.map((f) => f.recipeNumber)).toEqual(['UV9001.01', 'UV9001.02']);
    expect(got.product?.itemCode).toBe('UV9001');
    const one = await svc.recipes.get(v1.id);
    expect(one.editable).toBe(false);
  });
});
