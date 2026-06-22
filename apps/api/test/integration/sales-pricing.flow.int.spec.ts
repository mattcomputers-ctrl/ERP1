import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { NATIVE_ID_BASE } from '../../src/common/locks';
import { addEntity, addItem, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the real SalesPricingService against a real Postgres —
// the read+write price-list editor (create list/version/detail, assign customers)
// and the customer→list→version→detail price resolution.

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
});

describe('SalesPricingService — editor writes', () => {
  it('creates a price list as a native Entity(IsPriceList) + Address + AddressReference', async () => {
    const { salesPricing } = services(prisma);
    const res = await salesPricing.createPriceList({ name: 'Standard Retail' }, actor);

    expect(res.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE + 1);
    expect(res.code).toBe(`PL${res.id}`);
    const entity = (await prisma.entity.findUnique({ where: { id: res.id } }))!;
    expect(entity.isPriceList).toBe(true);
    const ref = await prisma.addressReference.findFirst({ where: { tableName: 'Entity', tableId: res.id, reference: 'Address' } });
    expect(ref).not.toBeNull();
    const addr = (await prisma.address.findUnique({ where: { id: ref!.address } }))!;
    expect(addr.name).toBe('Standard Retail');
  });

  it('rejects a duplicate explicit code', async () => {
    const { salesPricing } = services(prisma);
    await salesPricing.createPriceList({ name: 'A', code: 'RETAIL' }, actor);
    await expect(salesPricing.createPriceList({ name: 'B', code: 'RETAIL' }, actor)).rejects.toThrow(/already in use/);
  });

  it('adds versions (auto-incrementing version) and details with native ids', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET', unit: 'ea' });
    const list = await salesPricing.createPriceList({ name: 'List' }, actor);

    const v1 = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2025-01-01' }, actor);
    const v2 = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2026-01-01' }, actor);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.id).toBeGreaterThan(v1.id);
    expect(v1.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE + 1);

    const d = await salesPricing.addPriceDetail(list.id, v2.id, { invItemId: 1, minOrder1: 1, price1: 9.5 }, actor);
    const detail = (await prisma.priceDetail.findUnique({ where: { id: d.id } }))!;
    expect(detail.priceVersionId).toBe(v2.id);
    // Native sales details set Item == InvItem (no name alias).
    expect(detail.itemId).toBe(1);
    expect(detail.invItemId).toBe(1);
    expect(Number(detail.price1)).toBe(9.5);
  });

  it('rejects adding a detail to a version that belongs to a DIFFERENT list (IDOR)', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1 });
    const listA = await salesPricing.createPriceList({ name: 'A' }, actor);
    const listB = await salesPricing.createPriceList({ name: 'B' }, actor);
    const vB = await salesPricing.createPriceVersion(listB.id, { effectiveDate: '2025-01-01' }, actor);
    await expect(
      salesPricing.addPriceDetail(listA.id, vB.id, { invItemId: 1, price1: 1 }, actor),
    ).rejects.toThrow(/not found on this price list/);
  });

  it('updates and deletes a detail (IDOR-safe)', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1 });
    const list = await salesPricing.createPriceList({ name: 'L' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2025-01-01' }, actor);
    const d = await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 1, price1: 5 }, actor);

    await salesPricing.updatePriceDetail(list.id, d.id, { price1: 7.25, entityUnit: 'LB' }, actor);
    let detail = (await prisma.priceDetail.findUnique({ where: { id: d.id } }))!;
    expect(Number(detail.price1)).toBe(7.25);
    expect(detail.entityUnit).toBe('LB');

    // IDOR: a different list cannot touch this detail.
    const other = await salesPricing.createPriceList({ name: 'Other' }, actor);
    await expect(salesPricing.deletePriceDetail(other.id, d.id, actor)).rejects.toThrow(/not found/);

    await salesPricing.deletePriceDetail(list.id, d.id, actor);
    detail = (await prisma.priceDetail.findUnique({ where: { id: d.id } }))!;
    expect(detail).toBeNull();
  });

  it('rejects an unknown pkgTypeId on update (symmetric with create)', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1 });
    const list = await salesPricing.createPriceList({ name: 'L' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2025-01-01' }, actor);
    const d = await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 1, price1: 5 }, actor);
    await expect(salesPricing.updatePriceDetail(list.id, d.id, { pkgTypeId: 999_999 }, actor)).rejects.toThrow(/package-type/);
  });

  it('treats an empty update as a no-op (returns unchanged, writes no audit row)', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1 });
    const list = await salesPricing.createPriceList({ name: 'L' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2025-01-01' }, actor);
    const d = await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 1, price1: 5 }, actor);
    const before = await prisma.auditLog.count();
    const res = await salesPricing.updatePriceDetail(list.id, d.id, {}, actor);
    expect(res).toMatchObject({ unchanged: true });
    expect(await prisma.auditLog.count()).toBe(before); // no misleading audit row
  });

  it('assigns/unassigns a customer, validating the customer role', async () => {
    const { salesPricing } = services(prisma);
    const list = await salesPricing.createPriceList({ name: 'L' }, actor);
    const customer = await addEntity(prisma, { id: 500, code: 'CUST', isBillTo: true });
    const notCustomer = await addEntity(prisma, { id: 501, code: 'SUP', isSupplier: true });

    await expect(salesPricing.assignCustomer(list.id, { customerId: notCustomer }, actor)).rejects.toThrow(/not a customer/);

    await salesPricing.assignCustomer(list.id, { customerId: customer }, actor);
    expect((await prisma.entity.findUnique({ where: { id: customer } }))!.priceListId).toBe(list.id);

    // Unassigning a customer that's on a different list is rejected (no silent detach).
    await expect(salesPricing.unassignCustomer(list.id + 999_999, customer, actor)).rejects.toThrow(/not on this price list/);

    await salesPricing.unassignCustomer(list.id, customer, actor);
    expect((await prisma.entity.findUnique({ where: { id: customer } }))!.priceListId).toBeNull();
  });
});

