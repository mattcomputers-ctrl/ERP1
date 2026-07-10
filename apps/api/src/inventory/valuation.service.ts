import { Injectable } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { fifoCompare, greedyDeplete, producedUnitCost } from './valuation.math';

/**
 * Inventory valuation / consumption engine. Encapsulates the on-hand movements
 * the lot model needs: minting on-hand at receiving and production, depleting it
 * at consumption (specific identification for lot-traced inputs, FIFO for
 * not-traced ones) and at shipment, and rolling consumed cost into produced lots.
 *
 * All mutating helpers take the caller's transaction client (`tx`) so they commit
 * atomically with the business action and share its advisory id-allocation lock.
 * Inventory ids are allocated in the native range (>= NATIVE_ID_BASE) so a later
 * legacy re-import (upsert by legacy PK) can't clobber them — matching how
 * lot-tracking enablement mints Inventory. Reads inside the same tx see prior
 * writes, so a per-row MAX+1 in a loop allocates a correct ascending sequence.
 */
@Injectable()
export class ValuationService {
  // Memoized data-driven default location (effectively constant per install).
  private defaultLocationResolved = false;
  private defaultLocationValue: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Resolve the location stock should land in for a purpose (receiving /
   * production). Prefers the operator setting (a LocationCode); falls back to the
   * install's most-used inventory location (data-driven, like the PO owner), then
   * to the first pickable location. Null only on an inventory-less install.
   */
  async resolveLocationId(tx: Prisma.TransactionClient, settingKey: string): Promise<number | null> {
    const code = (await this.settings.get(settingKey, '')).trim();
    if (code) {
      const loc = await tx.location.findFirst({ where: { locationCode: code }, select: { id: true } });
      if (loc) return loc.id;
    }
    return this.defaultLocationId(tx);
  }

  /**
   * The install's default stock location (memoized). Targets a real warehouse /
   * zone (Location.Context WHS/ZON) — NOT a storage vessel, where most legacy
   * inventory physically sits — preferring the most-used such location, then the
   * first one, then any pickable (LocationCode-bearing) location. Resolved with a
   * raw JOIN so it doesn't bind a huge id list (many locations carry a code).
   * Null only on a location-less install.
   */
  private async defaultLocationId(tx: Prisma.TransactionClient): Promise<number | null> {
    if (this.defaultLocationResolved) return this.defaultLocationValue;
    const mostUsed = await tx.$queryRaw<{ location: number }[]>`
      SELECT inv."Location" AS location
      FROM "Inventory" inv
      JOIN "Location" lo ON lo."Location" = inv."Location"
      WHERE lo."Context" IN ('WHS', 'ZON')
      GROUP BY inv."Location"
      ORDER BY COUNT(*) DESC
      LIMIT 1`;
    let id: number | null = mostUsed[0]?.location ?? null;
    if (id == null) {
      const warehouse = await tx.location.findFirst({ where: { context: { in: ['WHS', 'ZON'] } }, orderBy: { id: 'asc' }, select: { id: true } });
      id = warehouse?.id ?? null;
    }
    if (id == null) {
      const anyPickable = await tx.location.findFirst({ where: { locationCode: { not: null } }, orderBy: { id: 'asc' }, select: { id: true } });
      id = anyPickable?.id ?? null;
    }
    this.defaultLocationValue = id;
    this.defaultLocationResolved = true;
    return id;
  }

