import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NATIVE_ID_BASE } from '../../src/common/locks';
import { PackingSlipService } from '../../src/sales/packing-slip.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  addEntity,
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrder,
  addSublot,
  grantAllSecuredItems,
  makePrisma,
  onHandForLot,
  resetDb,
  seedActor,
  services,
} from './support';

// L60: shipment reversal — the legacy RejectWaybill flow (RVSSH). Reverses ONE
// shipment event (packing slip): restores the shipped stock where it left
// (back into the ASM assembly when staged), negates the STORED forward legs,
// unwinds OrdDetail.QtyUsed, marks the shipment_lot rows reversed, refuses
// while an active invoice bills the shipped quantity.

const prisma = makePrisma();
afterAll(async () => prisma.$disconnect());

const WHS = 611;
const ITEM = 86001;
const CUSTOMER = 87001;
const WAREHOUSE = 87002;
const ORDER = 88001;
const LINE = 89001;
const LINE_RET = 89002;
const SUBLOT = 96001;

async function base(opts?: { warehouse?: boolean; retLine?: boolean }) {
  const actor = await seedActor(prisma, true);
  await addLocation(prisma, { id: WHS, code: 'WHS1', context: 'WHS' });
  await addItem(prisma, { id: ITEM, code: 'FG-60', lotTracked: true, unit: 'lb' });
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
  await addLot(prisma, { lot: 'FGR1', itemId: ITEM, unitCost: 3 });
  await addSublot(prisma, { id: SUBLOT, lot: 'FGR1' });
  const parcel = await addInventory(prisma, { itemId: ITEM, sublotId: SUBLOT, locationId: WHS, qty: 100 });
  // The reversal gate: reason-only in these flows (signature paths are covered
  // by the elevation suite — same helpers as the batch reversal).
  await prisma.securedItem.create({
    data: { key: 'order.reverse', description: 'order.reverse', requireReason: true, requireSignature: false, requireWitness: false },
  });
  await grantAllSecuredItems(prisma, actor.id);
  return { actor, parcel };
}

