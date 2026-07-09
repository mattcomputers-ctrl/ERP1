import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountingJournalService } from '../../src/accounting/journal.service';
import type { Actor } from '../../src/auth/current-user.decorator';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SettingsService } from '../../src/settings/settings.service';
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
  resetDb,
  seedActor,
  services,
} from './support';

// Native InvMovement/InvMovementDtl emission: every ERP1 inventory writer posts
// legacy-vocabulary movement legs in the same transaction, so the §18 movement /
// at-date / shipment-detail / order-cost viewers keep gaining data after cutover.
// The golden invariant, asserted throughout: Σ Qty of the non-B legs per item
// (the validated GetInventoryAtDate formula) === the Inventory table's on-hand.

const NATIVE = 1_000_000_000;
const D = (iso: string) => new Date(iso);
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

/** Σ Qty over the at-date leg set for one item (the viewer's exact formula). */
async function movementQty(itemId: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ qty: number | null }[]>`
    SELECT SUM(COALESCE(imd."Qty", 0))::float8 AS qty
    FROM "InvMovementDtl" imd
    JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
    WHERE im."Item" = ${itemId}
      AND imd."Context" IN ('MK', 'MKCA', 'US', 'USCA', 'ADJ', 'SCRAP')`;
  return rows[0]?.qty ?? 0;
}

/** On-hand per the Inventory table for one item. */
async function inventoryQty(itemId: number): Promise<number> {
  const agg = await prisma.inventory.aggregate({ _sum: { qty: true }, where: { itemId } });
  return agg._sum.qty ?? 0;
}

async function expectLedgerMatchesOnHand(itemIds: number[]) {
  for (const id of itemIds) {
    expect(await movementQty(id), `item ${id} ledger vs on-hand`).toBeCloseTo(await inventoryQty(id), 6);
  }
}

/** All legs joined to their headers, ascending leg id. */
async function legs(where?: { movementContext?: string }) {
  const rows = await prisma.$queryRaw<
    {
      legId: number; headerId: bigint; movement: string | null; leg: string; owner: number;
      location: number | null; ordDetail: number | null; qty: number | null; value: number | null;
      changeSet: number; item: number | null; sublot: number | null;
    }[]
  >`
    SELECT imd."InvMovementDtl" AS "legId", im."InvMovement" AS "headerId", im."Context" AS movement,
           imd."Context" AS leg, imd."Owner" AS owner, imd."Location" AS location,
           imd."OrdDetail" AS "ordDetail", imd."Qty"::float8 AS qty, imd."Value"::numeric::float8 AS value,
           im."ChangeSet" AS "changeSet", im."Item" AS item, im."Sublot" AS sublot
    FROM "InvMovementDtl" imd
    JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
    ORDER BY imd."InvMovementDtl" ASC`;
  return where?.movementContext ? rows.filter((r) => r.movement === where.movementContext) : rows;
}

