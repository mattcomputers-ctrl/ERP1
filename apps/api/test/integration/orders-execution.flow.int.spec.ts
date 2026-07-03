import type { PrismaClient } from '@erp1/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/auth/current-user.decorator';
import {
  addInventory,
  addItem,
  addLocation,
  addLot,
  addOrdDetail,
  addOrdDetailTest,
  addOrder,
  addSublot,
  makePrisma,
  onHandForLot,
  resetDb,
  seedActor,
  services,
} from './support';

// Guided batch execution against a real Postgres: per-line record-actuals
// (dispense lots / FIFO / skip / instruction check-off), batch additions,
// in-process test results, the material-variance report, and the PK
// ExecStatus='STD' completion stamp — the full §5 execution engine.

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

/**
 * A Released MFBA order shaped like the live data: PK product line (+ produced
 * lot of record), a lot-traced UI line, a FIFO UI line, and an instruction.
 * Raw stock: traced lot 'RT' (cost 5/unit, 100 on hand), FIFO lots OLD/NEW.
 */
async function releasedBatch(opts?: { status?: string; percentOver?: number | null }) {
  await addLocation(prisma, { id: 1, code: 'WH', context: 'WHS' });
  await addItem(prisma, { id: 1, code: 'PROD' }); // product
  await addItem(prisma, { id: 2, code: 'TRACED', lotTracked: true }); // traced raw
  await addItem(prisma, { id: 3, code: 'BULK', lotTracked: false, purchasePrice: 4 }); // FIFO raw
  await addOrder(prisma, { id: 800, context: 'MFBA', status: opts?.status ?? 'RLS', actualBatchSize: 100 });
  await addOrdDetail(prisma, { id: 900, ordrId: 800, context: 'PK', itemId: 1, qtyReqd: 100 });
  await addOrdDetail(prisma, {
    id: 901, ordrId: 800, context: 'UI', itemId: 2, qtyReqd: 10,
    percentOver: opts?.percentOver ?? null,
  });
  await addOrdDetail(prisma, { id: 902, ordrId: 800, context: 'UI', itemId: 3, qtyReqd: 8 });
  await addOrdDetail(prisma, { id: 903, ordrId: 800, context: 'INSTR', description: 'Mix 10 minutes' });
  await addLot(prisma, { lot: 'PROD1', itemId: 1, ordDetailId: 900 });
  await addLot(prisma, { lot: 'RT', itemId: 2, unitCost: 5 });
  await addSublot(prisma, { id: 1, lot: 'RT' });
  await addInventory(prisma, { itemId: 2, sublotId: 1, locationId: 1, qty: 100 });
  await addLot(prisma, { lot: 'NEW', itemId: 3, unitCost: 9, receivedDate: D('2020-06-01') });
  await addLot(prisma, { lot: 'OLD', itemId: 3, unitCost: 3, receivedDate: D('2020-01-01') });
  await addSublot(prisma, { id: 2, lot: 'NEW' });
  await addSublot(prisma, { id: 3, lot: 'OLD' });
  await addInventory(prisma, { itemId: 3, sublotId: 2, locationId: 1, qty: 6 });
  await addInventory(prisma, { itemId: 3, sublotId: 3, locationId: 1, qty: 6 });
}

