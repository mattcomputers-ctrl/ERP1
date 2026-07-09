import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../../src/common/locks';
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

// SH staging (the legacy "Shipping Assembly" program, L113): native ASM
// assemblies, PICK-movement staging with Inventory.OrdDetail reservations,
// depletion-scan exclusion for everyone but the owning order's shipment, and
// reserved-first ship-lot capture.

const prisma = makePrisma();
afterAll(async () => prisma.$disconnect());

const WHS = 501;
const RACK = 502; // BRECEIVE LCN parent
const SMP = 503;
const ITEM = 71001;
const ITEM_UNTRACKED = 71002;
const CUSTOMER = 72001;
const ORDER = 73001;
const LINE = 74001;
const LINE2 = 74002;
const ORDER_B = 73002;
const LINE_B = 74101;

async function fixture(opts?: { orderStatus?: string }) {
  const actor = await seedActor(prisma, true);
  await addLocation(prisma, { id: WHS, code: 'WHS1', context: 'WHS' });
  await addLocation(prisma, { id: RACK, code: 'BRECEIVE', context: 'LCN' });
  await addItem(prisma, { id: ITEM, code: 'FG-1', lotTracked: true, unit: 'lb' });
  await addItem(prisma, { id: ITEM_UNTRACKED, code: 'RAW-1', lotTracked: false, unit: 'lb' });
  await addEntity(prisma, { id: CUSTOMER, code: 'CUST', isBillTo: true, isShipTo: true });
  await addOrder(prisma, { id: ORDER, context: 'SH', status: opts?.orderStatus ?? 'NST', billToId: CUSTOMER, shipToId: CUSTOMER });
  await addOrdDetail(prisma, { id: LINE, ordrId: ORDER, context: 'SH', itemId: ITEM, qtyReqd: 100 });
  await addOrdDetail(prisma, { id: LINE2, ordrId: ORDER, context: 'SH', itemId: ITEM_UNTRACKED, qtyReqd: 10 });
  await addLot(prisma, { lot: 'FGL1', itemId: ITEM, unitCost: 2.5 });
  await addSublot(prisma, { id: 81001, lot: 'FGL1' });
  const parcel1 = await addInventory(prisma, { itemId: ITEM, sublotId: 81001, locationId: WHS, qty: 60 });
  await addLot(prisma, { lot: 'FGL2', itemId: ITEM, unitCost: 3 });
  await addSublot(prisma, { id: 81002, lot: 'FGL2' });
  const parcel2 = await addInventory(prisma, { itemId: ITEM, sublotId: 81002, locationId: WHS, qty: 80 });
  return { actor, parcel1, parcel2 };
}