describe('purchase + misc receipts emit MK legs', () => {
  it('PO receive: one PO MK leg per lot — qty, 4dp value, PO line, receiving location, receipt change set', async () => {
    const { purchasing } = services(prisma);
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    const sup = await addEntity(prisma, { id: 50, code: 'SUP', isSupplier: true });
    await addItem(prisma, { id: 1, code: 'RAW' });
    await addOrder(prisma, { id: 300, context: 'PO', entityId: sup, ownerId: 4 });
    await addOrdDetail(prisma, { id: 400, ordrId: 300, context: 'PO', itemId: 1, qtyReqd: 100, price: 4.25 });

    await purchasing.receive(300, { lines: [{ ordDetailId: 400, lots: [{ qty: 30, manufacturerLot: 'MFR-1' }] }] }, actor);

    const all = await legs({ movementContext: 'PO' });
    expect(all).toHaveLength(1);
    const mk = all[0];
    expect(mk.leg).toBe('MK');
    expect(mk.qty).toBe(30);
    expect(mk.value).toBeCloseTo(127.5, 4); // 30 × the PO line price
    expect(mk.ordDetail).toBe(400);
    expect(mk.location).toBe(1);
    expect(mk.owner).toBe(4); // the PO owner
    expect(mk.item).toBe(1);
    expect(Number(mk.headerId)).toBeGreaterThanOrEqual(NATIVE);
    expect(mk.legId).toBeGreaterThanOrEqual(NATIVE);
    // The header hangs on the receipt's own PO change set.
    const cs = (await prisma.changeSet.findUnique({ where: { id: mk.changeSet } }))!;
    expect(cs.context).toBe('PO');
    expect(cs.ordrId).toBe(300);
    await expectLedgerMatchesOnHand([1]);
  });

  it('misc receipt: MISC MK leg valued from the entered unit cost; ledger = on-hand', async () => {
    const { miscReceipt } = services(prisma);
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addEntity(prisma, { id: 4, code: 'US' });
    await addItem(prisma, { id: 1, code: 'FOUND' });

    await miscReceipt.receive({ lines: [{ itemId: 1, qty: 10, unitCost: 2.5 }] }, actor);

    const all = await legs({ movementContext: 'MISC' });
    expect(all).toHaveLength(1);
    expect(all[0].leg).toBe('MK');
    expect(all[0].qty).toBe(10);
    expect(all[0].value).toBeCloseTo(25, 4);
    expect(all[0].ordDetail).toBeNull();
    await expectLedgerMatchesOnHand([1]);
  });

  it('receipt reversal: a negative MK leg with the FORWARD context on the reversing change set', async () => {
    const { miscReceipt, inventory } = services(prisma);
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addEntity(prisma, { id: 4, code: 'US' });
    await addItem(prisma, { id: 1, code: 'FOUND' });
    const res = (await miscReceipt.receive({ lines: [{ itemId: 1, qty: 10, unitCost: 2.5 }] }, actor)) as {
      lots: { changeSetId: number }[];
    };

    await inventory.reverseReceipt(res.lots[0].changeSetId, { reason: 'wrong item' }, actor);

    const all = await legs({ movementContext: 'MISC' });
    expect(all).toHaveLength(2); // the receipt MK and its negation
    const rvs = all[1];
    expect(rvs.leg).toBe('MK');
    expect(rvs.qty).toBe(-10);
    expect(rvs.value).toBeCloseTo(-25, 4);
    const cs = (await prisma.changeSet.findUnique({ where: { id: rvs.changeSet } }))!;
    expect(cs.context).toBe('RVSMISC'); // reversing change set, forward movement context
    expect(await movementQty(1)).toBeCloseTo(0, 9);
    await expectLedgerMatchesOnHand([1]);
  });
});

describe('adjust + transfer emit COUNT / TRNSFR legs', () => {
  async function parcel(qty: number, unitCost: number | null = 3) {
    await addEntity(prisma, { id: 4, code: 'US' });
    await addItem(prisma, { id: 1, code: 'WIDGET' });
    await addLot(prisma, { lot: 'L1', itemId: 1, unitCost });
    const subId = await addSublot(prisma, { id: 10, lot: 'L1' });
    const locId = await addLocation(prisma, { id: 1, code: 'WH1', context: 'WHS' });
    return addInventory(prisma, { itemId: 1, sublotId: subId, locationId: locId, qty });
  }

  it('adjust: one COUNT US leg whose qty is the signed DELTA, valued at the lot cost', async () => {
    const { inventory } = services(prisma);
    const invId = await parcel(100);
    // Ledger starts empty for a legacy parcel — the delta legs still track every
    // native change (the at-date parity for pre-existing stock is the legacy
    // ledger's job via the import; here the parcel has no history).
    await inventory.adjust({ inventoryId: invId, newQty: 92, reason: 'cycle count' }, actor);

    const all = await legs({ movementContext: 'COUNT' });
    expect(all).toHaveLength(1);
    expect(all[0].leg).toBe('US');
    expect(all[0].qty).toBe(-8);
    expect(all[0].value).toBeCloseTo(-24, 4); // −8 × 3
    expect(all[0].location).toBe(1);
    expect(all[0].sublot).toBe(10);
    expect(await movementQty(1)).toBe(-8); // the delta — legacy stock itself has no native legs
  });

  it('adjust without a lot cost: value NULL, qty still recorded', async () => {
    const { inventory } = services(prisma);
    const invId = await parcel(10, null);
    await inventory.adjust({ inventoryId: invId, newQty: 15, reason: 'found' }, actor);
    const all = await legs({ movementContext: 'COUNT' });
    expect(all[0].qty).toBe(5);
    expect(all[0].value).toBeNull();
  });

  it('transfer: a value-less US+MK pair, US first with consecutive ids, both locations true', async () => {
    const { inventory } = services(prisma);
    const invId = await parcel(100);
    const locB = await addLocation(prisma, { id: 2, code: 'WH2', context: 'WHS' });

    await inventory.transfer({ inventoryId: invId, toLocationId: locB, qty: 30 }, actor);

    const all = await legs({ movementContext: 'TRNSFR' });
    expect(all).toHaveLength(2);
    const [us, mk] = all;
    expect([us.leg, mk.leg]).toEqual(['US', 'MK']);
    expect(mk.legId).toBe(us.legId + 1); // consecutive, US written first
    expect(Number(mk.headerId)).toBe(Number(us.headerId)); // one event, two legs
    expect(us.qty).toBe(-30);
    expect(mk.qty).toBe(30);
    expect(us.location).toBe(1);
    expect(mk.location).toBe(2);
    expect(us.value).toBeNull(); // pure location move — never valued
    expect(mk.value).toBeNull();
    expect(await movementQty(1)).toBeCloseTo(0, 9); // a move nets to zero
  });
});