describe('L60 — shipment reversal (plain shipment)', () => {
  beforeEach(async () => resetDb(prisma));

  it('reverses a shipment end-to-end: stock, stored-leg negation, QtyUsed, marks, change-set shape', async () => {
    const { actor, parcel } = await base();
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    const psId = ship.packingSlipId;
    expect(await onHandForLot(prisma, 'FGR1')).toBe(20);
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE } }))!.qtyUsed).toBe(80);

    // The shipments panel lists the live event.
    const before = await svc.orders.shipments(ORDER);
    expect(before.shipments).toHaveLength(1);
    expect(before.shipments[0].packingSlipId).toBe(psId);
    expect(before.shipments[0].reversedByChangeSetId).toBeNull();

    const res = await svc.orders.reverseShipment(ORDER, { packingSlipId: psId, reason: 'wrong lot picked' }, actor);
    expect(res.reversedBy).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect(res.transferReversedBy).toBeNull();

    // Stock is back — merged into the SAME parcel it left (identity match).
    expect(await onHandForLot(prisma, 'FGR1')).toBe(100);
    expect((await prisma.inventory.findUnique({ where: { id: parcel } }))!.qty).toBe(100);

    // QtyUsed unwound (billing math reads it).
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE } }))!.qtyUsed).toBe(0);

    // The reversing change set: RVSSH, back-pointer, effective-dated to the
    // FORWARD's ChangeDate (the verified legacy convention — at-date nets to
    // zero from the shipment date on).
    const rvs = (await prisma.changeSet.findUnique({ where: { id: res.reversedBy } }))!;
    const fwd = (await prisma.changeSet.findUnique({ where: { id: psId } }))!;
    expect(rvs.context).toBe('RVSSH');
    expect(rvs.reverseChangeSetId).toBe(psId);
    expect(rvs.ordrId).toBe(ORDER);
    expect(rvs.changeDate!.getTime()).toBe(fwd.changeDate!.getTime());

    // Movement negation: header Context='RVSSH' (legacy shape), the leg is the
    // STORED forward leg sign-flipped — qty +80, value +240 (80 × cost 3).
    const rvsMovs = await prisma.invMovement.findMany({ where: { changeSetId: res.reversedBy } });
    expect(rvsMovs).toHaveLength(1);
    expect(rvsMovs[0].context).toBe('RVSSH');
    const rvsLegs = await prisma.invMovementDtl.findMany({ where: { invMovementId: rvsMovs[0].id } });
    expect(rvsLegs).toHaveLength(1);
    expect(rvsLegs[0].context).toBe('US');
    expect(rvsLegs[0].qty).toBe(80);
    expect(Number(rvsLegs[0].value)).toBe(240);
    expect(rvsLegs[0].locationId).toBe(WHS);
    expect(rvsLegs[0].ordDetailId).toBe(LINE);
    // The order's SH legs net to zero, quantity and value.
    const net = await prisma.$queryRaw<{ q: number | null; v: number | null }[]>`
      SELECT SUM(d."Qty")::float8 AS q, SUM(d."Value"::numeric)::float8 AS v
      FROM "InvMovementDtl" d JOIN "InvMovement" im ON im."InvMovement" = d."InvMovement"
      JOIN "ChangeSet" cs ON cs."ChangeSet" = im."ChangeSet" WHERE cs."Ordr" = ${ORDER}`;
    expect(net[0].q).toBe(0);
    expect(net[0].v).toBe(0);

    // shipment_lot rows are MARKED reversed, not deleted (recall reads live rows).
    const sl = await prisma.shipmentLot.findMany({ where: { ordrId: ORDER } });
    expect(sl).toHaveLength(1);
    expect(sl[0].changeSetId).toBe(psId);
    expect(sl[0].reversedByChangeSetId).toBe(res.reversedBy);

    // Recall no longer lists the shipment; the shipments panel shows it reversed.
    const recall = await svc.genealogy.recall({ lot: 'FGR1' });
    expect(recall.shipments).toHaveLength(0);
    expect(recall.summary.shipments).toBe(0);
    const after = await svc.orders.shipments(ORDER);
    expect(after.shipments[0].reversedByChangeSetId).toBe(res.reversedBy);

    // The packing slip renders marked REVERSED (legacy REJ'd waybill pattern).
    const slip = await new PackingSlipService(prisma as unknown as PrismaService, svc.settings, svc.party).get(psId);
    expect(slip.header.reversed).toBe(true);

    // Audited under the reversal program.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'order.reverse-shipment' } });
    expect(audit).not.toBeNull();
    expect(audit!.summary).toContain(`Shipment ${psId}`);

    // The corrected re-ship works — reverse → fix → re-ship, the plant's flow.
    const again = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    expect(again.packingSlipId).toBeGreaterThan(res.reversedBy);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(20);
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE } }))!.qtyUsed).toBe(80);
  });

  it('refuses a double reversal, a foreign/imported packing slip, and a missing reason', async () => {
    const { actor } = await base();
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);

    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId }, actor))
      .rejects.toThrow(/reason is required/i);

    await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/already been reversed/);

    // An imported (legacy-range) change set is not ERP1-shaped.
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: 4242, reason: 'x' }, actor))
      .rejects.toThrow(/imported from the legacy system/);

    // A change set that is not this order's shipment.
    const other = (await prisma.changeSet.create({
      data: { id: NATIVE_ID_BASE + 900_000, context: 'SH', ordrId: ORDER + 1 },
      select: { id: true },
    })).id;
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: other, reason: 'x' }, actor))
      .rejects.toThrow(/not a shipment of order/);
  });

  it('is blocked without the perform grant (elevation pointer), like the batch reversal', async () => {
    const { actor } = await base();
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    const outsider = await prisma.user.create({
      data: { email: 'nogrant@test.local', displayName: 'No Grant' },
      select: { id: true, displayName: true },
    });
    await expect(
      svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, { id: outsider.id, label: outsider.displayName }),
    ).rejects.toThrow(/not permitted to reverse shipments/);
  });
});