describe('OrdersService.recordLine (guided dispense/weigh per line)', () => {
  it('records a lot-traced material line: actual on QtyUsed, ExecStatus CMP, lots depleted + lineage + cost roll-up', async () => {
    await releasedBatch();
    const { orders } = services(prisma);

    const res = await orders.recordLine(800, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    expect(res.qtyUsed).toBe(12);
    expect(res.shortfalls).toEqual([]);
    expect(res.toleranceWarning).toBeNull();

    const line = await prisma.ordDetail.findUnique({ where: { id: 901 } });
    expect(line!.qtyUsed).toBe(12); // the ACTUAL, not the planned 10
    expect(line!.execStatus).toBe('CMP');
    expect(await onHandForLot(prisma, 'RT')).toBe(88);
    const edges = await prisma.lotGenealogy.findMany({ where: { childLot: 'PROD1', source: 'consumption' } });
    expect(edges.map((e) => e.parentLot)).toEqual(['RT']);
    // Cost rolled into the produced lot: 12 × 5 / 100 (actual batch size).
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PROD1' } }))!.unitCost)).toBeCloseTo(0.6, 10);
    expect(await prisma.auditLog.count({ where: { action: 'order.execution.record' } })).toBe(1);
  });

  it('consumes a not-traced material line FIFO (oldest first) at the recorded actual', async () => {
    await releasedBatch();
    const { orders } = services(prisma);

    await orders.recordLine(800, 902, { actualQty: 8 }, actor);
    expect(await onHandForLot(prisma, 'OLD')).toBe(0); // 6 drawn from the older lot first
    expect(await onHandForLot(prisma, 'NEW')).toBe(4); // then 2 from the newer
    const line = await prisma.ordDetail.findUnique({ where: { id: 902 } });
    expect(line!.qtyUsed).toBe(8);
    expect(line!.execStatus).toBe('CMP');
  });

  it('records a SKIPPED line (actual 0): ExecStatus CMP, QtyUsed 0, nothing consumed', async () => {
    await releasedBatch();
    const { orders } = services(prisma);

    await orders.recordLine(800, 901, { actualQty: 0 }, actor);
    const line = await prisma.ordDetail.findUnique({ where: { id: 901 } });
    expect(line!.qtyUsed).toBe(0);
    expect(line!.execStatus).toBe('CMP');
    expect(await onHandForLot(prisma, 'RT')).toBe(100); // untouched
    expect(await prisma.lotGenealogy.count()).toBe(0);
  });

  it('checks off an instruction line (no qty allowed)', async () => {
    await releasedBatch();
    const { orders } = services(prisma);

    await expect(orders.recordLine(800, 903, { actualQty: 1 }, actor)).rejects.toThrow(/check-off/);
    const res = await orders.recordLine(800, 903, {}, actor);
    expect(res.recorded).toBe(true);
    expect((await prisma.ordDetail.findUnique({ where: { id: 903 } }))!.execStatus).toBe('CMP');
  });

  it('warns (but records) outside the PercentOver tolerance', async () => {
    await releasedBatch({ percentOver: 10 }); // planned 10 -> max 11
    const { orders } = services(prisma);

    const res = await orders.recordLine(800, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    expect(res.toleranceWarning).toMatch(/over the planned/);
    expect((await prisma.ordDetail.findUnique({ where: { id: 901 } }))!.qtyUsed).toBe(12); // recorded anyway
  });

  it('rejects: lots that do not sum to the actual; a wrong-item lot; a traced line without lots; lots on a FIFO line', async () => {
    await releasedBatch();
    const { orders } = services(prisma);

    await expect(
      orders.recordLine(800, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 5 }] }, actor),
    ).rejects.toThrow(/must sum to the actual/);
    await expect(
      orders.recordLine(800, 901, { actualQty: 6, lots: [{ lot: 'OLD', qty: 6 }] }, actor),
    ).rejects.toThrow(/not a lot of item/);
    await expect(orders.recordLine(800, 901, { actualQty: 6 }, actor)).rejects.toThrow(/lot-traced/);
    await expect(
      orders.recordLine(800, 902, { actualQty: 6, lots: [{ lot: 'OLD', qty: 6 }] }, actor),
    ).rejects.toThrow(/omit lots/);
    // Nothing recorded by any rejection.
    expect((await prisma.ordDetail.findUnique({ where: { id: 901 } }))!.execStatus).toBeNull();
    expect(await prisma.lotGenealogy.count()).toBe(0);
  });

  it('rejects re-recording an already-recorded line', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.recordLine(800, 902, { actualQty: 8 }, actor);
    await expect(orders.recordLine(800, 902, { actualQty: 9 }, actor)).rejects.toThrow(/already recorded/);
    expect((await prisma.ordDetail.findUnique({ where: { id: 902 } }))!.qtyUsed).toBe(8); // first record stands
  });

  it('rejects recording on a not-Released order and on a line of a DIFFERENT order (IDOR)', async () => {
    await releasedBatch({ status: 'NST' });
    const { orders } = services(prisma);
    await expect(orders.recordLine(800, 901, { actualQty: 1 }, actor)).rejects.toThrow(/must be Released/);

    await prisma.ordr.update({ where: { id: 800 }, data: { status: 'RLS' } });
    await addOrder(prisma, { id: 801, context: 'MFBA', status: 'RLS' });
    await expect(orders.recordLine(801, 901, { actualQty: 1 }, actor)).rejects.toThrow(/not found/i);
  });
});