  /**
   * Create an on-hand Inventory parcel (native id). Returns the new id, or null
   * if there is no location to put it in (the caller should no-op gracefully).
   */
  async mintInventory(
    tx: Prisma.TransactionClient,
    params: { itemId: number; sublotId: number; locationId: number | null; qty: number },
  ): Promise<number | null> {
    if (params.locationId == null) return null;
    const id =
      ((await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE) + 1;
    await tx.inventory.create({
      data: { id, itemId: params.itemId, sublotId: params.sublotId, locationId: params.locationId, qty: params.qty, status: null },
    });
    return id;
  }

  /**
   * Deplete several specific lots' on-hand in ONE locked acquisition (specific
   * identification — lot-traced consumption, finished-good shipment). Requests
   * for the same lot are aggregated; each lot's parcels are drawn oldest-first
   * (ascending id); never goes negative. Returns per-lot depleted/shortfall
   * (shortfalls are recorded, not blocked — the plant records actuals even if
   * the system's running on-hand lags; a lot with no sublot is all shortfall).
   *
   * LOCK ORDER INVARIANT: every multi-parcel acquisition in the system — this,
   * depleteFifoMany, and order reversal's produced+restored scan — locks its
   * parcels in a SINGLE `SELECT … ORDER BY "Inventory" ASC FOR UPDATE` scan.
   * One statement, one global total order: concurrent acquirers cannot invert
   * (a per-lot loop of scans deadlocks against any other acquirer whose lot
   * order disagrees with the parcels' id order — found the hard way).
   */
  async depleteSpecificMany(
    tx: Prisma.TransactionClient,
    requests: { lot: string; qty: number }[],
    opts?: {
      /**
       * SH staging carve-out: parcels RESERVED to these order lines
       * (Inventory.OrdDetail) are eligible AND drawn first — the shipment path
       * passes its order's line ids so staged assembly stock ships before free
       * warehouse stock. Without it (every other caller), reserved parcels and
       * anything sitting at an ASM staging location are excluded exactly like
       * SMP retained samples: staged stock belongs to a shipping order.
       */
      allowReservedToLineIds?: number[];
    },
  ): Promise<Map<string, { depleted: number; shortfall: number; takes: ParcelTake[] }>> {
    const wantByLot = new Map<string, number>();
    for (const r of requests) wantByLot.set(r.lot, (wantByLot.get(r.lot) ?? 0) + r.qty);
    const result = new Map<string, { depleted: number; shortfall: number; takes: ParcelTake[] }>();
    for (const [lot, want] of wantByLot) result.set(lot, { depleted: 0, shortfall: want, takes: [] });
    const codes = [...wantByLot.keys()];
    if (!codes.length) return result;

    const subs = await tx.sublot.findMany({ where: { lot: { in: codes } }, select: { id: true, lot: true } });
    if (!subs.length) return result;
    const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));