describe('L60 — invoice guard (reversal-pair math)', () => {
  beforeEach(async () => resetDb(prisma));

  it('refuses while an active invoice bills the shipped qty; invoice-reverse → ship-reverse → re-ship → re-bill nets exactly', async () => {
    const { actor } = await base();
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    const inv = await svc.invoices.generate({ orderId: ORDER }, actor);
    expect(inv.subtotal).toBe(200); // 80 × 2.5

    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/reverse the invoice first/);

    // The legacy sequence: credit the invoice, reverse the shipment, re-ship, re-bill.
    await svc.invoices.reverse(inv.id, actor);
    await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(100);

    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 60, ordDetailId: LINE }] }, actor);
    const rebill = await svc.invoices.generate({ orderId: ORDER }, actor);
    expect(rebill.subtotal).toBe(150); // 60 × 2.5 — pairs net, nothing double-billed
  });

  it('a partially-invoiced multi-shipment order can reverse the uninvoiced remainder only', async () => {
    const { actor } = await base();
    const svc = services(prisma);
    const first = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 30, ordDetailId: LINE }] }, actor);
    const inv = await svc.invoices.generate({ orderId: ORDER }, actor); // bills 30
    const second = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 50, ordDetailId: LINE }] }, actor);

    // Reversing the FIRST shipment would leave QtyUsed 50 < billed 30 + reversed 30? No:
    // newUsed = 80 − 30 = 50 ≥ billed 30 → allowed. Reversing the SECOND leaves 30 ≥ 30 too.
    // But reversing BOTH would leave 0 < 30 — the second attempt must refuse.
    await svc.orders.reverseShipment(ORDER, { packingSlipId: second.packingSlipId, reason: 'x' }, actor);
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: first.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/reverse the invoice first/);
    expect(inv.subtotal).toBe(75);
  });
});

describe('L60 — staged (ASM) shipment reversal', () => {
  beforeEach(async () => resetDb(prisma));

  it('restores INTO the assembly: re-opens the DEL’d ASM, re-reserves to the line, re-ship draws it first', async () => {
    const { actor, parcel } = await base();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel, ordDetailId: LINE, qty: 80 }] }, actor);

    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    // The emptied assembly closed at ship (single-use lifecycle).
    expect((await prisma.location.findUnique({ where: { id: asm.locationId } }))!.status).toBe('DEL');
    expect(await onHandForLot(prisma, 'FGR1')).toBe(20);

    const res = await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    expect(res.reopenedAssemblies).toEqual([asm.locationCode]);

    // The assembly is live again and holds the restored stock, RESERVED to its
    // line — the staged state, exactly what the follow-up re-ship draws first.
    expect((await prisma.location.findUnique({ where: { id: asm.locationId } }))!.status).toBeNull();
    const restored = await prisma.inventory.findMany({ where: { locationId: asm.locationId, qty: { gt: 0 } } });
    expect(restored).toHaveLength(1);
    expect(restored[0].qty).toBe(80);
    expect(restored[0].ordDetailId).toBe(LINE);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(100);

    // Re-ship draws the restored reservation and closes the assembly again.
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    expect((await prisma.location.findUnique({ where: { id: asm.locationId } }))!.status).toBe('DEL');
    expect((await prisma.inventory.findUnique({ where: { id: parcel } }))!.qty).toBe(20); // free stock untouched
  });
});

describe('L60 — free-entry-drawn-from-ASM restore (review round)', () => {
  beforeEach(async () => resetDb(prisma));

  it('never leaves an unreserved parcel at an ASM location: the restore re-reserves to the item’s line', async () => {
    const { actor, parcel } = await base();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel, ordDetailId: LINE, qty: 80 }] }, actor);

    // FREE entry (no ordDetailId): reserved-first draw still takes the staged
    // parcel, so the stored leg sits at the ASM with a NULL line.
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80 }] }, actor);
    const legs = await prisma.$queryRaw<{ loc: number | null; od: number | null }[]>`
      SELECT d."Location" AS loc, d."OrdDetail" AS od FROM "InvMovementDtl" d
      JOIN "InvMovement" im ON im."InvMovement" = d."InvMovement" WHERE im."ChangeSet" = ${ship.packingSlipId}`;
    expect(legs).toEqual([{ loc: asm.locationId, od: null }]);

    await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);

    // The restored assembly parcel is RESERVED to the order's line for the
    // item — an unreserved ASM parcel would be invisible to every depleter
    // and refused by unstage (orphaned stock).
    const atAsm = await prisma.inventory.findMany({ where: { locationId: asm.locationId, qty: { gt: 0 } } });
    expect(atAsm).toHaveLength(1);
    expect(atAsm[0].qty).toBe(80);
    expect(atAsm[0].ordDetailId).toBe(LINE);
    // And the re-ship can draw it (visible via the owning order's carve-out).
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(20);
  });
});