describe('OrdersService.addExecutionLine (batch additions)', () => {
  it('appends an executed UI line (native id) and consumes it immediately', async () => {
    await releasedBatch();
    const { orders } = services(prisma);

    const res = await orders.addExecutionLine(800, { itemId: 3, qty: 5 }, actor);
    expect(res.lineId).toBeGreaterThanOrEqual(1_000_000_000); // native id — import-safe
    const line = await prisma.ordDetail.findUnique({ where: { id: res.lineId } });
    expect(line!.context).toBe('UI');
    expect(line!.qtyReqd).toBe(5); // born at actuals, like the legacy batch additions
    expect(line!.stdQty).toBe(5);
    expect(line!.qtyUsed).toBe(5);
    expect(line!.execStatus).toBe('CMP');
    expect(await onHandForLot(prisma, 'OLD')).toBe(1); // FIFO consumed 5 of 6
    expect(await prisma.auditLog.count({ where: { action: 'order.execution.addLine' } })).toBe(1);
  });

  it('requires lots for a traced item and a Released order', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await expect(orders.addExecutionLine(800, { itemId: 2, qty: 3 }, actor)).rejects.toThrow(/lot-traced/);

    const ok = await orders.addExecutionLine(800, { itemId: 2, qty: 3, lots: [{ lot: 'RT', qty: 3 }] }, actor);
    expect(await onHandForLot(prisma, 'RT')).toBe(97);
    expect((await prisma.ordDetail.findUnique({ where: { id: ok.lineId } }))!.qtyUsed).toBe(3);

    await prisma.ordr.update({ where: { id: 800 }, data: { status: 'CMP' } });
    await expect(orders.addExecutionLine(800, { itemId: 3, qty: 1 }, actor)).rejects.toThrow(/must be Released/);
  });
});

describe('OrdersService.recordIptResults (in-process results — ERP1 extension)', () => {
  async function withTests(status = 'RLS') {
    await releasedBatch({ status });
    await addOrdDetail(prisma, { id: 904, ordrId: 800, context: 'IPT' });
    await addOrdDetailTest(prisma, { id: 50, ordDetailId: 904, test: 'PH', min: 6, max: 8 });
    await addOrdDetailTest(prisma, { id: 51, ordDetailId: 904, test: 'APPEARANCE', specification: 'Clear blue' });
  }

  it('computes pass/fail against the line spec and stamps who/when', async () => {
    await withTests();
    const { orders } = services(prisma);

    await orders.recordIptResults(800, { results: [{ testId: 50, result: '7.2' }, { testId: 51, result: 'Clear blue' }] }, actor);
    const ph = await prisma.ordDetailTest.findUnique({ where: { id: 50 } });
    expect(ph!.result).toBe('7.2');
    expect(ph!.passed).toBe(true);
    expect(ph!.resultBy).toBeTruthy();
    expect(ph!.resultAt).toBeInstanceOf(Date);
    const app = await prisma.ordDetailTest.findUnique({ where: { id: 51 } });
    expect(app!.passed).toBe(true); // non-numeric spec: present -> operator-judged pass

    // Out-of-range numeric fails; blank clears.
    await orders.recordIptResults(800, { results: [{ testId: 50, result: '9.5' }] }, actor);
    expect((await prisma.ordDetailTest.findUnique({ where: { id: 50 } }))!.passed).toBe(false);
    await orders.recordIptResults(800, { results: [{ testId: 50 }] }, actor);
    const cleared = await prisma.ordDetailTest.findUnique({ where: { id: 50 } });
    expect(cleared!.result).toBeNull();
    expect(cleared!.passed).toBeNull();
    expect(cleared!.resultBy).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'order.iptResults' } })).toBe(3);
  });

  it('allows recording on a Completed order (QC writes up after close-out) but not Not-started; rejects foreign tests', async () => {
    await withTests('CMP');
    const { orders } = services(prisma);
    await orders.recordIptResults(800, { results: [{ testId: 50, result: '6.5' }] }, actor);
    expect((await prisma.ordDetailTest.findUnique({ where: { id: 50 } }))!.passed).toBe(true);

    await prisma.ordr.update({ where: { id: 800 }, data: { status: 'NST' } });
    await expect(orders.recordIptResults(800, { results: [{ testId: 50, result: '7' }] }, actor)).rejects.toThrow(/must be Released or Completed/);

    await prisma.ordr.update({ where: { id: 800 }, data: { status: 'RLS' } });
    await addOrder(prisma, { id: 802, context: 'MFBA', status: 'RLS' });
    await expect(orders.recordIptResults(802, { results: [{ testId: 50, result: '7' }] }, actor)).rejects.toThrow(/does not belong/);
  });
});