    // The single locked scan (see the lock-order invariant above). Ascending-id
    // order doubles as the oldest-first draw order within each lot (staging
    // reorders the DRAW below — never the lock). Eligibility: SMP-context
    // parcels (retained QC samples — legacy convention AND the native sampling
    // seam's splits) are on-hand but never consumable stock — without the
    // exclusion, exhausting a produced lot's main parcel silently ate the
    // retained sample (2026-07-09 review). Likewise parcels reserved to a
    // shipping order line (Inventory.OrdDetail) or staged at an ASM assembly
    // location are only consumable by THAT order's shipment (the
    // allowReservedToLineIds carve-out) — never by batch consumption or another
    // order's shipment.
    const allowedLines = opts?.allowReservedToLineIds ?? [];
    // Protected-location set: SMP retained samples, ASM staging assemblies,
    // and CONSIGNED warehouse locations (Owner is an IsWarehouse entity —
    // stock that physically sits at the customer's warehouse; drawing it for
    // a plant order would also corrupt the per-owner ledger algebra, since
    // its MK legs belong to the warehouse entity — 2026-07-09 L115 review).
    const rows = await tx.$queryRaw<{ id: number; itemId: number | null; sublotId: number; locationId: number | null; qty: number | null; ordDetailId: number | null }[]>`
      SELECT "Inventory" AS id, "Item" AS "itemId", "Sublot" AS "sublotId", "Location" AS "locationId", "Qty" AS qty, "OrdDetail" AS "ordDetailId" FROM "Inventory"
      WHERE "Sublot" = ANY(${subs.map((s) => s.id)}) AND "Qty" > 0
        AND (
          ("OrdDetail" IS NOT NULL AND "OrdDetail" = ANY(${allowedLines}))
          OR (
            "OrdDetail" IS NULL
            AND ("Location" IS NULL OR "Location" NOT IN (
              SELECT l."Location" FROM "Location" l
              LEFT JOIN "Entity" e ON e."Entity" = l."Owner"
              WHERE l."Context" IN ('SMP', 'ASM') OR e."IsWarehouse" = true
            ))
          )
        )
      ORDER BY "Inventory" ASC
      FOR UPDATE`;
    const reservedFirst = (a: { id: number; ordDetailId: number | null }, b: { id: number; ordDetailId: number | null }) => {
      const ra = a.ordDetailId != null ? 0 : 1;
      const rb = b.ordDetailId != null ? 0 : 1;
      return ra - rb || a.id - b.id;
    };
    const parcelsByLot = new Map<string, { id: number; itemId: number | null; sublotId: number; locationId: number | null; qty: number; ordDetailId: number | null }[]>();
    for (const r of rows) {
      const lot = lotBySub.get(r.sublotId);
      if (lot == null) continue;
      parcelsByLot.set(lot, [
        ...(parcelsByLot.get(lot) ?? []),
        { id: r.id, itemId: r.itemId, sublotId: r.sublotId, locationId: r.locationId, qty: r.qty ?? 0, ordDetailId: r.ordDetailId },
      ]);
    }
    // Reserved-first DRAW order (staged stock ships before free stock); the
    // reserved rows only pass the WHERE when the carve-out allows them, so
    // this is a no-op for non-shipment callers. Lock order is untouched.
    if (allowedLines.length) for (const arr of parcelsByLot.values()) arr.sort(reservedFirst);
    for (const [lot, want] of wantByLot) {
      const parcels = parcelsByLot.get(lot) ?? [];
      if (!parcels.length) continue; // stays all-shortfall
      const { takes, depleted, shortfall } = greedyDeplete(parcels, want);
      const parcelTakes: ParcelTake[] = [];
      for (let i = 0; i < parcels.length; i++) {
        if (takes[i] > 0) {
          await tx.inventory.update({ where: { id: parcels[i].id }, data: { qty: parcels[i].qty - takes[i] } });
          parcelTakes.push({
            parcelId: parcels[i].id, itemId: parcels[i].itemId, sublotId: parcels[i].sublotId,
            locationId: parcels[i].locationId, lot, take: takes[i],
          });
        }
      }
      result.set(lot, { depleted, shortfall, takes: parcelTakes });
    }
    return result;
  }

  /** Single-lot form of depleteSpecificMany (same one-scan acquisition). */
  async depleteSpecific(
    tx: Prisma.TransactionClient,
    lot: string,
    qty: number,
  ): Promise<{ depleted: number; shortfall: number; takes: ParcelTake[] }> {
    const res = await this.depleteSpecificMany(tx, [{ lot, qty }]);
    return res.get(lot) ?? { depleted: 0, shortfall: qty, takes: [] };
  }

  /**
   * Roll the cost of a produced batch lot's consumed inputs into its per-unit
   * unitCost (specific identification). totalCost = Σ over the consumption edges of
   * (consumed qty × that input lot's own unitCost) — REAL extended cost per lot,
   * NOT an average of unit costs — and the produced per-unit cost = totalCost /
   * producedQty. Recomputed from the full edge set so it's correct no matter how
   * many times consumption is recorded. Returns the new per-unit cost, or null when
   * no costed inputs / no produced quantity (the lot's cost is then left untouched).
   */
  async rollUpProducedCost(tx: Prisma.TransactionClient, producedLot: string, producedQty: number): Promise<number | null> {
    if (!(producedQty > 0)) return null;
    const edges = await tx.$queryRaw<{ parent_lot: string; qty: number | null }[]>`
      SELECT parent_lot, qty FROM lot_genealogy WHERE child_lot = ${producedLot} AND source = 'consumption'`;
    if (!edges.length) return null;
    const parentLots = [...new Set(edges.map((e) => e.parent_lot))];
    const lots = await tx.lot.findMany({ where: { lot: { in: parentLots } }, select: { lot: true, itemId: true, unitCost: true } });
    // Fallback to the input item's purchase price when a consumed lot carries no
    // unit cost (e.g. a not-lot-traced item's legacy lots, consumed FIFO).
    const itemIds = [...new Set(lots.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, purchasePrice: true } })
      : [];
    const priceByItem = new Map(items.map((i) => [i.id, i.purchasePrice != null ? Number(i.purchasePrice) : null]));
    const costByLot = new Map(
      lots.map((l) => [
        l.lot,
        l.unitCost != null ? Number(l.unitCost) : l.itemId != null ? priceByItem.get(l.itemId) ?? null : null,
      ]),
    );
    const perUnit = producedUnitCost(
      edges.map((e) => ({ qty: e.qty != null ? Number(e.qty) : 0, unitCost: costByLot.get(e.parent_lot) ?? null })),
      producedQty,
    );
    if (perUnit == null) return null;
    await tx.lot.update({ where: { lot: producedLot }, data: { unitCost: perUnit } });
    return perUnit;
  }

  /**
   * Deplete several NOT-lot-traced items' on-hand FIFO — oldest units first —
   * in ONE locked acquisition (see the lock-order invariant on
   * depleteSpecificMany). Requests for the same item are aggregated. Locking
   * order is global ascending Inventory id; the DRAW order within each item is
   * FIFO by the parcel's lot date (received, else manufactured; undated
   * parcels last), then id — the two orders are independent. Returns, per
   * item, the lots actually drawn from (so the caller records the consumption
   * lineage) plus any shortfall (recorded, not blocked).
   */
  async depleteFifoMany(
    tx: Prisma.TransactionClient,
    requests: { itemId: number; qty: number }[],
  ): Promise<Map<number, { picks: { lot: string; qty: number }[]; depleted: number; shortfall: number; takes: ParcelTake[] }>> {
    const wantByItem = new Map<number, number>();
    for (const r of requests) wantByItem.set(r.itemId, (wantByItem.get(r.itemId) ?? 0) + r.qty);
    const result = new Map<number, { picks: { lot: string; qty: number }[]; depleted: number; shortfall: number; takes: ParcelTake[] }>();
    for (const [itemId, want] of wantByItem) result.set(itemId, { picks: [], depleted: 0, shortfall: want, takes: [] });
    const itemIds = [...wantByItem.keys()];
    if (!itemIds.length) return result;

    // The single locked scan (lock-order invariant — one statement, global
    // ascending id, across ALL requested items). SMP retained-sample parcels
    // excluded — never consumable stock; SH-reserved parcels (OrdDetail set),
    // ASM staging locations, and CONSIGNED warehouse-owned locations likewise
    // (see depleteSpecificMany's protected-location rationale).
    const rows = await tx.$queryRaw<{ id: number; itemId: number; sublotId: number | null; locationId: number | null; qty: number | null }[]>`
      SELECT "Inventory" AS id, "Item" AS "itemId", "Sublot" AS "sublotId", "Location" AS "locationId", "Qty" AS qty FROM "Inventory"
      WHERE "Item" = ANY(${itemIds}) AND "Qty" > 0 AND "Sublot" IS NOT NULL AND "OrdDetail" IS NULL
        AND ("Location" IS NULL OR "Location" NOT IN (
          SELECT l."Location" FROM "Location" l
          LEFT JOIN "Entity" e ON e."Entity" = l."Owner"
          WHERE l."Context" IN ('SMP', 'ASM') OR e."IsWarehouse" = true
        ))
      ORDER BY "Inventory" ASC
      FOR UPDATE`;
    if (!rows.length) return result;

    const subIds = [...new Set(rows.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const subs = await tx.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } });
    const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));
    const lotCodes = [...new Set([...lotBySub.values()].filter((v): v is string => v != null))];
    const lots = lotCodes.length
      ? await tx.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, receivedDate: true, manfDate: true } })
      : [];
    const dateByLot = new Map(lots.map((l) => [l.lot, l.receivedDate ?? l.manfDate ?? null]));
    const timeForLot = (lot: string) => {
      const d = dateByLot.get(lot) ?? null;
      return d ? d.getTime() : Number.POSITIVE_INFINITY; // undated parcels last
    };

    for (const [itemId, want] of wantByItem) {
      // The item's parcels with a resolvable lot, ordered FIFO, then drawn down.
      const parcels = rows
        .filter((r) => r.itemId === itemId)
        .map((r) => ({
          id: r.id, qty: r.qty ?? 0, sublotId: r.sublotId, locationId: r.locationId,
          lot: r.sublotId != null ? lotBySub.get(r.sublotId) ?? null : null,
        }))
        .filter((p): p is { id: number; qty: number; sublotId: number; locationId: number | null; lot: string } => p.lot != null)
        .sort((a, b) => fifoCompare({ time: timeForLot(a.lot), seq: a.id }, { time: timeForLot(b.lot), seq: b.id }));
      if (!parcels.length) continue; // stays all-shortfall
      const { takes, depleted, shortfall } = greedyDeplete(parcels, want);

      const pickByLot = new Map<string, number>();
      const parcelTakes: ParcelTake[] = [];
      for (let i = 0; i < parcels.length; i++) {
        if (takes[i] <= 0) continue;
        await tx.inventory.update({ where: { id: parcels[i].id }, data: { qty: parcels[i].qty - takes[i] } });
        pickByLot.set(parcels[i].lot, (pickByLot.get(parcels[i].lot) ?? 0) + takes[i]);
        parcelTakes.push({
          parcelId: parcels[i].id, itemId, sublotId: parcels[i].sublotId,
          locationId: parcels[i].locationId, lot: parcels[i].lot, take: takes[i],
        });
      }
      result.set(itemId, {
        picks: [...pickByLot.entries()].map(([lot, q]) => ({ lot, qty: q })),
        depleted,
        shortfall,
        takes: parcelTakes,
      });
    }
    return result;
  }

  /** Single-item form of depleteFifoMany (same one-scan acquisition). */
  async depleteFifo(
    tx: Prisma.TransactionClient,
    itemId: number,
    qty: number,
  ): Promise<{ picks: { lot: string; qty: number }[]; depleted: number; shortfall: number; takes: ParcelTake[] }> {
    const res = await this.depleteFifoMany(tx, [{ itemId, qty }]);
    return res.get(itemId) ?? { picks: [], depleted: 0, shortfall: qty, takes: [] };
  }
}

/**
 * One parcel-level draw from a locked depletion scan — the grain the movement
 * ledger records (one US leg per parcel draw, with its true location).
 */
export interface ParcelTake {
  parcelId: number;
  itemId: number | null;
  sublotId: number;
  locationId: number | null;
  lot: string;
  take: number;
}