describe('batch execution emits CMNGL consumption + PCKAGE production', () => {
  const ORDER = NATIVE + 800; // reversal is native-order-only

  async function releasedBatch() {
    await addEntity(prisma, { id: 4, code: 'US' });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD' });
    await addItem(prisma, { id: 2, code: 'TRACED', lotTracked: true });
    await addItem(prisma, { id: 3, code: 'FIFO', lotTracked: false, purchasePrice: 4 });
    await addOrder(prisma, { id: ORDER, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: 900, ordrId: ORDER, context: 'PK', itemId: 1, qtyReqd: 100 });
    await addOrdDetail(prisma, { id: 901, ordrId: ORDER, context: 'UI', itemId: 2, qtyReqd: 10 });
    await addOrdDetail(prisma, { id: 902, ordrId: ORDER, context: 'UI', itemId: 3, qtyReqd: 8 });
    for (const key of ['order.complete', 'order.reverse']) {
      await prisma.securedItem.create({
        data: { key, description: key, requireReason: true, requireSignature: false, requireWitness: false },
      });
    }
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: 900 });
    await addLot(prisma, { lot: 'RT', itemId: 2, unitCost: 5 });
    await addSublot(prisma, { id: 1, lot: 'RT' });
    await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 100 });
    await addLot(prisma, { lot: 'OLD', itemId: 3, unitCost: 3, receivedDate: D('2020-01-01') });
    await addLot(prisma, { lot: 'NEW', itemId: 3, unitCost: 9, receivedDate: D('2020-06-01') });
    await addSublot(prisma, { id: 3, lot: 'OLD' });
    await addSublot(prisma, { id: 2, lot: 'NEW' });
    await addInventory(prisma, { itemId: 3, sublotId: 3, locationId: 1, qty: 6 });
    await addInventory(prisma, { itemId: 3, sublotId: 2, locationId: 1, qty: 6 });
  }

  it('recordLine (traced): CMNGL US leg on a fresh MF change set, OrdDetail = the material line', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.recordLine(ORDER, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);

    const all = await legs({ movementContext: 'CMNGL' });
    expect(all).toHaveLength(1);
    expect(all[0].leg).toBe('US');
    expect(all[0].qty).toBe(-12);
    expect(all[0].value).toBeCloseTo(-60, 4); // 12 × 5
    expect(all[0].ordDetail).toBe(901);
    expect(all[0].item).toBe(2);
    const cs = (await prisma.changeSet.findUnique({ where: { id: all[0].changeSet } }))!;
    expect(cs.context).toBe('MF');
    expect(cs.ordrId).toBe(ORDER);
    expect(await movementQty(2)).toBeCloseTo(-12, 9); // the native delta (seeded stock has no ledger baseline)
  });

  it('recordLine (FIFO across two parcels): one US leg PER PARCEL DRAW, each at its own cost', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.recordLine(ORDER, 902, { actualQty: 8 }, actor); // 6 from OLD @3, 2 from NEW @9

    const all = await legs({ movementContext: 'CMNGL' });
    expect(all).toHaveLength(2);
    expect(all.map((l) => l.qty)).toEqual([-6, -2]);
    expect(all[0].value).toBeCloseTo(-18, 4); // 6 × 3 (OLD)
    expect(all[1].value).toBeCloseTo(-18, 4); // 2 × 9 (NEW)
    expect(await movementQty(3)).toBeCloseTo(-8, 9);
  });

  it('complete: PCKAGE MK leg with the FINAL rolled-up cost on an order-linked change set; the order-cost lateral reproduces it', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.recordLine(ORDER, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    await orders.recordLine(ORDER, 902, { actualQty: 8 }, actor);
    await orders.complete(ORDER, { reason: 'done', actualBatchSize: 100 }, actor);

    const made = await legs({ movementContext: 'PCKAGE' });
    expect(made).toHaveLength(1);
    expect(made[0].leg).toBe('MK');
    expect(made[0].qty).toBe(100);
    // Rolled cost: (12×5 + 6×3 + 2×9) / 100 = 0.96/unit → value 96.
    expect(made[0].value).toBeCloseTo(96, 4);
    expect(made[0].ordDetail).toBe(900);
    // The complete-mf-orders viewer's cost lateral: Σ MK-family leg values over
    // the order's change sets — must equal the produced value.
    const lateral = await prisma.$queryRaw<{ made_value: number | null }[]>`
      SELECT SUM(d."Value"::numeric)::float8 AS made_value
      FROM "ChangeSet" c
      JOIN "InvMovement" m ON m."ChangeSet" = c."ChangeSet"
      JOIN "InvMovementDtl" d ON d."InvMovement" = m."InvMovement" AND d."Context" IN ('MK', 'MKCA', 'MKB', 'MKBCA')
      WHERE c."Ordr" = ${ORDER}`;
    expect(lateral[0].made_value).toBeCloseTo(96, 4);
    // Native deltas: +100 made, −12 traced, −8 FIFO (seeded stock has no baseline).
    expect(await movementQty(1)).toBeCloseTo(100, 9);
    expect(await movementQty(2)).toBeCloseTo(-12, 9);
    expect(await movementQty(3)).toBeCloseTo(-8, 9);
  });

  it('order reverse: negation legs under the RVSMFP change set return the ledger to pre-completion truth', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.recordLine(ORDER, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    await orders.complete(ORDER, { reason: 'done', actualBatchSize: 100 }, actor);
    await orders.reverse(ORDER, { reason: 'wrong charge' }, actor);

    // Produced negation: PCKAGE MK −100 at the captured rolled cost.
    const made = await legs({ movementContext: 'PCKAGE' });
    expect(made).toHaveLength(2);
    expect(made[1].qty).toBe(-100);
    expect(made[1].value).toBeCloseTo(-(made[0].value ?? 0), 4);
    // Restore: a positive CMNGL US (the RVSSH positive-US idiom).
    const consumption = await legs({ movementContext: 'CMNGL' });
    expect(consumption).toHaveLength(2);
    expect(consumption[1].qty).toBe(12);
    expect(consumption[1].value).toBeCloseTo(60, 4);
    const rvsCs = (await prisma.changeSet.findUnique({ where: { id: consumption[1].changeSet } }))!;
    expect(rvsCs.context).toBe('RVSMFP');
    // The ledger nets to zero — completion and consumption fully negated.
    expect(await movementQty(1)).toBeCloseTo(0, 9);
    expect(await movementQty(2)).toBeCloseTo(0, 9);
    // And the order-cost lateral nets to zero for the reversed order.
    const lateral = await prisma.$queryRaw<{ made_value: number | null }[]>`
      SELECT SUM(d."Value"::numeric)::float8 AS made_value
      FROM "ChangeSet" c
      JOIN "InvMovement" m ON m."ChangeSet" = c."ChangeSet"
      JOIN "InvMovementDtl" d ON d."InvMovement" = m."InvMovement" AND d."Context" IN ('MK', 'MKCA', 'MKB', 'MKBCA')
      WHERE c."Ordr" = ${ORDER}`;
    expect(lateral[0].made_value ?? 0).toBeCloseTo(0, 4);
  });

  it('a shortfall-only consume (nothing on hand) emits NO movement rows', async () => {
    await releasedBatch();
    await prisma.inventory.deleteMany({ where: { itemId: 2 } });
    const { orders } = services(prisma);
    const res = await orders.recordLine(ORDER, 901, { actualQty: 5, lots: [{ lot: 'RT', qty: 5 }] }, actor);
    expect(res.shortfalls.length).toBe(1);
    expect(await prisma.invMovement.count()).toBe(0); // ledger records on-hand truth only
  });
});