describe('L60 — pair-less warehouse shipment vs sibling reversal (review round)', () => {
  beforeEach(async () => resetDb(prisma));

  it('a TRNSFR negation cs landing at fwdCsId+1 does not false-block the pair-less shipment’s reversal', async () => {
    const { actor } = await base({ warehouse: true });
    const svc = services(prisma);
    // Shipment A: normal warehouse relocation (gets its TRNSFR pair at A+1).
    const shipA = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 60, ordDetailId: LINE }] }, actor);
    // Shipment B: ALL-SHORTFALL (a lot with zero on-hand) — no takes, no
    // TRNSFR pair; its SH cs is the max native ChangeSet id.
    await addLot(prisma, { lot: 'FGR2', itemId: ITEM, unitCost: 3 });
    await addSublot(prisma, { id: SUBLOT + 1, lot: 'FGR2' });
    const shipB = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR2', qty: 5, ordDetailId: LINE }] }, actor);
    expect(shipB.shortfalls).toEqual([{ lot: 'FGR2', shortfall: 5 }]);
    expect(shipB.warehouseTransfer).toBeNull();

    // Reversing A mints its TRNSFR negation cs at max+1 — which is B+1.
    const revA = await svc.orders.reverseShipment(ORDER, { packingSlipId: shipA.packingSlipId, reason: 'x' }, actor);
    expect(revA.transferReversedBy).toBe(shipB.packingSlipId + 1);

    // Reversing B must NOT read that sibling negation cs as "B already
    // reversed" (its back-pointer points BACKWARD) — the fix discriminates
    // by pointer direction.
    const revB = await svc.orders.reverseShipment(ORDER, { packingSlipId: shipB.packingSlipId, reason: 'x' }, actor);
    expect(revB.transferReversedBy).toBeNull();
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE } }))!.qtyUsed).toBe(0);
  });
});

describe('L60 — return-entry reversal', () => {
  beforeEach(async () => resetDb(prisma));

  it('un-returns the restocked quantity (negation of the positive US leg) and unwinds the negative QtyUsed', async () => {
    const { actor, parcel } = await base({ retLine: true });
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: -40, ordDetailId: LINE_RET }] }, actor);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(140);
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE_RET } }))!.qtyUsed).toBe(-40);

    await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(100);
    expect((await prisma.ordDetail.findUnique({ where: { id: LINE_RET } }))!.qtyUsed).toBe(0);

    // The reversing leg is the stored return leg negated: US −40 at the restock location.
    const rvs = await prisma.changeSet.findFirst({ where: { context: 'RVSSH', ordrId: ORDER } });
    const movs = await prisma.invMovement.findMany({ where: { changeSetId: rvs!.id } });
    const legs = await prisma.invMovementDtl.findMany({ where: { invMovementId: { in: movs.map((m) => m.id) } } });
    expect(legs).toHaveLength(1);
    expect(legs[0].qty).toBe(-40);
    expect(Number(legs[0].value)).toBe(-120);
    void parcel;
  });

  it('refuses when the returned stock has since been drawn down', async () => {
    const { actor } = await base({ retLine: true });
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: -40, ordDetailId: LINE_RET }] }, actor);
    // Simulate the restocked quantity being consumed: drop the lot's on-hand
    // below the 40 the un-return must remove.
    await prisma.$executeRaw`UPDATE "Inventory" SET "Qty" = 10 WHERE "Sublot" = ${SUBLOT}`;
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/no longer at its restock location/);
  });

  it('a credited (invoiced) return refuses reversal until the credit is reversed', async () => {
    const { actor } = await base({ retLine: true });
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: -40, ordDetailId: LINE_RET }] }, actor);
    const credit = await svc.invoices.generate({ orderId: ORDER }, actor); // bills the −40 credit
    expect(credit.subtotal).toBe(-100);
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/reverse the invoice first/);
    await svc.invoices.reverse(credit.id, actor);
    await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(100);
  });
});

