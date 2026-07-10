import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { PriceVersionService } from '../../src/purchasing/price-version.service';
import { SupplierPricingService } from '../../src/purchasing/supplier-pricing.service';
import { PartyService } from '../../src/sales/party.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { addEntity, addItem, makePrisma, resetDb, seedActor } from './support';

// Flow integration test: the supplier price-version editor (L37/L48) — the write
// counterpart of the PO line-sourcing read path.

const NATIVE_BASE = 1_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
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

function svc(): SupplierPricingService {
  const p = prisma as unknown as PrismaService;
  return new SupplierPricingService(p, new AuditService(p), new PartyService(p), new PriceVersionService(p));
}

async function seedSupplier(id = 300) {
  await addEntity(prisma, { id, code: `SUP${id}`, isSupplier: true });
  return id;
}

describe('SupplierPricingService versions', () => {
  it('creates an effective-dated version (native id), auto-numbering, and rejects a non-supplier', async () => {
    const s = svc();
    const actor = await seedActor(prisma);
    const supplierId = await seedSupplier();

    const v1 = await s.createVersion(supplierId, { effectiveDate: '2026-01-01' }, actor);
    expect(v1.id).toBeGreaterThanOrEqual(NATIVE_BASE);
    expect(v1.version).toBe(1);
    const v2 = await s.createVersion(supplierId, { effectiveDate: '2026-06-01' }, actor);
    expect(v2.version).toBe(2);

    await addEntity(prisma, { id: 301, code: 'NOTSUP' });
    await expect(s.createVersion(301, { effectiveDate: '2026-01-01' }, actor)).rejects.toThrow(/supplier not found/i);
  });

  it('get() picks the effective version (latest EffectiveDate ≤ now) and lists its details', async () => {
    const s = svc();
    const actor = await seedActor(prisma);
    const supplierId = await seedSupplier();
    await addItem(prisma, { id: 400, code: 'ITEM-A' });

    const past = await s.createVersion(supplierId, { effectiveDate: new Date(Date.now() - 30 * DAY).toISOString() }, actor);
    const future = await s.createVersion(supplierId, { effectiveDate: new Date(Date.now() + 30 * DAY).toISOString() }, actor);
    await s.addDetail(supplierId, past.id, { itemId: 400, price1: 5, minOrder1: 1 }, actor);
    // A detail on the future version must NOT show as effective.
    await s.addDetail(supplierId, future.id, { itemId: 400, price1: 99, minOrder1: 1 }, actor);

    const got = await s.get(supplierId);
    expect(got.effectiveVersionId).toBe(past.id);
    expect(got.details).toHaveLength(1);
    expect(got.details[0].itemCode).toBe('ITEM-A');
    expect(got.details[0].tiers[0].price).toBe(5);
  });
});

