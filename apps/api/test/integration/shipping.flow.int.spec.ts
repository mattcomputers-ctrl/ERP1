import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { addEntity, addItem, addOrder, makePrisma, resetDb, seedActor, services } from './support';

// Flow integration test: the real ShippingService against a real Postgres,
// exercising the full create path (validation + native-id allocation + audit).

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

describe('ShippingService.create (native SH order)', () => {
  it('creates a well-formed SH order (Entity null, ShipTo defaults to BillTo, lines Context=SH, Owner resolved)', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true, isShipTo: true });
    await addItem(prisma, { id: 1, code: 'WIDGET', unit: 'ea' });
    await addOrder(prisma, { id: 500, context: 'MFBA', ownerId: 4 }); // prior order so the owner resolution finds our org
    const { shipping } = services(prisma);

    const res = await shipping.create(
      { billToId: customer, poNumber: 'CPO-1', lines: [{ itemId: 1, qtyReqd: 25, price: 3.5 }] },
      actor,
    );
    expect(res.status).toBe('NST');
    expect(res.lines).toBe(1);
    expect(res.id).toBeGreaterThanOrEqual(1_000_000_000);

    const order = (await prisma.ordr.findUnique({ where: { id: res.id } }))!;
    expect(order.context).toBe('SH');
    expect(order.entityId).toBeNull();
    expect(order.billToId).toBe(customer);
    expect(order.shipToId).toBe(customer); // defaulted to BillTo
    expect(order.ownerId).toBe(4); // resolved data-drivenly from prior orders
    expect(order.poNumber).toBe('CPO-1');

    const lines = await prisma.ordDetail.findMany({ where: { ordrId: res.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].context).toBe('SH');
    expect(lines[0].itemId).toBe(1);
    expect(lines[0].qtyReqd).toBe(25);
    expect(Number(lines[0].price)).toBe(3.5);

    // The action is audited under the seeded actor.
    const audits = await prisma.auditLog.findMany({ where: { action: 'shippingorder.create' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(actor.id);
  });

  it('creates multiple distinct line items with sequenced ids/sortOrder and per-line item fallbacks', async () => {
    const customer = await addEntity(prisma, { id: 100, isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea', description: 'Item A' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'lb', description: 'Item B' });
    const { shipping } = services(prisma);

    const res = await shipping.create(
      { billToId: customer, lines: [{ itemId: 1, qtyReqd: 10, price: 2 }, { itemId: 2, qtyReqd: 5, price: 3 }] },
      actor,
    );
    expect(res.lines).toBe(2);

    const lines = await prisma.ordDetail.findMany({ where: { ordrId: res.id }, orderBy: { sortOrder: 'asc' } });
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.id)).size).toBe(2); // distinct ids
    expect(lines.map((l) => l.sortOrder)).toEqual([1, 2]);
    expect(lines.map((l) => l.itemId)).toEqual([1, 2]);
    // Each line defaults entityUnit/description from its OWN item.
    expect(lines[0].entityUnit).toBe('ea');
    expect(lines[1].entityUnit).toBe('lb');
    // Audit summary reflects the multi-line subtotal (10*2 + 5*3 = 35).
    const audit = (await prisma.auditLog.findFirst({ where: { action: 'shippingorder.create' } }))!;
    expect(audit.summary).toContain('35.00');
  });

  it('sources a line price from the customer price list (tiered) when no explicit price is given; an override wins', async () => {
    const { shipping, salesPricing } = services(prisma);
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'WIDGET', unit: 'ea' });
    // A price list with a quantity-break tier, with the customer assigned to it.
    const list = await salesPricing.createPriceList({ name: 'Retail' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2020-01-01' }, actor);
    await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 1, minOrder1: 1, price1: 10, minOrder2: 100, price2: 7 }, actor);
    await salesPricing.assignCustomer(list.id, { customerId: customer }, actor);

    // No explicit price; qty 250 → the $7 tier from the customer's effective list.
    const res = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 250 }] }, actor);
    expect(res.sourcedLines).toBe(1);
    expect(Number((await prisma.ordDetail.findFirst({ where: { ordrId: res.id } }))!.price)).toBe(7);

    // An explicit operator price overrides the list price.
    const res2 = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 250, price: 5 }] }, actor);
    expect(Number((await prisma.ordDetail.findFirst({ where: { ordrId: res2.id } }))!.price)).toBe(5);
  });

  it('honors a separate ship-to and validates its flag', async () => {
    const customer = await addEntity(prisma, { id: 100, isBillTo: true });
    const shipTo = await addEntity(prisma, { id: 101, isShipTo: true });
    await addItem(prisma, { id: 1 });
    const { shipping } = services(prisma);

    const res = await shipping.create({ billToId: customer, shipToId: shipTo, lines: [{ itemId: 1, qtyReqd: 5 }] }, actor);
    const order = (await prisma.ordr.findUnique({ where: { id: res.id } }))!;
    expect(order.billToId).toBe(customer);
    expect(order.shipToId).toBe(shipTo);
  });

  it('rejects a bill-to that is not a customer, an invalid ship-to, and an unknown item', async () => {
    const notCustomer = await addEntity(prisma, { id: 102, isBillTo: false });
    const customer = await addEntity(prisma, { id: 103, isBillTo: true });
    const notShipTo = await addEntity(prisma, { id: 104, isShipTo: false });
    await addItem(prisma, { id: 1 });
    const { shipping } = services(prisma);

    await expect(shipping.create({ billToId: notCustomer, lines: [{ itemId: 1, qtyReqd: 1 }] }, actor)).rejects.toThrow(/not flagged as a customer/);
    await expect(shipping.create({ billToId: customer, shipToId: notShipTo, lines: [{ itemId: 1, qtyReqd: 1 }] }, actor)).rejects.toThrow(/not flagged as a ship-to/);
    await expect(shipping.create({ billToId: customer, lines: [{ itemId: 999, qtyReqd: 1 }] }, actor)).rejects.toThrow(/Unknown item/);
  });
});