describe('OrdersService.variance (material variance + yield)', () => {
  it('reports planned vs actual per line costed at the REAL consumed unit cost, with yield', async () => {
    await releasedBatch();
    const { orders } = services(prisma);
    await orders.recordLine(800, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor); // +2 over planned 10, cost 5
    // Line 902 (planned 8) left unrecorded.

    const v = await orders.variance(800);
    const traced = v.lines.find((l) => l.lineId === 901)!;
    expect(traced.planned).toBe(10);
    expect(traced.actual).toBe(12);
    expect(traced.delta).toBe(2);
    expect(traced.pct).toBeCloseTo(20, 10);
    expect(traced.unitCost).toBeCloseTo(5, 10); // the consumed lot's real cost
    expect(traced.costVariance).toBeCloseTo(10, 10); // 2 × 5

    const fifo = v.lines.find((l) => l.lineId === 902)!;
    expect(fifo.recorded).toBe(false);
    expect(fifo.actual).toBeNull();
    expect(fifo.delta).toBeNull();
    expect(fifo.unitCost).toBeCloseTo(4, 10); // nothing consumed -> purchase-price fallback

    expect(v.totals.recordedLines).toBe(1);
    expect(v.totals.totalLines).toBe(2);
    expect(v.totals.costVariance).toBeCloseTo(10, 10);
    expect(v.yield.planned).toBe(100); // PK QtyReqd
    // Not completed yet: ActualBatchSize still holds the planned size seeded at
    // creation, so there is no ACTUAL yield to report.
    expect(v.yield.actual).toBeNull();
    expect(v.yield.pct).toBeNull();
  });
});

describe('concurrent dispensing (locked parcel reads)', () => {
  it('two orders dispensing the same lot serialize — depletion is conserved, no lost update', async () => {
    await releasedBatch(); // order 800, lot RT: 100 on hand
    // A second Released order with its own produced lot, also dispensing RT.
    await addOrder(prisma, { id: 810, context: 'MFBA', status: 'RLS', actualBatchSize: 50 });
    await addOrdDetail(prisma, { id: 910, ordrId: 810, context: 'PK', itemId: 1, qtyReqd: 50 });
    await addOrdDetail(prisma, { id: 911, ordrId: 810, context: 'UI', itemId: 2, qtyReqd: 80 });
    await addLot(prisma, { lot: 'PROD2', itemId: 1, ordDetailId: 910 });
    const { orders } = services(prisma);

    const [r1, r2] = await Promise.all([
      orders.recordLine(800, 901, { actualQty: 80, lots: [{ lot: 'RT', qty: 80 }] }, actor),
      orders.recordLine(810, 911, { actualQty: 80, lots: [{ lot: 'RT', qty: 80 }] }, actor),
    ]);

    // 160 requested against 100 on hand: whichever tx ran second must have SEEN
    // the first depletion (locked read) — 100 depleted total, 60 short, never
    // negative and never a phantom 160-unit depletion.
    expect(await onHandForLot(prisma, 'RT')).toBe(0);
    const shortTotal = [...r1.shortfalls, ...r2.shortfalls].reduce((s, x) => s + x.shortfall, 0);
    expect(shortTotal).toBeCloseTo(60, 10);
  });
});

describe('complete() stamps the legacy PK ExecStatus convention + re-rolls cost at the ACTUAL yield', () => {
  it("sets PK ExecStatus 'STD', re-divides the produced cost by the actual batch size, and variance then reports yield", async () => {
    await releasedBatch();
    // An ENABLED order.complete secured item that relaxes the signature (the
    // fail-safe default would demand a password re-auth this test doesn't need).
    await prisma.securedItem.create({
      data: { key: 'order.complete', description: 'order.complete', requireReason: true, requireSignature: false, requireWitness: false },
    });
    const { orders } = services(prisma);
    // Dispense 12 of RT (unit cost 5): during execution the divisor is the
    // planned 100 (ActualBatchSize as seeded at creation) -> 0.6/unit.
    await orders.recordLine(800, 901, { actualQty: 12, lots: [{ lot: 'RT', qty: 12 }] }, actor);
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PROD1' } }))!.unitCost)).toBeCloseTo(0.6, 10);

    await orders.complete(800, { reason: 'batch done', actualBatchSize: 102 }, actor);
    const pk = await prisma.ordDetail.findUnique({ where: { id: 900 } });
    expect(pk!.execStatus).toBe('STD');
    expect((await prisma.ordr.findUnique({ where: { id: 800 } }))!.actualBatchSize).toBe(102);
    // Cost re-rolled at the ACTUAL yield: 12 × 5 / 102 (Decimal(18,6) storage).
    expect(Number((await prisma.lot.findUnique({ where: { lot: 'PROD1' } }))!.unitCost)).toBeCloseTo(60 / 102, 5);

    const v = await orders.variance(800);
    expect(v.yield.planned).toBe(100);
    expect(v.yield.actual).toBe(102); // completed — the recorded actual yield
    expect(v.yield.pct).toBeCloseTo(102, 10);
  });
});