describe('shipLots emits SH legs + a native packing slip', () => {
  it('SH US legs per draw on a native SH change set; the packing-slip list shows it', async () => {
    const { orders } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'US' });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'FG', lotTracked: true });
    await addOrder(prisma, { id: 604, context: 'SH', status: 'RLS', poNumber: 'CUST-PO-9' });
    await addOrdDetail(prisma, { id: 704, ordrId: 604, context: 'SH', itemId: 1, qtyReqd: 20 });
    await addLot(prisma, { lot: 'FG1', itemId: 1, unitCost: 7.5 });
    await addSublot(prisma, { id: 11, lot: 'FG1' });
    await addInventory(prisma, { itemId: 1, sublotId: 11, locationId: 1, qty: 25 });

    const res = (await orders.shipLots(604, { lots: [{ lot: 'FG1', qty: 20, ordDetailId: 704 }], shippedAt: '2026-07-01T12:00:00Z' }, actor)) as {
      packingSlipId: number;
    };
    expect(res.packingSlipId).toBeGreaterThanOrEqual(NATIVE);

    const all = await legs({ movementContext: 'SH' });
    expect(all).toHaveLength(1);
    expect(all[0].leg).toBe('US');
    expect(all[0].qty).toBe(-20);
    expect(all[0].value).toBeCloseTo(-150, 4); // 20 × 7.5 out
    expect(all[0].ordDetail).toBe(704); // the shipment-detail viewer's INNER join key
    const cs = (await prisma.changeSet.findUnique({ where: { id: res.packingSlipId } }))!;
    expect(cs.context).toBe('SH');
    expect(cs.ordrId).toBe(604);
    expect(cs.poNumber).toBe('CUST-PO-9');
    expect(cs.changeDate?.toISOString()).toBe('2026-07-01T12:00:00.000Z');
    // The seeded parcel has no ledger history, so the ledger holds only the
    // shipment's own delta (native emission tracks CHANGES; pre-existing
    // legacy stock's baseline comes from the imported legacy ledger).
    expect(await movementQty(1)).toBeCloseTo(-20, 9);
  });
});

