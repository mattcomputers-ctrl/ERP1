import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addItem, addOrder, addOrdDetail, makePrisma, resetDb, seedActor, services } from './support';

// UG §6.4 "Specifying what to Packout" + the 7.22 packaging-product lookup:
// ItemPackagedProduct-driven packout options (with read-time active-revision
// resolution), the demand/supply picture over OrdDetailCommit, and the atomic
// specify-packout flow (create the MFPP order + allocate the batch's bulk).

const NATIVE = 1_000_000_000;
let prisma: PrismaClient;
let actor: Actor;

const BULK = 1;
const PACKED = 2;
const PROTO = 3;
const CONTAINER = 4;

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

/** Bulk/packed/prototype/container items + an active published RMPP recipe + the binding. */
async function seedPackout(opts?: { recipeInactive?: boolean; bindingInactive?: boolean }) {
  await addItem(prisma, { id: BULK, code: 'E7926' });
  await addItem(prisma, { id: PACKED, code: 'E7926-41' });
  await addItem(prisma, { id: PROTO, code: '41' });
  await addItem(prisma, { id: CONTAINER, code: '4LBT-P' });
  await prisma.recipe.create({
    data: {
      id: 50, recipeNumber: 'E7926-41', context: 'RMPP', comment: 'PACKOUT',
      isPublished: true, inactive: opts?.recipeInactive ?? false,
    },
  });
  await prisma.recipeDetail.createMany({
    data: [
      { id: 500, recipeId: 50, context: 'PK', itemId: PACKED, qtyReqd: 1, execOrder: 1, inactive: false },
      { id: 501, recipeId: 50, context: 'UI', itemId: BULK, qtyReqd: 1, execOrder: 2, inactive: false },
      { id: 502, recipeId: 50, context: 'UI', itemId: CONTAINER, qtyReqd: 0.25, execOrder: 3, inactive: false },
    ],
  });
  await prisma.itemPackagedProduct.create({
    data: {
      id: 10, itemId: BULK, packagingPrototypeId: PROTO, packagedProductId: PACKED,
      recipeId: 50, qty: 1, inactive: opts?.bindingInactive ?? false, altId: 1,
    },
  });
}

/** A batch (MFBA) order making 100 of the bulk. */
async function seedBatch(id = 600, status = 'NST') {
  await addOrder(prisma, { id, context: 'MFBA', status, actualBatchSize: 100 });
  await addOrdDetail(prisma, { id: id + 100, ordrId: id, context: 'PK', itemId: BULK, qtyReqd: 100 });
  return id + 100; // the PK line id
}

