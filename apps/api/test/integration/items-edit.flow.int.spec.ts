import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { ItemsService } from '../../src/master-data/items/items.service';
import { NotificationEngineService } from '../../src/notifications/notification-engine.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addEntity, addItem, makePrisma, resetDb, seedActor } from './support';

// Flow integration test: the item edit-form gaps (L31) — NAME aliases, ItemEntity
// ST planning knobs, and packaged-product bindings.

const NATIVE_BASE = 1_000_000_000;
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

function itemsService(): ItemsService {
  const p = prisma as unknown as PrismaService;
  return new ItemsService(p, new AuditService(p), new NotificationEngineService(p));
}

describe('ItemsService NAME aliases', () => {
  it('creates a NAME alias pointing at a stock item and surfaces the target code in the list', async () => {
    const svc = itemsService();
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 10, code: 'REAL-STOCK' });

    const { id } = await svc.create({ itemCode: 'TRADE NAME', context: 'NAME', replacedById: 10 }, actor);
    const created = await prisma.item.findUnique({ where: { id } });
    expect(created?.replacedById).toBe(10);
    expect(created?.context).toBe('NAME');

    const list = await svc.list({ q: 'TRADE NAME' });
    const row = list.rows.find((r) => r.id === id)!;
    expect((row as { replacedByCode?: string }).replacedByCode).toBe('REAL-STOCK');
  });

  it('sets then clears an alias link, and rejects self-alias + unknown target', async () => {
    const svc = itemsService();
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 10, code: 'REAL' });
    const { id } = await svc.create({ itemCode: 'ALIAS', context: 'NAME' }, actor);

    await svc.update(id, { replacedById: 10 }, actor);
    expect((await prisma.item.findUnique({ where: { id } }))?.replacedById).toBe(10);

    await svc.update(id, { replacedById: null }, actor);
    expect((await prisma.item.findUnique({ where: { id } }))?.replacedById).toBeNull();

    await expect(svc.update(id, { replacedById: id }, actor)).rejects.toThrow(/itself/i);
    await expect(svc.update(id, { replacedById: 999999 }, actor)).rejects.toThrow(/unknown alias target/i);
    await expect(svc.create({ itemCode: 'X', replacedById: 999999 }, actor)).rejects.toThrow(/unknown alias target/i);
  });
});

describe('ItemsService planning knobs (ItemEntity ST row)', () => {
  // The site owner is derived from existing ST rows — seed one so a native ST
  // row can be minted for an item that has none.
  async function seedSite() {
    await addEntity(prisma, { id: 4, code: 'SITE' });
    await addItem(prisma, { id: 20, code: 'HAS-ST' });
    await prisma.itemEntity.create({ data: { id: 500, itemId: 20, entityId: 4, context: 'ST', minimumStock: 5 } });
  }

  it('mints a native ST row (Entity = the site) for an item without one', async () => {
    const svc = itemsService();
    const actor = await seedActor(prisma);
    await seedSite();
    await addItem(prisma, { id: 21, code: 'NO-ST' });

    const before = await svc.getPlanning(21);
    expect(before.minimumStock).toBeNull();

    await svc.updatePlanning(21, { minimumStock: 12, leadTime: 7, testingLeadTime: 3 }, actor);
    const st = await prisma.itemEntity.findFirst({ where: { itemId: 21, context: 'ST' } });
    expect(st?.id).toBeGreaterThanOrEqual(NATIVE_BASE);
    expect(st?.entityId).toBe(4);
    expect(st?.minimumStock).toBe(12);
    expect(st?.leadTime).toBe(7);
    expect(st?.testingLeadTime).toBe(3);

    const after = await svc.getPlanning(21);
    expect(after.minimumStock).toBe(12);
  });

  it('updates an existing ST row in place (no new row minted)', async () => {
    const svc = itemsService();
    const actor = await seedActor(prisma);
    await seedSite();

    await svc.updatePlanning(20, { minimumStock: 99 }, actor);
    const rows = await prisma.itemEntity.findMany({ where: { itemId: 20, context: 'ST' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(500);
    expect(rows[0].minimumStock).toBe(99);
    expect(await prisma.auditLog.count({ where: { action: 'item.planning.update' } })).toBe(1);
  });
});

describe('ItemsService packaged-product bindings', () => {
  it('creates a binding (native id), rejects a duplicate and bad refs', async () => {
    const svc = itemsService();
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 30, code: 'BULK' });
    await addItem(prisma, { id: 31, code: 'PROTO' });
    await addItem(prisma, { id: 32, code: 'PACKED' });

    const { id } = await svc.createPackagedProduct(30, { packagingPrototypeId: 31, packagedProductId: 32 }, actor);
    expect(id).toBeGreaterThanOrEqual(NATIVE_BASE);
    const binding = await prisma.itemPackagedProduct.findUnique({ where: { id } });
    expect(binding?.itemId).toBe(30);
    expect(binding?.packagedProductId).toBe(32);
    expect(binding?.qty).toBe(1);

    const listed = await svc.listPackagedProducts(30);
    expect(listed.rows[0].packagedProductCode).toBe('PACKED');

    await expect(svc.createPackagedProduct(30, { packagingPrototypeId: 31, packagedProductId: 32 }, actor)).rejects.toThrow(/already exists/i);
    await expect(svc.createPackagedProduct(30, { packagingPrototypeId: 31, packagedProductId: 999999 }, actor)).rejects.toThrow(/unknown packaged product/i);
  });

  it('rejects a recipe hint that is not an RMPP recipe', async () => {
    const svc = itemsService();
    const actor = await seedActor(prisma);
    await addItem(prisma, { id: 30, code: 'BULK' });
    await addItem(prisma, { id: 31, code: 'PROTO' });
    await addItem(prisma, { id: 32, code: 'PACKED' });
    await prisma.recipe.create({ data: { id: 700, context: 'RMBA', isPublished: true } });

    await expect(
      svc.createPackagedProduct(30, { packagingPrototypeId: 31, packagedProductId: 32, recipeId: 700 }, actor),
    ).rejects.toThrow(/packaging \(RMPP\) recipe/i);
  });
});

describe('ItemsService item picker', () => {
  it('filters by context', async () => {
    const svc = itemsService();
    await addItem(prisma, { id: 40, code: 'AAA' });
    await prisma.item.update({ where: { id: 40 }, data: { context: 'PROTOTYPE' } });
    await addItem(prisma, { id: 41, code: 'BBB' });
    await prisma.item.update({ where: { id: 41 }, data: { context: 'PP' } });

    const protos = await svc.itemOptions(undefined, 'PROTOTYPE');
    expect(protos.rows.map((r) => r.id)).toEqual([40]);
  });
});