describe('lot-tracking enablement rebases the ledger', () => {
  it('negates the movement-implied balance per owner, then posts the opening entries — no double count', async () => {
    const { lotTracking } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'US' });
    const locId = await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'CONV' });
    // Legacy history: a mirror-range movement leaving 40 on hand at $2 (owner 4).
    await prisma.changeSet.create({ data: { id: 500, context: 'PO', changeDate: D('2024-01-01') } });
    await prisma.invMovement.create({ data: { id: 9001, context: 'PO', changeSetId: 500, itemId: 1 } });
    await prisma.invMovementDtl.create({
      data: { id: 9101, invMovementId: 9001, context: 'MK', ownerId: 4, locationId: locId, qty: 40, value: 80 },
    });
    // The legacy parcel disagrees slightly (38 on hand) — the LEDGER is what
    // at-date reads, so the negation targets the ledger sum, not the parcel.
    await addLot(prisma, { lot: 'LEG', itemId: 1 });
    await addSublot(prisma, { id: 20, lot: 'LEG' });
    await addInventory(prisma, { itemId: 1, sublotId: 20, locationId: locId, qty: 38 });

    await lotTracking.enable(
      1,
      { groups: [{ locationId: locId, entries: [{ vendorLot: 'V-77', qty: 35, unitCost: 2.1, supplierId: null }] }] },
      actor,
    );

    // Ledger now: legacy +40, negation −40, opening +35 → exactly the opening stock.
    expect(await movementQty(1)).toBeCloseTo(35, 9);
    await expectLedgerMatchesOnHand([1]);
    const count = await legs({ movementContext: 'COUNT' });
    expect(count).toHaveLength(2); // one negation (owner 4), one opening MK
    expect(count[0].leg).toBe('US');
    expect(count[0].qty).toBe(-40);
    expect(count[0].value).toBeCloseTo(-80, 4);
    expect(count[1].leg).toBe('MK');
    expect(count[1].qty).toBe(35);
    expect(count[1].value).toBeCloseTo(73.5, 4); // 35 × 2.1
  });
});

