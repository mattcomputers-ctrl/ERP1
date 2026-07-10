import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NATIVE_ID_BASE } from '../../src/common/locks';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrder,
  addSublot,
  makePrisma,
  onHandForLot,
  resetDb,
  seedActor,
  services,
} from './support';

// L115: warehouse transfers (TI invoices — relocate to consigned stock) and
// customer returns / credits (negative SH lines + native invoice reversal).

const prisma = makePrisma();
afterAll(async () => prisma.$disconnect());

const WHS = 511;
const ITEM = 76001;
const CUSTOMER = 77001;
const WAREHOUSE = 77002;
const ORDER = 78001;
const LINE = 79001;
const LINE_RET = 79002;

async function base(opts?: { warehouse?: boolean; retLine?: boolean }) {
  const actor = await seedActor(prisma, true);
  await addLocation(prisma, { id: WHS, code: 'WHS1', context: 'WHS' });
  await addItem(prisma, { id: ITEM, code: 'FG-9', lotTracked: true, unit: 'lb' });
  await addEntity(prisma, { id: CUSTOMER, code: 'CUST', isBillTo: true, isShipTo: true });
  await addEntity(prisma, { id: WAREHOUSE, code: 'PT CONSIGN', isShipTo: true, isWarehouse: true });
  await addOrder(prisma, {
    id: ORDER, context: 'SH', status: 'RTS', billToId: CUSTOMER,
    shipToId: opts?.warehouse ? WAREHOUSE : CUSTOMER,
  });
  await addOrdDetail(prisma, { id: LINE, ordrId: ORDER, context: 'SH', itemId: ITEM, qtyReqd: 80, price: 2.5 });
  if (opts?.retLine) {
    await addOrdDetail(prisma, { id: LINE_RET, ordrId: ORDER, context: 'SH', itemId: ITEM, qtyReqd: -40, price: 2.5 });
  }
  await addLot(prisma, { lot: 'FGW1', itemId: ITEM, unitCost: 3 });
  await addSublot(prisma, { id: 86001, lot: 'FGW1' });
  const parcel = await addInventory(prisma, { itemId: ITEM, sublotId: 86001, locationId: WHS, qty: 100 });
  return { actor, parcel };
}

describe('L115a — warehouse transfers (TI)', () => {
  beforeEach(async () => resetDb(prisma));

  it('shipLots to a warehouse relocates stock into the consigned location (owner changes on the ledger)', async () => {
    const { actor, parcel } = await base({ warehouse: true });
    const svc = services(prisma);

    const res = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 80, ordDetailId: LINE }] }, actor);
    expect(res.warehouseTransfer).toBeTruthy();

    // Source depleted, consigned parcel minted — on-hand CONSERVED.
    expect((await prisma.inventory.findUnique({ where: { id: parcel } }))?.qty).toBe(20);
    const consignedLoc = await prisma.location.findFirst({ where: { ownerId: WAREHOUSE, context: 'WHS' } });
    expect(consignedLoc).toBeTruthy();
    expect(consignedLoc!.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    const consignedParcel = await prisma.inventory.findFirst({ where: { locationId: consignedLoc!.id } });
    expect(consignedParcel?.qty).toBe(80);
    expect(consignedParcel?.sublotId).toBe(86001);
    expect(consignedParcel?.ordDetailId).toBeNull();
    expect(await onHandForLot(prisma, 'FGW1')).toBe(100);

    // The verified legacy movement pair: valued SH US legs out (owner = own
    // company) + valued TRNSFR MK legs into the consigned location (owner =
    // the WAREHOUSE entity), both change sets order-linked.
    const trnsfrCs = await prisma.changeSet.findFirst({ where: { context: 'TRNSFR', ordrId: ORDER } });
    expect(trnsfrCs).toBeTruthy();
    const mvs = await prisma.invMovement.findMany({ where: { changeSetId: trnsfrCs!.id }, select: { id: true, context: true } });
    expect(mvs.every((m) => m.context === 'TRNSFR')).toBe(true);
    const legs = await prisma.invMovementDtl.findMany({ where: { invMovementId: { in: mvs.map((m) => m.id) } } });
    expect(legs).toHaveLength(1);
    expect(legs[0].context).toBe('MK');
    expect(legs[0].ownerId).toBe(WAREHOUSE);
    expect(legs[0].qty).toBe(80);
    expect(Number(legs[0].value)).toBeCloseTo(240, 4); // 80 × cost 3

    // Reuses the same consigned location on the next shipment.
    await addLot(prisma, { lot: 'FGW2', itemId: ITEM, unitCost: 3 });
    await addSublot(prisma, { id: 86002, lot: 'FGW2' });
    await addInventory(prisma, { itemId: ITEM, sublotId: 86002, locationId: WHS, qty: 10 });
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW2', qty: 10, ordDetailId: LINE }] }, actor);
    const locs = await prisma.location.findMany({ where: { ownerId: WAREHOUSE, context: 'WHS' } });
    expect(locs).toHaveLength(1);
  });

  it('invoicing a warehouse order mints a TI: T-sequence, zero prices, no taxes; listed in the browser', async () => {
    const { actor } = await base({ warehouse: true });
    const svc = services(prisma);
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 80, ordDetailId: LINE }] }, actor);

    const inv = await svc.invoices.generate({ orderId: ORDER }, actor);
    expect(inv.invoiceNumber).toBe('T00000001');
    expect(inv.subtotal).toBe(0);
    expect(inv.taxes).toEqual([0, 0, 0]);
    const trans = await prisma.trans.findUnique({ where: { id: inv.id } });
    expect(trans?.context).toBe('TI');
    const details = await prisma.transDetail.findMany({ where: { transId: inv.id } });
    expect(details).toHaveLength(1);
    expect(details[0].qty).toBe(80);
    expect(Number(details[0].price)).toBe(0);

    // Fully billed — a second TI finds nothing.
    await expect(svc.invoices.generate({ orderId: ORDER }, actor)).rejects.toThrow(/Nothing to invoice/);

    // The browser lists TI rows now.
    const list = await svc.invoices.list({ q: 'T00000001' } as never);
    expect(list.rows.some((r: { invoiceNumber: string | null }) => r.invoiceNumber === 'T00000001')).toBe(true);
  });
});