describe('L60 — warehouse (consigned) shipment reversal', () => {
  beforeEach(async () => resetDb(prisma));

  it('unwinds the consigned relocation: TRNSFR negation pair (bidirectional links), source restored, owner-change legs net out', async () => {
    const { actor, parcel } = await base({ warehouse: true });
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    expect(ship.warehouseTransfer).not.toBeNull();
    const fwdTrnsfrId = ship.warehouseTransfer!.changeSetId;
    const consigned = await prisma.location.findFirst({ where: { ownerId: WAREHOUSE, context: 'WHS' } });
    expect((await prisma.inventory.findFirst({ where: { locationId: consigned!.id } }))!.qty).toBe(80);

    const res = await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    expect(res.transferReversedBy).not.toBeNull();

    // Consigned stock gone, source parcel whole again.
    const atConsigned = await prisma.inventory.findMany({ where: { locationId: consigned!.id, qty: { gt: 0 } } });
    expect(atConsigned).toHaveLength(0);
    expect((await prisma.inventory.findUnique({ where: { id: parcel } }))!.qty).toBe(100);

    // The TRNSFR negation pair is BIDIRECTIONALLY linked (legacy 54931↔54933);
    // the RVSSH points at the SH change set only.
    const fwdT = (await prisma.changeSet.findUnique({ where: { id: fwdTrnsfrId } }))!;
    const revT = (await prisma.changeSet.findUnique({ where: { id: res.transferReversedBy! } }))!;
    expect(fwdT.reverseChangeSetId).toBe(revT.id);
    expect(revT.reverseChangeSetId).toBe(fwdT.id);
    expect(revT.context).toBe('TRNSFR');
    expect(revT.changeDate!.getTime()).toBe(fwdT.changeDate!.getTime());

    // The negated TRNSFR MK leg keeps the WAREHOUSE owner (per-owner ledger
    // algebra — the owner-change nets out).
    const revTMovs = await prisma.invMovement.findMany({ where: { changeSetId: revT.id } });
    expect(revTMovs).toHaveLength(1);
    expect(revTMovs[0].context).toBe('TRNSFR');
    const revTLegs = await prisma.invMovementDtl.findMany({ where: { invMovementId: revTMovs[0].id } });
    expect(revTLegs[0].context).toBe('MK');
    expect(revTLegs[0].qty).toBe(-80);
    expect(revTLegs[0].ownerId).toBe(WAREHOUSE);
    expect(Number(revTLegs[0].value)).toBe(-240);
  });

  it('refuses when the consigned stock has been drawn down since', async () => {
    const { actor } = await base({ warehouse: true });
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    const consigned = await prisma.location.findFirst({ where: { ownerId: WAREHOUSE, context: 'WHS' } });
    await prisma.$executeRaw`UPDATE "Inventory" SET "Qty" = 30 WHERE "Location" = ${consigned!.id}`;
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/no longer at the warehouse location/);
  });

  it('an active TI (transfer) invoice blocks the reversal like a CI does', async () => {
    const { actor } = await base({ warehouse: true });
    const svc = services(prisma);
    const ship = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGR1', qty: 80, ordDetailId: LINE }] }, actor);
    const ti = await svc.invoices.generate({ orderId: ORDER }, actor);
    await expect(svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor))
      .rejects.toThrow(/reverse the invoice first/);
    await svc.invoices.reverse(ti.id, actor);
    await svc.orders.reverseShipment(ORDER, { packingSlipId: ship.packingSlipId, reason: 'x' }, actor);
    expect(await onHandForLot(prisma, 'FGR1')).toBe(100);
  });
});