describe('the golden invariant across a full mixed flow', () => {
  it('receive → consume → complete → adjust → transfer → ship keeps ledger === on-hand for every item', async () => {
    const { purchasing, orders, inventory } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'US' });
    const sup = await addEntity(prisma, { id: 50, code: 'SUP', isSupplier: true });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addLocation(prisma, { id: 2, code: 'WH2', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD', lotTracked: true });
    await addItem(prisma, { id: 2, code: 'RAW', lotTracked: true });
    // Receive raw stock on a PO.
    await addOrder(prisma, { id: 300, context: 'PO', entityId: sup, ownerId: 4 });
    await addOrdDetail(prisma, { id: 400, ordrId: 300, context: 'PO', itemId: 2, qtyReqd: 100, price: 2 });
    const rec = (await purchasing.receive(300, { lines: [{ ordDetailId: 400, lots: [{ qty: 100, manufacturerLot: 'M1' }] }] }, actor)) as {
      lots: { lot: string }[];
    };
    const rawLot = rec.lots[0].lot;
    // Execute a batch consuming it.
    await addOrder(prisma, { id: 800, context: 'MFBA', status: 'RLS', actualBatchSize: 50 });
    await addOrdDetail(prisma, { id: 900, ordrId: 800, context: 'PK', itemId: 1, qtyReqd: 50 });
    await addOrdDetail(prisma, { id: 901, ordrId: 800, context: 'UI', itemId: 2, qtyReqd: 20 });
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: 900 });
    await prisma.securedItem.create({
      data: { key: 'order.complete', description: 'complete', requireReason: true, requireSignature: false, requireWitness: false },
    });
    await orders.recordLine(800, 901, { actualQty: 20, lots: [{ lot: rawLot, qty: 20 }] }, actor);
    await orders.complete(800, { reason: 'done', actualBatchSize: 50 }, actor);
    // Adjust the produced stock, move some of it, ship some of it.
    const prodParcel = (await prisma.inventory.findFirst({ where: { itemId: 1 }, select: { id: true } }))!;
    await inventory.adjust({ inventoryId: prodParcel.id, newQty: 48, reason: 'spillage' }, actor);
    await inventory.transfer({ inventoryId: prodParcel.id, toLocationId: 2, qty: 10 }, actor);
    await addOrder(prisma, { id: 604, context: 'SH', status: 'RLS' });
    await addOrdDetail(prisma, { id: 704, ordrId: 604, context: 'SH', itemId: 1, qtyReqd: 30 });
    await orders.shipLots(604, { lots: [{ lot: 'PROD1', qty: 30, ordDetailId: 704 }] }, actor);

    await expectLedgerMatchesOnHand([1, 2]);
    // Sanity on the physical numbers: raw 100−20=80; product 50→48, −30 shipped = 18.
    expect(await inventoryQty(2)).toBe(80);
    expect(await inventoryQty(1)).toBeCloseTo(18, 9);
  });
});