describe('SH staging — assemblies, reservations, PICK movements', () => {
  beforeEach(async () => resetDb(prisma));

  it('creates a native EA-coded ASM assembly parented at BRECEIVE, stamped with the order', async () => {
    const { actor } = await fixture();
    const svc = services(prisma);

    const a1 = await svc.staging.createAssembly(ORDER, actor);
    expect(a1.locationCode).toBe('EA00001');
    expect(a1.locationId).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    const loc = await prisma.location.findUnique({ where: { id: a1.locationId } });
    expect(loc?.context).toBe('ASM');
    expect(loc?.inLocationId).toBe(RACK);
    expect(loc?.reference).toBe(String(ORDER));
    expect(loc?.status).toBeNull();

    const a2 = await svc.staging.createAssembly(ORDER, actor);
    expect(a2.locationCode).toBe('EA00002');
  });

  it('refuses assemblies on completed / closed / EDT / non-SH orders', async () => {
    const { actor } = await fixture({ orderStatus: 'CMP' });
    const svc = services(prisma);
    await expect(svc.staging.createAssembly(ORDER, actor)).rejects.toThrow(/staging applies to open shipping orders/);

    await addOrder(prisma, { id: 73009, context: 'MFBA', status: 'RLS' });
    await expect(svc.staging.createAssembly(73009, actor)).rejects.toThrow(/Only shipping/);
  });

  it('stages a parcel split into the assembly: reservation stamped, source decremented, valueless PICK legs emitted', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);

    const res = await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 25 }] }, actor);
    expect(res.staged).toBe(1);

    const src = await prisma.inventory.findUnique({ where: { id: parcel1 } });
    expect(src?.qty).toBe(35);
    expect(src?.ordDetailId).toBeNull();

    const staged = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });
    expect(staged).toBeTruthy();
    expect(staged!.id).toBeGreaterThanOrEqual(NATIVE_ID_BASE);
    expect(staged!.qty).toBe(25);
    expect(staged!.ordDetailId).toBe(LINE);
    expect(staged!.sublotId).toBe(81001);

    // On-hand is conserved — staging moves, never consumes.
    expect(await onHandForLot(prisma, 'FGL1')).toBe(60);

    // The PICK change set + movement: valueless US at source, MK at assembly
    // carrying the line (the verified legacy shape).
    const cs = await prisma.changeSet.findFirst({ where: { context: 'PICK', ordrId: ORDER } });
    expect(cs).toBeTruthy();
    const mv = await prisma.invMovement.findFirst({ where: { changeSetId: cs!.id } });
    expect(mv?.context).toBe('PICK');
    expect(mv?.sublotId).toBe(81001);
    const legs = await prisma.invMovementDtl.findMany({ where: { invMovementId: mv!.id }, orderBy: { id: 'asc' } });
    expect(legs).toHaveLength(2);
    expect(legs[0].context).toBe('US');
    expect(legs[0].locationId).toBe(WHS);
    expect(legs[0].qty).toBe(-25);
    expect(legs[0].value).toBeNull();
    expect(legs[0].ordDetailId).toBeNull();
    expect(legs[1].context).toBe('MK');
    expect(legs[1].locationId).toBe(asm.locationId);
    expect(legs[1].qty).toBe(25);
    expect(legs[1].value).toBeNull();
    expect(legs[1].ordDetailId).toBe(LINE);
  });

  it('merges same-lot re-stages into the existing reserved parcel', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 10 }] }, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 15 }] }, actor);
    const staged = await prisma.inventory.findMany({ where: { locationId: asm.locationId } });
    expect(staged).toHaveLength(1);
    expect(staged[0].qty).toBe(25);
  });

  it('stage validation: wrong line item, reserved source, over-stage, foreign assembly, untracked item', async () => {
    const { actor, parcel1, parcel2 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);

    // Parcel of FG staged to the untracked RAW line → item mismatch (the
    // untracked-line refusal fires first).
    await expect(
      svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE2, qty: 5 }] }, actor),
    ).rejects.toThrow(/not lot-traced/);

    // Over-stage.
    await expect(
      svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 61 }] }, actor),
    ).rejects.toThrow(/only 60 on hand/);

    // Already-reserved source: stage 20, then try to stage the ASM parcel again.
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 20 }] }, actor);
    const stagedParcel = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });
    await expect(
      svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: stagedParcel!.id, ordDetailId: LINE, qty: 5 }] }, actor),
    ).rejects.toThrow(/already reserved/);

    // A different order cannot stage into this order's assembly.
    await addOrder(prisma, { id: ORDER_B, context: 'SH', status: 'NST', billToId: CUSTOMER });
    await addOrdDetail(prisma, { id: LINE_B, ordrId: ORDER_B, context: 'SH', itemId: ITEM, qtyReqd: 10 });
    await expect(
      svc.staging.stage(ORDER_B, asm.locationId, { parcels: [{ inventoryId: parcel2, ordDetailId: LINE_B, qty: 5 }] }, actor),
    ).rejects.toThrow(/does not belong to shipping order/);

    // A line of another order can't be smuggled into this order's stage call.
    await expect(
      svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel2, ordDetailId: LINE_B, qty: 5 }] }, actor),
    ).rejects.toThrow(/not a line on shipping order/);
  });

  it('unstages back to a stock location: reservation cleared, mirrored PICK legs', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 30 }] }, actor);
    const staged = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });

    const res = await svc.staging.unstage(ORDER, { parcels: [{ inventoryId: staged!.id, qty: 12 }], toLocationId: WHS }, actor);
    expect(res.toLocationId).toBe(WHS);

    // 18 stays reserved at the assembly; 12 rejoined the free WHS parcel.
    const after = await prisma.inventory.findUnique({ where: { id: staged!.id } });
    expect(after?.qty).toBe(18);
    expect(after?.ordDetailId).toBe(LINE);
    const src = await prisma.inventory.findUnique({ where: { id: parcel1 } });
    expect(src?.qty).toBe(42); // 60 - 30 + 12 merged back
    expect(await onHandForLot(prisma, 'FGL1')).toBe(60);

    // Unpick legs: US +12 at destination, MK −12 at the assembly, line-stamped.
    const csList = await prisma.changeSet.findMany({ where: { context: 'PICK', ordrId: ORDER }, orderBy: { id: 'asc' } });
    expect(csList).toHaveLength(2);
    const mv = await prisma.invMovement.findFirst({ where: { changeSetId: csList[1].id } });
    const legs = await prisma.invMovementDtl.findMany({ where: { invMovementId: mv!.id }, orderBy: { id: 'asc' } });
    expect(legs[0].context).toBe('US');
    expect(legs[0].locationId).toBe(WHS);
    expect(legs[0].qty).toBe(12);
    expect(legs[0].value).toBeNull();
    expect(legs[1].context).toBe('MK');
    expect(legs[1].locationId).toBe(asm.locationId);
    expect(legs[1].qty).toBe(-12);
    expect(legs[1].ordDetailId).toBe(LINE);

    // Unstaging someone else's order's parcel is refused.
    await addOrder(prisma, { id: ORDER_B, context: 'SH', status: 'NST' });
    await expect(
      svc.staging.unstage(ORDER_B, { parcels: [{ inventoryId: staged!.id, qty: 1 }] }, actor),
    ).rejects.toThrow(/not reserved to shipping order/);
  });

  it('staging panel data: assemblies, contents, per-line reserved totals', async () => {
    const { actor, parcel1, parcel2 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 40 }] }, actor);

    const panel = await svc.staging.staging(ORDER);
    expect(panel.stageable).toBe(true);
    const line = panel.lines.find((l) => l.ordDetailId === LINE);
    expect(line?.reserved).toBe(40);
    expect(line?.lotTracked).toBe(true);
    expect(panel.assemblies).toHaveLength(1);
    expect(panel.assemblies[0].locationCode).toBe('EA00001');
    expect(panel.assemblies[0].native).toBe(true);
    expect(panel.assemblies[0].parcels).toHaveLength(1);
    expect(panel.assemblies[0].parcels[0].lot).toBe('FGL1');
    expect(panel.looseReservations).toHaveLength(0);

    const candidates = await svc.staging.stageCandidates(ORDER, LINE);
    // parcel1 (20 left) and parcel2 (80) are free; the staged ASM parcel is not offered.
    expect(candidates.parcels.map((p) => p.inventoryId).sort((a, b) => a - b)).toEqual([parcel1, parcel2].sort((a, b) => a - b));
    await expect(svc.staging.stageCandidates(ORDER, LINE2)).rejects.toThrow(/lot-traced/);
  });
});