describe('packoutOptions (7.22 lookup + active-revision resolution)', () => {
  it('lists a bulk item packout with its bound recipe and bulk-per-unit factor', async () => {
    await seedPackout();
    const { orders } = services(prisma);
    const { rows } = await orders.packoutOptions({ itemId: BULK });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 10,
      orderable: true,
      bulkPerUnit: 1,
      recipe: { id: 50, recipeNumber: 'E7926-41' },
      boundRecipe: { id: 50, active: true },
    });
    expect(rows[0].packagedProduct?.itemCode).toBe('E7926-41');
    expect(rows[0].prototype?.itemCode).toBe('41');
  });

  it('searches by bulk OR packout item code (the packaging-order product lookup)', async () => {
    await seedPackout();
    const { orders } = services(prisma);
    expect((await orders.packoutOptions({ q: 'E7926' })).rows).toHaveLength(1);
    expect((await orders.packoutOptions({ q: '7926-41' })).rows).toHaveLength(1);
    expect((await orders.packoutOptions({ q: 'ZZZ' })).rows).toHaveLength(0);
    // No criteria -> no rows (never dump all 7k bindings).
    expect((await orders.packoutOptions({})).rows).toHaveLength(0);
  });

  it('resolves the ACTIVE revision when the bound recipe is superseded', async () => {
    await seedPackout({ recipeInactive: true });
    await prisma.recipe.create({
      data: { id: 51, recipeNumber: 'E7926-41.01', context: 'RMPP', comment: 'REV', isPublished: true, inactive: false },
    });
    await prisma.recipeDetail.createMany({
      data: [
        { id: 510, recipeId: 51, context: 'PK', itemId: PACKED, qtyReqd: 1, execOrder: 1, inactive: false },
        { id: 511, recipeId: 51, context: 'UI', itemId: BULK, qtyReqd: 2, execOrder: 2, inactive: false },
      ],
    });
    const { orders } = services(prisma);
    const { rows } = await orders.packoutOptions({ itemId: BULK });
    expect(rows[0].boundRecipe).toMatchObject({ id: 50, active: false });
    expect(rows[0].recipe).toMatchObject({ id: 51, recipeNumber: 'E7926-41.01' });
    expect(rows[0].bulkPerUnit).toBe(2); // the ACTIVE revision's bulk line
    expect(rows[0].orderable).toBe(true);
  });

  it('marks the option not-orderable when no active revision packs the product', async () => {
    await seedPackout({ recipeInactive: true });
    const { orders } = services(prisma);
    const { rows } = await orders.packoutOptions({ itemId: BULK });
    expect(rows[0].orderable).toBe(false);
    expect(rows[0].recipe).toBeNull();
    expect(rows[0].reason).toMatch(/No active published packaging recipe/);
  });

  it('excludes inactive bindings', async () => {
    await seedPackout({ bindingInactive: true });
    const { orders } = services(prisma);
    expect((await orders.packoutOptions({ itemId: BULK })).rows).toHaveLength(0);
  });

  it('a recipe splitting the bulk across multiple UI lines is explicitly not orderable', async () => {
    await seedPackout();
    // A second UI line of the SAME bulk item — picking either line would
    // under-count the requirement, so the option must refuse instead.
    await prisma.recipeDetail.create({
      data: { id: 503, recipeId: 50, context: 'UI', itemId: BULK, qtyReqd: 0.5, execOrder: 4, inactive: false },
    });
    const { orders } = services(prisma);
    const { rows } = await orders.packoutOptions({ itemId: BULK });
    expect(rows[0].orderable).toBe(false);
    expect(rows[0].reason).toMatch(/splits the bulk item/);
    expect(rows[0].bulkPerUnit).toBeNull();

    await seedBatch();
    await expect(orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 1 }, actor)).rejects.toThrow(
      /splits the bulk item/,
    );
  });

  it('a bound recipe that is not RMPP falls through to active-revision resolution', async () => {
    await seedPackout();
    // Corrupt the binding to point at a BATCHING recipe — offering it would
    // mint the wrong order type from a "packout".
    await prisma.recipe.create({
      data: { id: 60, recipeNumber: 'WRONG', context: 'RMBA', comment: 'X', isPublished: true, inactive: false },
    });
    await prisma.itemPackagedProduct.update({ where: { id: 10 }, data: { recipeId: 60 } });
    const { orders } = services(prisma);
    const { rows } = await orders.packoutOptions({ itemId: BULK });
    expect(rows[0].boundRecipe).toMatchObject({ id: 60, active: false });
    // Falls through to the active RMPP revision packing the same product.
    expect(rows[0].recipe).toMatchObject({ id: 50 });
    expect(rows[0].orderable).toBe(true);
  });
});