describe('review-round regressions (2026-07-09)', () => {
  const RORDER = 1_000_000_000 + 810;

  async function releasedBatch2() {
    await addEntity(prisma, { id: 4, code: 'US' });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'PROD' }); // NOT lot-tracked -> FIFO-consumable
    await addItem(prisma, { id: 2, code: 'TRACED', lotTracked: true });
    await addOrder(prisma, { id: RORDER, context: 'MFBA', status: 'RLS', actualBatchSize: 100 });
    await addOrdDetail(prisma, { id: 900, ordrId: RORDER, context: 'PK', itemId: 1, qtyReqd: 100 });
    await addOrdDetail(prisma, { id: 901, ordrId: RORDER, context: 'UI', itemId: 2, qtyReqd: 10 });
    await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: 900 });
    await addLot(prisma, { lot: 'RT', itemId: 2, unitCost: 5 });
    await addSublot(prisma, { id: 1, lot: 'RT' });
    await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 100 });
    for (const key of ['order.complete', 'order.reverse']) {
      await prisma.securedItem.create({
        data: { key, description: key, requireReason: true, requireSignature: false, requireWitness: false },
      });
    }
  }

  it('a post-completion FIFO consume that draws the produced lot still emits its leg (ledger === on-hand)', async () => {
    await releasedBatch2();
    const { orders } = services(prisma);
    await orders.recordLine(RORDER, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    await orders.complete(RORDER, { reason: 'done', actualBatchSize: 100 }, actor);
    expect(await movementQty(1)).toBeCloseTo(100, 9);

    // Rework: consume 30 of the produced (not-lot-tracked) item — FIFO draws
    // the order's own PROD1 parcel. The genealogy self-edge is skipped, but
    // the PHYSICAL draw must still hit the ledger.
    await orders.consumeQuantity(RORDER, { items: [{ itemId: 1, qty: 30 }] }, actor);
    expect(await inventoryQty(1)).toBeCloseTo(70, 9);
    await expectLedgerMatchesOnHand([1]); // all of item 1's stock entered natively
    expect(await movementQty(2)).toBeCloseTo(-12, 9); // seeded stock: delta only
  });

  it('reversal negates the STORED forward leg values even after a late consume re-rolled the cost', async () => {
    await releasedBatch2();
    const { orders } = services(prisma);
    await orders.recordLine(RORDER, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    await orders.complete(RORDER, { reason: 'done', actualBatchSize: 100 }, actor); // rolled 0.6 -> MK +60
    // Late consume doubles the edge set: unitCost re-rolls to 1.2, but the
    // stored completion MK leg keeps its 60.
    await orders.consumeLots(RORDER, { lots: [{ lot: 'RT', qty: 12 }] }, actor);
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PROD1' } }))!.unitCost)).toBeCloseTo(1.2, 9);

    await orders.reverse(RORDER, { reason: 'wrong charge' }, actor);

    // The negation mirrors the STORED legs (-60, not -120): everything nets to zero.
    const lateral = await prisma.$queryRaw<{ v: number | null }[]>`
      SELECT SUM(d."Value"::numeric)::float8 AS v
      FROM "ChangeSet" c
      JOIN "InvMovement" m ON m."ChangeSet" = c."ChangeSet"
      JOIN "InvMovementDtl" d ON d."InvMovement" = m."InvMovement" AND d."Context" IN ('MK', 'MKCA', 'MKB', 'MKBCA')
      WHERE c."Ordr" = ${RORDER}`;
    expect(lateral[0].v ?? 0).toBeCloseTo(0, 4);
    const madeLegs = (await legs({ movementContext: 'PCKAGE' })).map((l) => l.value);
    expect(madeLegs[0]).toBeCloseTo(60, 4);
    expect(madeLegs[1]).toBeCloseTo(-60, 4);
    // Consumption side nets too (qty AND value), and the ledger matches on-hand.
    const consumption = await legs({ movementContext: 'CMNGL' });
    expect(consumption.reduce((s, l) => s + (l.qty ?? 0), 0)).toBeCloseTo(0, 9);
    expect(consumption.reduce((s, l) => s + (l.value ?? 0), 0)).toBeCloseTo(0, 4);
    await expectLedgerMatchesOnHand([1]); // produced stock fully un-minted
    expect(await movementQty(2)).toBeCloseTo(0, 9); // consumed 24, restored 24
  });

  it('one lot shipped against two lines emits one SH leg PER LINE (shipment-detail keeps every unit)', async () => {
    const { orders } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'US' });
    await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'FG', lotTracked: true });
    await addOrder(prisma, { id: 605, context: 'SH', status: 'RLS' });
    await addOrdDetail(prisma, { id: 706, ordrId: 605, context: 'SH', itemId: 1, qtyReqd: 8 });
    await addOrdDetail(prisma, { id: 707, ordrId: 605, context: 'SH', itemId: 1, qtyReqd: 12 });
    await addLot(prisma, { lot: 'FG1', itemId: 1, unitCost: 2 });
    await addSublot(prisma, { id: 11, lot: 'FG1' });
    await addInventory(prisma, { itemId: 1, sublotId: 11, locationId: 1, qty: 25 });

    await orders.shipLots(
      605,
      { lots: [{ lot: 'FG1', qty: 8, ordDetailId: 706 }, { lot: 'FG1', qty: 12, ordDetailId: 707 }] },
      actor,
    );
    const sh = await legs({ movementContext: 'SH' });
    expect(sh).toHaveLength(2);
    expect(sh.map((l) => ({ line: l.ordDetail, qty: l.qty }))).toEqual([
      { line: 706, qty: -8 },
      { line: 707, qty: -12 },
    ]);
    expect(sh[0].value).toBeCloseTo(-16, 4);
    expect(sh[1].value).toBeCloseTo(-24, 4);
  });

  it('sub-cent leg values are stored exactly (numeric(19,4), not cent-rounding money)', async () => {
    const { inventory } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'US' });
    await addItem(prisma, { id: 1, code: 'WIDGET' });
    await addLot(prisma, { lot: 'L1', itemId: 1, unitCost: 0.3333 });
    await addSublot(prisma, { id: 10, lot: 'L1' });
    const locId = await addLocation(prisma, { id: 1, code: 'WH1', context: 'WHS' });
    const invId = await addInventory(prisma, { itemId: 1, sublotId: 10, locationId: locId, qty: 100 });

    await inventory.adjust({ inventoryId: invId, newQty: 88, reason: 'count' }, actor); // -12 x 0.3333 = -3.9996
    const all = await legs({ movementContext: 'COUNT' });
    expect(all[0].value).toBe(-3.9996); // exact — a money column would store -4.00
  });

  it('the accounting adjustments export books the lot-enable ledger rebase from its movement legs', async () => {
    const { lotTracking } = services(prisma);
    await addEntity(prisma, { id: 4, code: 'US' });
    const locId = await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
    await addItem(prisma, { id: 1, code: 'CONV' });
    await prisma.changeSet.create({ data: { id: 500, context: 'PO', changeDate: D('2024-01-01') } });
    await prisma.invMovement.create({ data: { id: 9001, context: 'PO', changeSetId: 500, itemId: 1 } });
    await prisma.invMovementDtl.create({
      data: { id: 9101, invMovementId: 9001, context: 'MK', ownerId: 4, locationId: locId, qty: 40, value: 80 },
    });
    await addLot(prisma, { lot: 'LEG', itemId: 1 });
    await addSublot(prisma, { id: 20, lot: 'LEG' });
    await addInventory(prisma, { itemId: 1, sublotId: 20, locationId: locId, qty: 38 });
    await lotTracking.enable(
      1,
      { groups: [{ locationId: locId, entries: [{ vendorLot: 'V-77', qty: 35, unitCost: 2.1, supplierId: null }] }] },
      actor,
    );

    const journal = new AccountingJournalService(prisma as unknown as PrismaService, new SettingsService(prisma as unknown as PrismaService));
    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 3600_000);
    const { entries } = await journal.build(from, to, new Set(['adjustments']));
    // Negation -80 + opening +73.50 -> net -6.50 booked, never silently dropped.
    const rebase = entries.filter((e) => e.source === 'adjustment');
    expect(rebase).toHaveLength(1);
    expect(rebase[0].memo).toMatch(/rebase/i);
    expect(rebase[0].lines[0].amount).toBeCloseTo(-6.5, 4);
    expect(rebase[0].lines[1].amount).toBeCloseTo(6.5, 4);
  });
});