describe('SH staging — depletion exclusion and reserved-first shipping', () => {
  beforeEach(async () => resetDb(prisma));

  it('reserved and ASM-staged stock is invisible to specific and FIFO depletion', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 45 }] }, actor);
    // FGL1: 15 free at WHS, 45 reserved at the assembly.

    const specific = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      return svc.valuation.depleteSpecificMany(tx, [{ lot: 'FGL1', qty: 60 }]);
    });
    const d = specific.get('FGL1')!;
    expect(d.depleted).toBe(15); // only the free parcel
    expect(d.shortfall).toBe(45);
    const reservedAfter = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });
    expect(reservedAfter?.qty).toBe(45); // untouched

    // FIFO (by item) also skips the reserved parcel — only FGL2's 80 remain free.
    const fifo = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      return svc.valuation.depleteFifoMany(tx, [{ itemId: ITEM, qty: 200 }]);
    });
    const f = fifo.get(ITEM)!;
    expect(f.depleted).toBe(80);
    expect(f.shortfall).toBe(120);
    expect((await prisma.inventory.findFirst({ where: { locationId: asm.locationId } }))?.qty).toBe(45);
  });

  it('ship-lot options: reserved pre-fill per line; free list excludes reserved/ASM/SMP stock', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 45 }] }, actor);
    // A retained sample of FGL2 at an SMP location must not be offered either.
    await addLocation(prisma, { id: SMP, code: 'E00001', context: 'SMP' });
    await addInventory(prisma, { itemId: ITEM, sublotId: 81002, locationId: SMP, qty: 0.011 });

    const opts = await svc.orders.shipLotOptions(ORDER);
    const line = opts.lines.find((l) => l.ordDetailId === LINE)!;
    expect(line.reserved).toHaveLength(1);
    expect(line.reserved[0]).toMatchObject({ lot: 'FGL1', qty: 45, locationCode: 'EA00001' });
    // Free lots: FGL1's remaining 15 at WHS + FGL2's 80 at WHS — never the
    // assembly parcel or the SMP sample.
    const fgl1 = line.lots.filter((l) => l.lot === 'FGL1');
    expect(fgl1).toHaveLength(1);
    expect(fgl1[0].onHand).toBe(15);
    const fgl2 = line.lots.filter((l) => l.lot === 'FGL2');
    expect(fgl2).toHaveLength(1);
    expect(fgl2[0].onHand).toBe(80);
  });

  it('shipLots draws reserved stock FIRST, clears it, and closes the emptied assembly', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 30 }] }, actor);
    // FGL1: 30 free at WHS (id parcel1), 30 reserved at the assembly (higher native id).

    const res = await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGL1', qty: 40, ordDetailId: LINE }] }, actor);
    expect(res.shortfalls).toHaveLength(0);

    // Reserved-first: the assembly parcel (higher id!) went to zero before the
    // free WHS parcel was touched for the remaining 10.
    const stagedAfter = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });
    expect(stagedAfter?.qty).toBe(0);
    const freeAfter = await prisma.inventory.findUnique({ where: { id: parcel1 } });
    expect(freeAfter?.qty).toBe(20); // 30 free − 10

    // The emptied assembly is single-use → closed (legacy Status='DEL').
    const asmLoc = await prisma.location.findUnique({ where: { id: asm.locationId } });
    expect(asmLoc?.status).toBe('DEL');

    // US legs land at the true source locations: −30 at the assembly, −10 at WHS.
    const shipCs = await prisma.changeSet.findFirst({ where: { context: 'SH', ordrId: ORDER } });
    const mvs = await prisma.invMovement.findMany({ where: { changeSetId: shipCs!.id }, select: { id: true } });
    const legs = await prisma.invMovementDtl.findMany({
      where: { invMovementId: { in: mvs.map((m) => m.id) } },
      orderBy: { id: 'asc' },
    });
    const byLoc = new Map(legs.map((l) => [l.locationId, l.qty]));
    expect(byLoc.get(asm.locationId)).toBe(-30);
    expect(byLoc.get(WHS)).toBe(-10);
  });

  it('another order cannot ship stock reserved to this order', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 45 }] }, actor);

    await addOrder(prisma, { id: ORDER_B, context: 'SH', status: 'NST', billToId: CUSTOMER });
    await addOrdDetail(prisma, { id: LINE_B, ordrId: ORDER_B, context: 'SH', itemId: ITEM, qtyReqd: 50 });

    const res = await svc.orders.shipLots(ORDER_B, { lots: [{ lot: 'FGL1', qty: 50, ordDetailId: LINE_B }] }, actor);
    // Only the free 15 ship; the 45 reserved to ORDER stay put.
    expect(res.shortfalls).toEqual([{ lot: 'FGL1', shortfall: 35 }]);
    expect((await prisma.inventory.findFirst({ where: { locationId: asm.locationId } }))?.qty).toBe(45);
  });

  it('partial shipment leaves the remainder staged and the assembly open', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 30 }] }, actor);

    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGL1', qty: 12, ordDetailId: LINE }] }, actor);
    const staged = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });
    expect(staged?.qty).toBe(18);
    expect(staged?.ordDetailId).toBe(LINE);
    expect((await prisma.location.findUnique({ where: { id: asm.locationId } }))?.status).toBeNull();
  });
});