describe('SalesPricingService — price resolution', () => {
  it('resolves a customer price via list → effective version → detail, tiered by qty', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET', unit: 'ea' });
    const list = await salesPricing.createPriceList({ name: 'L' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2025-01-01' }, actor);
    await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 1, minOrder1: 1, price1: 10, minOrder2: 100, price2: 8 }, actor);
    const customer = await addEntity(prisma, { id: 500, code: 'CUST', isBillTo: true });
    await salesPricing.assignCustomer(list.id, { customerId: customer }, actor);

    expect((await salesPricing.priceForCustomer(customer, 1, 5))!.price).toBe(10); // tier 1
    expect((await salesPricing.priceForCustomer(customer, 1, 250))!.price).toBe(8); // tier 2 (qty ≥ 100)
  });

  it('returns null when the customer has no price list', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1 });
    const customer = await addEntity(prisma, { id: 500, isBillTo: true });
    expect(await salesPricing.priceForCustomer(customer, 1, 1)).toBeNull();
  });

  it('uses the latest effective version and ignores a future-dated one', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1 });
    const list = await salesPricing.createPriceList({ name: 'L' }, actor);
    const past = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2020-01-01' }, actor);
    const future = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2999-01-01' }, actor);
    await salesPricing.addPriceDetail(list.id, past.id, { invItemId: 1, price1: 3 }, actor);
    await salesPricing.addPriceDetail(list.id, future.id, { invItemId: 1, price1: 99 }, actor);
    const customer = await addEntity(prisma, { id: 500, isBillTo: true });
    await salesPricing.assignCustomer(list.id, { customerId: customer }, actor);

    expect((await salesPricing.priceForCustomer(customer, 1, 1))!.price).toBe(3); // past, not the future 99
  });

  it('get() returns the list with its effective details and assigned customers', async () => {
    const { salesPricing } = services(prisma);
    await addItem(prisma, { id: 1, code: 'WIDGET', description: 'A widget', unit: 'ea' });
    const list = await salesPricing.createPriceList({ name: 'Retail List' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2025-01-01' }, actor);
    await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 1, minOrder1: 1, price1: 12 }, actor);
    const customer = await addEntity(prisma, { id: 500, code: 'CUST', isBillTo: true });
    await salesPricing.assignCustomer(list.id, { customerId: customer }, actor);

    const out = await salesPricing.get(list.id);
    expect(out.name).toBe('Retail List');
    expect(out.effectiveVersionId).toBe(v.id);
    expect(out.details).toHaveLength(1);
    expect(out.details[0]).toMatchObject({ itemCode: 'WIDGET', tiers: [{ minOrder: 1, price: 12 }] });
    expect(out.customers.map((c) => c.id)).toContain(customer);
  });
});