describe('L115b — customer returns and invoice reversal', () => {
  beforeEach(async () => resetDb(prisma));

  it('a negative ship entry brings the lot back into stock with the legacy return shape and bills as a credit', async () => {
    const { actor } = await base({ retLine: true });
    const svc = services(prisma);

    // Ship the normal line AND take the return in one event.
    const res = await svc.orders.shipLots(
      ORDER,
      { lots: [{ lot: 'FGW1', qty: 80, ordDetailId: LINE }, { lot: 'FGW1', qty: -40, ordDetailId: LINE_RET }] },
      actor,
    );
    expect(res.returned).toEqual([{ lot: 'FGW1', qty: 40, locationId: WHS }]);

    // Net stock: 100 − 80 shipped + 40 returned = 60.
    expect(await onHandForLot(prisma, 'FGW1')).toBe(60);

    // QtyUsed stamps signed.
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE_RET } }))?.qtyUsed).toBe(-40);

    // The return leg: POSITIVE line-stamped US leg, valued at cost, under the
    // SH change set (order 182437's verified legs).
    const shipCs = await prisma.changeSet.findFirst({ where: { context: 'SH', ordrId: ORDER } });
    const mvs = await prisma.invMovement.findMany({ where: { changeSetId: shipCs!.id }, select: { id: true } });
    const legs = await prisma.invMovementDtl.findMany({ where: { invMovementId: { in: mvs.map((m) => m.id) } } });
    const returnLeg = legs.find((l) => (l.qty ?? 0) > 0)!;
    expect(returnLeg.context).toBe('US');
    expect(returnLeg.qty).toBe(40);
    expect(returnLeg.ordDetailId).toBe(LINE_RET);
    expect(Number(returnLeg.value)).toBeCloseTo(120, 4); // +40 × cost 3

    // Billing: 80 × 2.5 − 40 × 2.5 = 100 (the credit nets).
    const inv = await svc.invoices.generate({ orderId: ORDER }, actor);
    expect(inv.subtotal).toBeCloseTo(80 * 2.5 - 40 * 2.5, 6);
    const details = await prisma.transDetail.findMany({ where: { transId: inv.id }, orderBy: { id: 'asc' } });
    expect(details.map((d) => d.qty)).toEqual([80, -40]);
  });

  it('zero ship quantities are refused', async () => {
    const { actor } = await base();
    const svc = services(prisma);
    await expect(
      svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 0, ordDetailId: LINE }] }, actor),
    ).rejects.toThrow(/non-zero/);
  });

  it('entry sign must match the linked line: no returns on sale lines, no shipments on return lines', async () => {
    const { actor } = await base({ retLine: true });
    const svc = services(prisma);
    await expect(
      svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: -5, ordDetailId: LINE }] }, actor),
    ).rejects.toThrow(/sale line — record returns on a return/);
    await expect(
      svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 5, ordDetailId: LINE_RET }] }, actor),
    ).rejects.toThrow(/return line — link shipped quantities to a sale line/);
  });

  it('warehouse-transfer orders refuse return entries (consigned stock comes back by transfer)', async () => {
    const { actor } = await base({ warehouse: true, retLine: true });
    const svc = services(prisma);
    await expect(
      svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: -5, ordDetailId: LINE_RET }] }, actor),
    ).rejects.toThrow(/cannot take return entries/);
  });

  it('consigned stock is untouchable by other orders, batch consumption, and the pickers', async () => {
    const { actor, parcel } = await base({ warehouse: true });
    const svc = services(prisma);
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 80, ordDetailId: LINE }] }, actor);
    // Plant stock: 20 free; 80 consigned at the warehouse's location.

    // Another customer order shipping the same lot gets only the free 20.
    const ORDER_B = 78002;
    const LINE_B = 79101;
    await addOrder(prisma, { id: ORDER_B, context: 'SH', status: 'RTS', billToId: CUSTOMER, shipToId: CUSTOMER });
    await addOrdDetail(prisma, { id: LINE_B, ordrId: ORDER_B, context: 'SH', itemId: ITEM, qtyReqd: 100, price: 2.5 });
    const res = await svc.orders.shipLots(ORDER_B, { lots: [{ lot: 'FGW1', qty: 100, ordDetailId: LINE_B }] }, actor);
    expect(res.shortfalls).toEqual([{ lot: 'FGW1', shortfall: 80 }]);
    const consignedLoc = await prisma.location.findFirst({ where: { ownerId: WAREHOUSE, context: 'WHS' } });
    const consignedParcel = await prisma.inventory.findFirst({ where: { locationId: consignedLoc!.id } });
    expect(consignedParcel?.qty).toBe(80); // untouched

    // FIFO (batch-style) consumption sees nothing either (free stock is gone).
    const { NATIVE_ID_ALLOC_LOCK } = await import('../../src/common/locks');
    const fifo = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      return svc.valuation.depleteFifoMany(tx, [{ itemId: ITEM, qty: 50 }]);
    });
    expect(fifo.get(ITEM)!.depleted).toBe(0);
    expect((await prisma.inventory.findFirst({ where: { locationId: consignedLoc!.id } }))?.qty).toBe(80);

    // And the ship-lot picker never offers the consigned parcel as free stock.
    const opts = await svc.orders.shipLotOptions(ORDER_B);
    const lots = opts.lines.find((l) => l.ordDetailId === LINE_B)!.lots;
    expect(lots.find((l: { lot: string }) => l.lot === 'FGW1')).toBeUndefined(); // 0 free left
    expect(parcel).toBeGreaterThan(0);
  });

  it('TI generation refuses a freight charge', async () => {
    const { actor } = await base({ warehouse: true });
    const svc = services(prisma);
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 80, ordDetailId: LINE }] }, actor);
    await expect(svc.invoices.generate({ orderId: ORDER, freightCharge: 25 }, actor)).rejects.toThrow(/no freight/);
  });

  it('reversing an invoice posts a same-number credit and makes the order billable again', async () => {
    const { actor } = await base();
    const svc = services(prisma);
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGW1', qty: 80, ordDetailId: LINE }] }, actor);

    const inv1 = await svc.invoices.generate({ orderId: ORDER }, actor);
    expect(inv1.invoiceNumber).toBe('N00000001');

    // Fully billed → nothing further.
    await expect(svc.invoices.generate({ orderId: ORDER }, actor)).rejects.toThrow(/Nothing to invoice/);

    // Reverse: same document number, negated details, ReversedTrans link.
    const rev = await svc.invoices.reverse(inv1.id, actor);
    expect(rev.invoiceNumber).toBe('N00000001');
    const revTrans = await prisma.trans.findUnique({ where: { id: rev.id } });
    expect(revTrans?.transDocument).toBe('N00000001');
    expect(revTrans?.reversedTransId).toBe(inv1.id);
    const revDetails = await prisma.transDetail.findMany({ where: { transId: rev.id } });
    expect(revDetails.map((d) => d.qty)).toEqual([-80]);

    // The pair nets out — the shipped 80 is invoiceable again (the legacy
    // same-day re-bill pattern, 330 pairs in 2026 YTD).
    const inv2 = await svc.invoices.generate({ orderId: ORDER }, actor);
    expect(inv2.invoiceNumber).toBe('N00000002');
    expect(inv2.subtotal).toBeCloseTo(200, 6);

    // Guards: can't reverse a reversal; can't reverse the same invoice twice.
    await expect(svc.invoices.reverse(rev.id, actor)).rejects.toThrow(/itself a reversal/);
    await expect(svc.invoices.reverse(inv1.id, actor)).rejects.toThrow(/already been reversed/);
  });
});