describe('SH staging — guards on neighboring flows', () => {
  beforeEach(async () => resetDb(prisma));

  it('plain transfer refuses reserved sources and ASM/SMP destinations, and never merges into a reserved parcel', async () => {
    const { actor, parcel1, parcel2 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 30 }] }, actor);
    const staged = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });

    await expect(
      svc.inventory.transfer({ inventoryId: staged!.id, toLocationId: WHS, qty: 5 }, actor),
    ).rejects.toThrow(/reserved to a shipping order/);
    await expect(
      svc.inventory.transfer({ inventoryId: parcel2, toLocationId: asm.locationId, qty: 5 }, actor),
    ).rejects.toThrow(/staging panel/);

    // Merge-guard: transferring free FGL1 stock to a location holding a
    // reserved FGL1 parcel must NOT coalesce into it. (ASM destinations are
    // refused above, so simulate an imported reserved parcel at a plain WHS
    // location.)
    const WHS2 = 599;
    await addLocation(prisma, { id: WHS2, code: 'WHS2', context: 'WHS' });
    await addInventory(prisma, { itemId: ITEM, sublotId: 81001, locationId: WHS2, qty: 7, ordDetailId: LINE });
    await svc.inventory.transfer({ inventoryId: parcel1, toLocationId: WHS2, qty: 5 }, actor);
    const atDest = await prisma.inventory.findMany({ where: { locationId: WHS2 }, orderBy: { id: 'asc' } });
    expect(atDest).toHaveLength(2); // reserved 7 + new free 5, not merged
    expect(atDest.find((p) => p.ordDetailId === LINE)?.qty).toBe(7);
    expect(atDest.find((p) => p.ordDetailId === null)?.qty).toBe(5);
  });

  it('removing an SH line with staged stock is refused until unstaged', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 10 }] }, actor);

    await expect(svc.shipping.removeLine(ORDER, LINE, actor)).rejects.toThrow(/staged stock reserved/);

    // After unstaging it works.
    const staged = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });
    await svc.staging.unstage(ORDER, { parcels: [{ inventoryId: staged!.id, qty: 10 }], toLocationId: WHS }, actor);
    await expect(svc.shipping.removeLine(ORDER, LINE, actor)).resolves.toBeTruthy();
  });

  it('unstage refuses imported (sync-owned) reservations — the legacy program releases those', async () => {
    const actor = await seedActor(prisma);
    await addLocation(prisma, { id: WHS, code: 'WHS1', context: 'WHS' });
    const legacyAsm = await addLocation(prisma, { id: 601, code: 'A017000', context: 'ASM' });
    await addItem(prisma, { id: ITEM_UNTRACKED, code: 'RAW-1', lotTracked: false, unit: 'lb' });
    await addOrder(prisma, { id: ORDER, context: 'SH', status: 'RTS' });
    await addOrdDetail(prisma, { id: LINE, ordrId: ORDER, context: 'SH', itemId: ITEM_UNTRACKED, qtyReqd: 12 });
    // The imported shape: legacy-range parcel id, untracked item, reserved at
    // an imported ASM location — exactly what the sync re-copy owns.
    await addLot(prisma, { lot: 'RAWL', itemId: ITEM_UNTRACKED });
    await addSublot(prisma, { id: 81005, lot: 'RAWL' });
    const parcel = await addInventory(prisma, { id: 4200, itemId: ITEM_UNTRACKED, sublotId: 81005, locationId: legacyAsm, qty: 12, ordDetailId: LINE });

    const svc = services(prisma);
    await expect(
      svc.staging.unstage(ORDER, { parcels: [{ inventoryId: parcel, qty: 12 }], toLocationId: WHS }, actor),
    ).rejects.toThrow(/legacy-staged reservation/);
    // Untouched — the sync stays the owner.
    expect((await prisma.inventory.findUnique({ where: { id: parcel } }))?.qty).toBe(12);
    // And the panel marks it not-native so the UI offers no unstage button.
    const panel = await svc.staging.staging(ORDER);
    const shown = [...panel.assemblies.flatMap((a) => a.parcels), ...panel.looseReservations];
    expect(shown.find((p) => p.inventoryId === parcel)?.native).toBe(false);
  });

  it('adjust refuses reserved parcels and assembly/sample-located parcels', async () => {
    const { actor, parcel1, parcel2 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 10 }] }, actor);
    const staged = await prisma.inventory.findFirst({ where: { locationId: asm.locationId } });

    await expect(
      svc.inventory.adjust({ inventoryId: staged!.id, newQty: 99, reason: 'count' }, actor),
    ).rejects.toThrow(/reserved to a shipping order/);

    await addLocation(prisma, { id: SMP, code: 'E00001', context: 'SMP' });
    const smpParcel = await addInventory(prisma, { itemId: ITEM, sublotId: 81002, locationId: SMP, qty: 0.011 });
    await expect(
      svc.inventory.adjust({ inventoryId: smpParcel, newQty: 1, reason: 'count' }, actor),
    ).rejects.toThrow(/QA sampling flow/);

    // Free stock still adjusts.
    await expect(svc.inventory.adjust({ inventoryId: parcel2, newQty: 79, reason: 'count' }, actor)).resolves.toMatchObject({ newQty: 79 });
  });

  it('the batch dispense picker offers only free stock (reserved/ASM excluded)', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 45 }] }, actor);

    // A released batch order consuming the same FG item as a material.
    await addOrder(prisma, { id: 73050, context: 'MFBA', status: 'RLS' });
    await addOrdDetail(prisma, { id: 74050, ordrId: 73050, context: 'UI', itemId: ITEM, qtyReqd: 50, execStatus: 'NST' });

    const exec = await svc.orders.execution(73050);
    const line = exec.lines.find((l) => l.itemId === ITEM)!;
    const fgl1 = line.lotOptions.find((o: { lot: string }) => o.lot === 'FGL1');
    expect(fgl1?.onHand).toBe(15); // 60 − 45 staged; the assembly parcel is not offered
  });

  it('the EA code allocator keeps counting past the 5-digit boundary', async () => {
    const { actor } = await fixture();
    await addLocation(prisma, { id: 602, code: 'EA99999', context: 'ASM' });
    const svc = services(prisma);
    const a1 = await svc.staging.createAssembly(ORDER, actor);
    expect(a1.locationCode).toBe('EA100000');
    const a2 = await svc.staging.createAssembly(ORDER, actor);
    expect(a2.locationCode).toBe('EA100001');
  });

  it('shipLots records a structured Location Status audit row when it closes an assembly', async () => {
    const { actor, parcel1 } = await fixture();
    const svc = services(prisma);
    const asm = await svc.staging.createAssembly(ORDER, actor);
    await svc.staging.stage(ORDER, asm.locationId, { parcels: [{ inventoryId: parcel1, ordDetailId: LINE, qty: 30 }] }, actor);
    await svc.orders.shipLots(ORDER, { lots: [{ lot: 'FGL1', qty: 30, ordDetailId: LINE }] }, actor);

    const rows = await prisma.auditFieldChange.findMany({
      where: { tableName: 'Location', recordId: String(asm.locationId), fieldName: 'Status', newValue: 'DEL' },
    });
    expect(rows).toHaveLength(1);
  });

  it('lot-enable refuses while the item has reserved parcels (imported legacy staging included)', async () => {
    const actor = await seedActor(prisma);
    await addLocation(prisma, { id: WHS, code: 'WHS1', context: 'WHS' });
    await addItem(prisma, { id: ITEM_UNTRACKED, code: 'RAW-1', lotTracked: false, unit: 'lb' });
    await addOrder(prisma, { id: ORDER, context: 'SH', status: 'RTS' });
    await addOrdDetail(prisma, { id: LINE, ordrId: ORDER, context: 'SH', itemId: ITEM_UNTRACKED, qtyReqd: 5 });
    // An imported legacy reservation: untracked item, parcel with OrdDetail set.
    await addLot(prisma, { lot: 'RAWL', itemId: ITEM_UNTRACKED });
    await addSublot(prisma, { id: 81003, lot: 'RAWL' });
    await addInventory(prisma, { itemId: ITEM_UNTRACKED, sublotId: 81003, locationId: WHS, qty: 5, ordDetailId: LINE });

    const svc = services(prisma);
    await expect(
      svc.lotTracking.enable(ITEM_UNTRACKED, { groups: [{ locationId: WHS, entries: [{ lotNumber: 'RAWL', qty: 5 }] }] }, actor),
    ).rejects.toThrow(/staged to a shipping order/);
  });
});