describe('specifyPackout (create MFPP + allocate bulk, atomically)', () => {
  it('creates the packaging order, scales its lines, and links the commit demand->supply', async () => {
    await seedPackout();
    const pkLineId = await seedBatch();
    const { orders } = services(prisma);

    const res = await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 40 }, actor);
    expect(res.orderId).toBeGreaterThanOrEqual(NATIVE);
    expect(res.suppliedQty).toBe(40); // bulkPerUnit 1 × 40
    expect(res.totals).toMatchObject({ yield: 100, allocated: 40, remaining: 60 });
    expect(res.overAllocated).toBe(false);
    expect(res.lot).toBeTruthy(); // the packout lot is minted at creation

    const mfpp = await prisma.ordr.findUnique({ where: { id: res.orderId } });
    expect(mfpp).toMatchObject({ context: 'MFPP', status: 'NST', recipeId: 50 });
    const lines = await prisma.ordDetail.findMany({ where: { ordrId: res.orderId }, orderBy: { id: 'asc' } });
    const ui = lines.filter((l) => l.context === 'UI');
    expect(ui.find((l) => l.itemId === BULK)?.qtyReqd).toBe(40); // 1 × 40
    expect(ui.find((l) => l.itemId === CONTAINER)?.qtyReqd).toBe(10); // 0.25 × 40
    expect(lines.find((l) => l.context === 'PK')?.qtyReqd).toBe(40);

    const commit = await prisma.ordDetailCommit.findUnique({ where: { id: res.commitId } });
    expect(commit).toMatchObject({
      ordDetailId: ui.find((l) => l.itemId === BULK)!.id,
      srcOrdDetailId: pkLineId,
      qty: 40,
      packagingReady: false,
    });
    expect(commit!.id).toBeGreaterThanOrEqual(NATIVE);

    expect(await prisma.auditLog.count({ where: { action: 'order.packout' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'order.create' } })).toBe(1);
  });

  it('shows the demand on the batch and the supply on the packaging order', async () => {
    await seedPackout();
    await seedBatch();
    const { orders } = services(prisma);
    const res = await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 25 }, actor);

    const batchView = await orders.packouts(600);
    expect(batchView.kind).toBe('MFBA');
    if (batchView.kind === 'MFBA') {
      expect(batchView.totals).toMatchObject({ yield: 100, allocated: 25, remaining: 75 });
      expect(batchView.demand).toHaveLength(1);
      expect(batchView.demand[0]).toMatchObject({ orderId: res.orderId, orderContext: 'MFPP', qty: 25 });
      expect(batchView.demand[0].product?.itemCode).toBe('E7926-41');
      // The options carry can-make math against the remaining yield.
      expect(batchView.options[0].canMake).toBe(75);
    }

    const packView = await orders.packouts(res.orderId);
    expect(packView.kind).toBe('MFPP');
    if (packView.kind === 'MFPP') {
      expect(packView.supply).toHaveLength(1);
      expect(packView.supply[0]).toMatchObject({ batchOrderId: 600, qty: 25 });
      expect(packView.supply[0].item?.itemCode).toBe('E7926');
    }
  });

  it('honors an explicit smaller supplied qty and rejects over-supplying the requirement', async () => {
    await seedPackout();
    await seedBatch();
    const { orders } = services(prisma);
    const res = await orders.specifyPackout(
      600,
      { itemPackagedProductId: 10, makeQty: 40, suppliedQty: 15 },
      actor,
    );
    expect(res.suppliedQty).toBe(15);
    expect(res.totals.allocated).toBe(15);

    await expect(
      orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 10, suppliedQty: 11 }, actor),
    ).rejects.toThrow(/exceeds the bulk/);
  });

  it('over-allocating the batch yield warns but never blocks (vendor negative Remaining Yield)', async () => {
    await seedPackout();
    await seedBatch();
    const { orders } = services(prisma);
    const res = await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 150 }, actor);
    expect(res.overAllocated).toBe(true);
    expect(res.totals.remaining).toBe(-50);
  });

  it('uses the ACTIVE revision (not the superseded bound recipe) for the created order', async () => {
    await seedPackout({ recipeInactive: true });
    await prisma.recipe.create({
      data: { id: 51, recipeNumber: 'E7926-41.01', context: 'RMPP', comment: 'REV', isPublished: true, inactive: false },
    });
    await prisma.recipeDetail.createMany({
      data: [
        { id: 510, recipeId: 51, context: 'PK', itemId: PACKED, qtyReqd: 1, execOrder: 1, inactive: false },
        { id: 511, recipeId: 51, context: 'UI', itemId: BULK, qtyReqd: 2, execOrder: 2, inactive: false },
      ],
    });
    await seedBatch();
    const { orders } = services(prisma);
    const res = await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 10 }, actor);
    const mfpp = await prisma.ordr.findUnique({ where: { id: res.orderId } });
    expect(mfpp?.recipeId).toBe(51);
    expect(res.suppliedQty).toBe(20); // active revision's bulkPerUnit 2 × 10
  });

  it('refuses non-MFBA orders, wrong-product bindings, inactive bindings, and completed batches', async () => {
    await seedPackout();
    const { orders } = services(prisma);

    await addOrder(prisma, { id: 610, context: 'SH' });
    await expect(orders.specifyPackout(610, { itemPackagedProductId: 10, makeQty: 1 }, actor)).rejects.toThrow(
      /batch \(MFBA\) orders/,
    );

    // Batch making a DIFFERENT product than the binding's bulk.
    await addItem(prisma, { id: 9, code: 'OTHER' });
    await addOrder(prisma, { id: 620, context: 'MFBA', actualBatchSize: 10 });
    await addOrdDetail(prisma, { id: 720, ordrId: 620, context: 'PK', itemId: 9, qtyReqd: 10 });
    await expect(orders.specifyPackout(620, { itemPackagedProductId: 10, makeQty: 1 }, actor)).rejects.toThrow(
      /different bulk product/,
    );

    await prisma.itemPackagedProduct.update({ where: { id: 10 }, data: { inactive: true } });
    await seedBatch(630);
    await expect(orders.specifyPackout(630, { itemPackagedProductId: 10, makeQty: 1 }, actor)).rejects.toThrow(
      /inactive/,
    );
    await prisma.itemPackagedProduct.update({ where: { id: 10 }, data: { inactive: false } });

    await seedBatch(640, 'CMP');
    await expect(orders.specifyPackout(640, { itemPackagedProductId: 10, makeQty: 1 }, actor)).rejects.toThrow(
      /before completion/,
    );
  });

  it('refuses when the binding has no orderable recipe', async () => {
    await seedPackout({ recipeInactive: true });
    await seedBatch();
    const { orders } = services(prisma);
    await expect(orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 1 }, actor)).rejects.toThrow(
      /No active published packaging recipe/,
    );
  });

  it('orders a binding even when the option list is capped (resolution is per-binding, not via the list)', async () => {
    await seedPackout();
    await seedBatch();
    // 60 more bindings for the same bulk item sorted ahead of binding 10 by
    // altId — the option list caps at 50, but specifyPackout must resolve the
    // requested binding directly.
    await prisma.itemPackagedProduct.update({ where: { id: 10 }, data: { altId: 999 } });
    await prisma.itemPackagedProduct.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        id: 1000 + i, itemId: BULK, packagingPrototypeId: PROTO, packagedProductId: PACKED,
        recipeId: 50, qty: 1, inactive: false, altId: i,
      })),
    });
    const { orders } = services(prisma);
    expect((await orders.packoutOptions({ itemId: BULK })).rows.map((r) => r.id)).not.toContain(10);
    const res = await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 5 }, actor);
    expect(res.suppliedQty).toBe(5);
  });

  it('demand accumulates across packouts and the released batch still accepts them', async () => {
    await seedPackout();
    await seedBatch(600, 'RLS');
    const { orders } = services(prisma);
    await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 30 }, actor);
    await orders.specifyPackout(600, { itemPackagedProductId: 10, makeQty: 45 }, actor);
    const view = await orders.packouts(600);
    if (view.kind === 'MFBA') {
      expect(view.totals).toMatchObject({ allocated: 75, remaining: 25 });
      expect(view.demand).toHaveLength(2);
    }
  });
});