describe('ShippingService line edits (not-started SH order)', () => {
  it('adds a line (native id, SH context, sequenced sortOrder, item fallbacks) and audits it', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'lb' });
    const { shipping } = services(prisma);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 10, price: 2 }] }, actor);

    const r = await shipping.addLine(order.id, { itemId: 2, qtyReqd: 5, price: 3 }, actor);
    expect(r.lineId).toBeGreaterThanOrEqual(1_000_000_000);

    const lines = await prisma.ordDetail.findMany({ where: { ordrId: order.id }, orderBy: { sortOrder: 'asc' } });
    expect(lines).toHaveLength(2);
    const added = lines.find((l) => l.id === r.lineId)!;
    expect(added.context).toBe('SH');
    expect(added.itemId).toBe(2);
    expect(added.qtyReqd).toBe(5);
    expect(Number(added.price)).toBe(3);
    expect(added.entityUnit).toBe('lb'); // defaulted from the item
    expect(added.sortOrder).toBe(2); // appended after the create line

    const audit = await prisma.auditLog.findFirst({ where: { action: 'shippingorder.line.add' } });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(actor.id);
  });

  it('sources the added line price from the customer price list; an explicit price wins', async () => {
    const { shipping, salesPricing } = services(prisma);
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'ea' });
    const list = await salesPricing.createPriceList({ name: 'Retail' }, actor);
    const v = await salesPricing.createPriceVersion(list.id, { effectiveDate: '2020-01-01' }, actor);
    await salesPricing.addPriceDetail(list.id, v.id, { invItemId: 2, minOrder1: 1, price1: 9 }, actor);
    await salesPricing.assignCustomer(list.id, { customerId: customer }, actor);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1, price: 1 }] }, actor);

    // No explicit price -> the $9 list price for the customer is sourced.
    const r = await shipping.addLine(order.id, { itemId: 2, qtyReqd: 1 }, actor);
    expect(r.sourced).toBe(true);
    expect(Number((await prisma.ordDetail.findUnique({ where: { id: r.lineId } }))!.price)).toBe(9);

    // An explicit operator price overrides the list price.
    const r2 = await shipping.addLine(order.id, { itemId: 2, qtyReqd: 1, price: 4 }, actor);
    expect(Number((await prisma.ordDetail.findUnique({ where: { id: r2.lineId } }))!.price)).toBe(4);
  });

  it('rejects an unknown item on add, and leaves price null when there is no list price and no override', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    const { shipping } = services(prisma);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1, price: 2 }] }, actor);

    await expect(shipping.addLine(order.id, { itemId: 9999, qtyReqd: 1 }, actor)).rejects.toThrow(/Unknown item/);

    // No price list for this customer and no explicit price -> price stays null (not 0).
    const r = await shipping.addLine(order.id, { itemId: 1, qtyReqd: 1 }, actor);
    expect(r.sourced).toBe(false);
    expect((await prisma.ordDetail.findUnique({ where: { id: r.lineId } }))!.price).toBeNull();
  });

  it('keeps sortOrder monotonic (max-based) across adds and an add after a middle removal', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'ea' });
    await addItem(prisma, { id: 3, code: 'C', unit: 'ea' });
    const { shipping } = services(prisma);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1 }] }, actor);

    const a2 = await shipping.addLine(order.id, { itemId: 2, qtyReqd: 1 }, actor);
    const a3 = await shipping.addLine(order.id, { itemId: 3, qtyReqd: 1 }, actor);
    expect((await prisma.ordDetail.findUnique({ where: { id: a2.lineId } }))!.sortOrder).toBe(2);
    expect((await prisma.ordDetail.findUnique({ where: { id: a3.lineId } }))!.sortOrder).toBe(3);

    // Remove the MIDDLE line (sortOrder 2); survivors carry sortOrder {1, 3}.
    await shipping.removeLine(order.id, a2.lineId, actor);

    // Count-based logic would reissue 3 (a collision with the surviving line);
    // the max-based sequence yields 4 and stays unique.
    const a4 = await shipping.addLine(order.id, { itemId: 2, qtyReqd: 1 }, actor);
    const newSort = (await prisma.ordDetail.findUnique({ where: { id: a4.lineId } }))!.sortOrder!;
    expect(newSort).toBe(4);
    const surviving = await prisma.ordDetail.findMany({ where: { ordrId: order.id }, select: { sortOrder: true } });
    expect(surviving.filter((l) => l.sortOrder === newSort)).toHaveLength(1);
  });

  it('updates qty / price / unit / description on a line and audits the changes', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    const { shipping } = services(prisma);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 10, price: 2 }] }, actor);
    const line = (await prisma.ordDetail.findFirst({ where: { ordrId: order.id } }))!;
    const auditCount = () => prisma.auditLog.count({ where: { action: 'shippingorder.line.update' } });

    await shipping.updateLine(order.id, line.id, { qtyReqd: 25, price: 4.5, unit: 'cs', description: 'Custom blend' }, actor);
    const updated = (await prisma.ordDetail.findUnique({ where: { id: line.id } }))!;
    expect(updated.qtyReqd).toBe(25);
    expect(Number(updated.price)).toBe(4.5);
    expect(updated.entityUnit).toBe('cs');
    expect(updated.description).toBe('Custom blend');
    expect(await auditCount()).toBe(1);

    // Empty strings clear the field (coerce to null), not store ''.
    await shipping.updateLine(order.id, line.id, { unit: '', description: '' }, actor);
    const cleared = (await prisma.ordDetail.findUnique({ where: { id: line.id } }))!;
    expect(cleared.entityUnit).toBeNull();
    expect(cleared.description).toBeNull();
    expect(await auditCount()).toBe(2);

    // A no-op update (no fields) short-circuits before the tx — no new audit row.
    const r = await shipping.updateLine(order.id, line.id, {}, actor);
    expect(r).toMatchObject({ unchanged: true });
    expect(await auditCount()).toBe(2);
  });

  it('rejects updating/removing a line that is not on the order (IDOR)', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    const { shipping } = services(prisma);
    const a = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1 }] }, actor);
    const b = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1 }] }, actor);
    const bLine = (await prisma.ordDetail.findFirst({ where: { ordrId: b.id } }))!;

    await expect(shipping.updateLine(a.id, bLine.id, { qtyReqd: 2 }, actor)).rejects.toThrow(/not on shipping order/);
    await expect(shipping.removeLine(a.id, bLine.id, actor)).rejects.toThrow(/not on shipping order/);
  });

  it('removes a line but refuses to remove the last one', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    await addItem(prisma, { id: 2, code: 'B', unit: 'ea' });
    const { shipping } = services(prisma);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1 }, { itemId: 2, qtyReqd: 1 }] }, actor);
    const lines = await prisma.ordDetail.findMany({ where: { ordrId: order.id }, orderBy: { sortOrder: 'asc' } });

    await shipping.removeLine(order.id, lines[0].id, actor);
    expect(await prisma.ordDetail.count({ where: { ordrId: order.id } })).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { action: 'shippingorder.line.remove' } })).not.toBeNull();

    // The remaining single line can't be removed.
    await expect(shipping.removeLine(order.id, lines[1].id, actor)).rejects.toThrow(/at least one line/);
  });

  it('refuses all line edits once the order is no longer Not-started', async () => {
    const customer = await addEntity(prisma, { id: 100, code: 'CUST', isBillTo: true });
    await addItem(prisma, { id: 1, code: 'A', unit: 'ea' });
    const { shipping } = services(prisma);
    const order = await shipping.create({ billToId: customer, lines: [{ itemId: 1, qtyReqd: 1 }] }, actor);
    const line = (await prisma.ordDetail.findFirst({ where: { ordrId: order.id } }))!;
    await prisma.ordr.update({ where: { id: order.id }, data: { status: 'RLS' } });

    await expect(shipping.addLine(order.id, { itemId: 1, qtyReqd: 1 }, actor)).rejects.toThrow(/not-started/);
    await expect(shipping.updateLine(order.id, line.id, { qtyReqd: 2 }, actor)).rejects.toThrow(/not-started/);
    await expect(shipping.removeLine(order.id, line.id, actor)).rejects.toThrow(/not-started/);
  });
});
