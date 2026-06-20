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