describe('SupplierPricingService details', () => {
  it('allows multiple details per item (different package), rejects an exact duplicate + packaging without a type', async () => {
    const s = svc();
    const actor = await seedActor(prisma);
    const supplierId = await seedSupplier();
    await addItem(prisma, { id: 400, code: 'ITEM-A' });
    await addItem(prisma, { id: 401, code: 'DRUM' });
    await addItem(prisma, { id: 402, code: 'BAG' });
    const v = await s.createVersion(supplierId, { effectiveDate: '2026-01-01' }, actor);

    const d1 = await s.addDetail(supplierId, v.id, { itemId: 400, pkgTypeId: 401, entityQuantity: 400, entityUnit: 'lb', price1: 1.2, minOrder1: 1 }, actor);
    expect(d1.id).toBeGreaterThanOrEqual(NATIVE_BASE);
    // Same item, DIFFERENT package — allowed (362 such live cases).
    const d2 = await s.addDetail(supplierId, v.id, { itemId: 400, pkgTypeId: 402, entityQuantity: 44, entityUnit: 'lb', price1: 1.4, minOrder1: 1 }, actor);
    expect(d2.id).not.toBe(d1.id);
    // Exact (item + package + manufacturer) duplicate — refused.
    await expect(s.addDetail(supplierId, v.id, { itemId: 400, pkgTypeId: 401, price1: 9 }, actor)).rejects.toThrow(/already priced/i);
    // Packaging fields without a package type — refused.
    await expect(s.addDetail(supplierId, v.id, { itemId: 400, entityQuantity: 10, price1: 9 }, actor)).rejects.toThrow(/require a package type/i);

    expect((await s.get(supplierId)).details).toHaveLength(2);
  });

  it('validates references and is IDOR-safe across suppliers', async () => {
    const s = svc();
    const actor = await seedActor(prisma);
    const a = await seedSupplier(300);
    const b = await seedSupplier(310);
    await addItem(prisma, { id: 400, code: 'ITEM-A' });
    const va = await s.createVersion(a, { effectiveDate: '2026-01-01' }, actor);

    await expect(s.addDetail(a, va.id, { itemId: 999999, price1: 1 }, actor)).rejects.toThrow(/unknown item/i);
    await expect(s.addDetail(a, va.id, { itemId: 400, manufacturerId: 999999, price1: 1 }, actor)).rejects.toThrow(/unknown manufacturer/i);
    // Supplier B cannot add to supplier A's version.
    await expect(s.addDetail(b, va.id, { itemId: 400, price1: 1 }, actor)).rejects.toThrow(/not found on this supplier/i);

    const d = await s.addDetail(a, va.id, { itemId: 400, price1: 1 }, actor);
    await expect(s.updateDetail(b, d.id, { price1: 2 }, actor)).rejects.toThrow(/not found on this supplier/i);
    await expect(s.deleteDetail(b, d.id, actor)).rejects.toThrow(/not found on this supplier/i);

    await s.updateDetail(a, d.id, { price1: 2.5, leadTime: 10 }, actor);
    expect(Number((await prisma.priceDetail.findUnique({ where: { id: d.id } }))?.price1)).toBe(2.5);
    await s.deleteDetail(a, d.id, actor);
    expect(await prisma.priceDetail.findUnique({ where: { id: d.id } })).toBeNull();
  });

  it('updateDetail re-asserts packaging all-or-nothing (merged state) and the exact-duplicate identity', async () => {
    const s = svc();
    const actor = await seedActor(prisma);
    const supplierId = await seedSupplier();
    await addItem(prisma, { id: 400, code: 'ITEM-A' });
    await addItem(prisma, { id: 401, code: 'DRUM' });
    await addItem(prisma, { id: 402, code: 'BAG' });
    const v = await s.createVersion(supplierId, { effectiveDate: '2026-01-01' }, actor);
    const perUnit = await s.addDetail(supplierId, v.id, { itemId: 400, price1: 1 }, actor);

    // Packaging fields without a package type on the MERGED row — refused (the
    // by-package trap would otherwise divide the price at valuation).
    await expect(s.updateDetail(supplierId, perUnit.id, { priceByPackage: true, entityQuantity: 50 }, actor)).rejects.toThrow(/require a package type/i);

    // Re-pointing onto another detail's exact (item + package + manufacturer)
    // identity — refused.
    const dDrum = await s.addDetail(supplierId, v.id, { itemId: 400, pkgTypeId: 401, price1: 1.2 }, actor);
    const dBag = await s.addDetail(supplierId, v.id, { itemId: 400, pkgTypeId: 402, price1: 1.4 }, actor);
    await expect(s.updateDetail(supplierId, dBag.id, { pkgTypeId: 401 }, actor)).rejects.toThrow(/already priced/i);
    // A distinct re-point is fine, and editing a detail's own price is fine.
    await s.updateDetail(supplierId, dDrum.id, { price1: 1.25 }, actor);
    expect(Number((await prisma.priceDetail.findUnique({ where: { id: dDrum.id } }))?.price1)).toBe(1.25);
  });
});
