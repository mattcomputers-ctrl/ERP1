import { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import { NATIVE_ID_BASE } from '../../src/common/locks';
import {
  addEntity, addInventory, addItem, addLocation, addLot, addOrdDetail, addOrder,
  addSublot, makePrisma, resetDb, seedActor, services,
} from './support';

// Native invoice generation (Trans Context='CI'): bills a shipping order's
// shipped-but-not-yet-invoiced quantities, copying header fields from the
// order (the live convention), numbering on the plant's N-sequence, and
// taxing via the TaxRule engine.

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

/** SH order with a bill-to (tax group SALES TAX), 10% level-1 rule, two lines. */
async function seedShippedOrder() {
  const { glMasters } = services(prisma);
  await glMasters.createTaxRule({ description: 'SALES TAX', entityTaxGroup: 'SALES TAX', rate: 10, taxNumber: 1 }, actor);
  const billTo = await addEntity(prisma, { id: 9101, code: 'CUST1', isBillTo: true });
  await prisma.entity.update({ where: { id: billTo }, data: { tax1Group: 'SALES TAX' } });
  const salesman = await addEntity(prisma, { id: 9102, code: 'REP1', isSalesman: true });
  await addItem(prisma, { id: 701, code: 'FG1' });
  await addItem(prisma, { id: 702, code: 'FG2' });
  await addOrder(prisma, { id: 8101, context: 'SH', status: 'CMP', billToId: billTo, poNumber: '22294' });
  await prisma.ordr.update({ where: { id: 8101 }, data: { currency: 'USD', salesmanId: salesman } });
  await addOrdDetail(prisma, { id: 81011, ordrId: 8101, context: 'SH', itemId: 701, qtyReqd: 40, price: 2.5, entityUnit: 'lb' });
  await addOrdDetail(prisma, { id: 81012, ordrId: 8101, context: 'SH', itemId: 702, qtyReqd: 10, price: 0 });
  await prisma.ordDetail.update({ where: { id: 81011 }, data: { qtyUsed: 40 } });
  await prisma.ordDetail.update({ where: { id: 81012 }, data: { qtyUsed: 10 } });
  return { billTo, salesman };
}

describe('invoice generation', () => {
  it('bills shipped quantities with taxes, copying the order header', async () => {
    await seedShippedOrder();
    const { invoices } = services(prisma);

    const r = await invoices.generate({ orderId: 8101, freightCharge: 20 }, actor);
    expect(r.invoiceNumber).toBe('N00000001');
    expect(r.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect(r.lines).toBe(2);
    expect(r.subtotal).toBe(100); // 40 x 2.50 + 10 x 0
    expect(r.taxes).toEqual([12, 0, 0]); // 10% of (100 + 20 freight, blank-group rule)

    const trans = await prisma.trans.findUnique({ where: { id: r.id } });
    expect(trans).toMatchObject({
      context: 'CI', transDocument: 'N00000001', ordrId: 8101, billToId: 9101,
      salesmanId: 9102, currency: 'USD', poNumber: '22294',
    });
    expect(Number(trans!.tax1Amount)).toBe(12);
    expect(Number(trans!.freightCharge)).toBe(20);

    const details = await prisma.transDetail.findMany({ where: { transId: r.id }, orderBy: { id: 'asc' } });
    expect(details).toHaveLength(2);
    // Detail rows keep the ORDER context (live convention) and copy line price.
    expect(details[0]).toMatchObject({ context: 'SH', ordDetailId: 81011, itemId: 701, qty: 40 });
    expect(Number(details[0].price)).toBe(2.5);
    expect(details[0].id).toBeGreaterThanOrEqual(NATIVE_ID_BASE);

    // The invoice renders through the existing viewer with correct totals.
    const doc = await invoices.get(r.id);
    expect(doc.totals).toEqual({ subtotal: 100, freight: 20, tax: 12, total: 132 });
    expect(doc.header.invoiceNumber).toBe('N00000001');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'invoice.generate' } });
    expect(audit?.summary).toContain('N00000001');
  });

  it('invoices incrementally per shipment event and refuses when nothing is uninvoiced', async () => {
    await seedShippedOrder();
    const { invoices } = services(prisma);

    // First shipment only covered 30 of line 1 (and all of line 2).
    await prisma.ordDetail.update({ where: { id: 81011 }, data: { qtyUsed: 30 } });
    const first = await invoices.generate({ orderId: 8101 }, actor);
    expect(first.invoiceNumber).toBe('N00000001');
    expect(first.subtotal).toBe(75); // 30 x 2.50

    // Nothing new shipped -> refuse.
    await expect(invoices.generate({ orderId: 8101 }, actor)).rejects.toThrow(/Nothing to invoice/);

    // Second shipment: line 1 reaches 40 -> bill the remaining 10.
    await prisma.ordDetail.update({ where: { id: 81011 }, data: { qtyUsed: 40 } });
    const second = await invoices.generate({ orderId: 8101 }, actor);
    expect(second.invoiceNumber).toBe('N00000002');
    expect(second.subtotal).toBe(25); // 10 x 2.50
    const secondDetails = await prisma.transDetail.findMany({ where: { transId: second.id } });
    expect(secondDetails).toHaveLength(1); // line 2 fully billed on invoice 1
    expect(secondDetails[0].qty).toBe(10);
  });

  it('continues the imported N-sequence and guards order type/state', async () => {
    await seedShippedOrder();
    // An imported legacy invoice holds the sequence high-water mark.
    await prisma.trans.create({ data: { id: 22710, context: 'CI', transDocument: 'N00132725' } });

    const { invoices } = services(prisma);
    const r = await invoices.generate({ orderId: 8101 }, actor);
    expect(r.invoiceNumber).toBe('N00132726');

    // Guards.
    await addOrder(prisma, { id: 8201, context: 'MFBA', status: 'CMP' });
    await expect(invoices.generate({ orderId: 8201 }, actor)).rejects.toThrow(/shipping \(SH\) orders/);
    await addOrder(prisma, { id: 8202, context: 'SH', status: 'NST', billToId: 9101 });
    await expect(invoices.generate({ orderId: 8202 }, actor)).rejects.toThrow(/not shipped/);
    await addOrder(prisma, { id: 8203, context: 'SH', status: 'CMP' });
    await expect(invoices.generate({ orderId: 8203 }, actor)).rejects.toThrow(/no bill-to/);
    await expect(invoices.generate({ orderId: 424242 }, actor)).rejects.toThrow(/not found/);
  });

  it('shipLots stamps QtyUsed so native shipments become invoiceable', async () => {
    await seedShippedOrder();
    const { orders, invoices } = services(prisma);

    // A lot-traced FG item with on-hand, shipped natively against a new order.
    await addItem(prisma, { id: 703, code: 'FG3', lotTracked: true });
    const whs = await addLocation(prisma, { code: 'WHS', context: 'WHS' });
    await addLot(prisma, { lot: '260101001', itemId: 703, unitCost: 1 });
    await addSublot(prisma, { id: 55001, lot: '260101001' });
    await addInventory(prisma, { itemId: 703, sublotId: 55001, locationId: whs, qty: 100 });

    await addOrder(prisma, { id: 8301, context: 'SH', status: 'RLS', billToId: 9101 });
    await addOrdDetail(prisma, { id: 83011, ordrId: 8301, context: 'SH', itemId: 703, qtyReqd: 25, price: 4 });

    // A lot linked to a line of a DIFFERENT item is refused — the stamped
    // quantity feeds billing at that line's price.
    await addOrdDetail(prisma, { id: 83012, ordrId: 8301, context: 'SH', itemId: 701, qtyReqd: 5, price: 99 });
    await expect(
      orders.shipLots(8301, { lots: [{ lot: '260101001', qty: 25, ordDetailId: 83012 }] }, actor),
    ).rejects.toThrow(/not line 83012's item/);

    await orders.shipLots(8301, { lots: [{ lot: '260101001', qty: 25, ordDetailId: 83011 }] }, actor);
    const line = await prisma.ordDetail.findUnique({ where: { id: 83011 }, select: { qtyUsed: true } });
    expect(line?.qtyUsed).toBe(25);

    const r = await invoices.generate({ orderId: 8301 }, actor);
    expect(r.subtotal).toBe(100); // 25 x 4
    expect(r.taxes[0]).toBe(10);
  });
});
