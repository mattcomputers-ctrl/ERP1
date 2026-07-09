import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { maxRawLotNumber } from '../common/lot-numbers';
import { MovementRecorderService, type MovementEvent } from '../inventory/movement-recorder.service';
import { PrismaService } from '../prisma/prisma.service';
import { SamplingService } from '../qa/sampling.service';
import type { EnableLotTrackingDto } from './dto/enable-lot-tracking.dto';

@Injectable()
export class LotTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly movements: MovementRecorderService,
    private readonly sampling: SamplingService,
  ) {}

  /** Items with their lot-tracking status (for the enabling screen). */
  async items(query: ListQuery & { tracked?: string }) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['itemCode', 'description', 'context'],
      defaultSort: { itemCode: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      where.OR = [
        { itemCode: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.tracked === '1') where.lotTracked = true;
    if (query.tracked === '0') where.lotTracked = false;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({
        where, skip, take, orderBy,
        select: { id: true, itemCode: true, description: true, context: true, unit: true, lotTracked: true },
      }),
      this.prisma.item.count({ where }),
    ]);
    return { rows, total, page, pageSize };
  }

  /** Pickable storage locations (those with a code) for the opening-stock form. */
  async locationOptions(q?: string) {
    const term = q?.trim();
    const rows = await this.prisma.location.findMany({
      where: {
        locationCode: term
          ? { contains: term, mode: 'insensitive' }
          : { not: null },
      },
      orderBy: { locationCode: 'asc' },
      take: 50,
      select: { id: true, locationCode: true, context: true },
    });
    return { rows };
  }

  /**
   * Enable lot tracking for an item: capture its opening on-hand stock by lot
   * (grouped per location) and switch the item to lot-traced. For a raw vendor
   * lot we mint an ERP1 lot number (sequential from 100, the same rule as
   * receiving) and tag it with the supplier + vendor lot so the stock can be
   * relabeled; for a finished good the existing lot number is used as-is. The
   * item's prior (legacy / non-lot) inventory is WIPED and replaced by the
   * lot-keyed rows. One transaction, atomic hash-chained audit. Returns the
   * created lots (incl. the minted numbers, for labeling).
   */
  async enable(itemId: number, dto: EnableLotTrackingDto, actor: Actor) {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, itemCode: true, lotTracked: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    // Validate locations exist and each entry is exactly one of vendor lot / lot
    // number; reject a duplicate (location, finished-good lot) which would
    // double-book the same on-hand parcel.
    const locIds = [...new Set(dto.groups.map((g) => g.locationId))];
    const locs = await this.prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true } });
    const locSet = new Set(locs.map((l) => l.id));
    const fgSeen = new Set<string>();
    for (const g of dto.groups) {
      if (!locSet.has(g.locationId)) throw new BadRequestException(`Location ${g.locationId} not found.`);
      for (const e of g.entries) {
        const hasVendor = !!e.vendorLot?.trim();
        const hasLot = !!e.lotNumber?.trim();
        if (hasVendor === hasLot) {
          throw new BadRequestException(
            'Each opening-stock entry needs either a vendor lot (raw material) or a lot number (finished good) — not both or neither.',
          );
        }
        if (hasLot) {
          const key = `${g.locationId}|${e.lotNumber!.trim().toLowerCase()}`;
          if (fgSeen.has(key)) {
            throw new BadRequestException(`Lot ${e.lotNumber!.trim()} is entered more than once for the same location.`);
          }
          fgSeen.add(key);
        }
      }
    }

    // Validate any supplier referenced by a raw entry (mirrors purchase-order create).
    const supplierIds = [
      ...new Set(dto.groups.flatMap((g) => g.entries.map((e) => e.supplierId).filter((v): v is number => v != null))),
    ];
    if (supplierIds.length) {
      const suppliers = await this.prisma.entity.findMany({
        where: { id: { in: supplierIds } },
        select: { id: true, isSupplier: true },
      });
      const byId = new Map(suppliers.map((s) => [s.id, s]));
      for (const sid of supplierIds) {
        const s = byId.get(sid);
        if (!s) throw new BadRequestException(`Supplier ${sid} not found.`);
        if (!s.isSupplier) throw new BadRequestException(`Entity ${sid} is not flagged as a supplier.`);
      }
    }

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // An in-flight native QC sample (Hold release + retained SMP parcel from
      // a completion) pins the item: the wipe below would destroy the physical
      // sample a pending disposition refers to. Dispositioned samples are
      // history and wipe like any other prior on-hand (the shipped semantic
      // already wiped LEGACY retained-sample parcels). Serialized by the alloc
      // lock — completions/dispositions/reversals all hold it.
      const holdSample = await tx.$queryRaw<{ id: number }[]>`
        SELECT r."Release" AS id
        FROM "Release" r
        JOIN "Sublot" s ON s."Sublot" = r."Sublot"
        JOIN "Lot" l ON l."Lot" = s."Lot"
        WHERE l."Item" = ${itemId} AND r."Release" >= ${NATIVE_ID_BASE}
          AND r."SampleSet" IS NOT NULL AND r."Status" = 'Hold'
        LIMIT 1`;
      if (holdSample.length) {
        throw new BadRequestException(
          'This item has an undispositioned QC sample from a native batch completion — disposition it (or reverse the batch) before enabling lot tracking.',
        );
      }

      // Staged shipping reservations pin the item the same way: the wipe would
      // destroy parcels reserved to an open SH order line (imported legacy
      // staging included — Inventory.OrdDetail mirrors it), silently emptying
      // a physically-staged assembly. Ship or unstage first.
      const reservedParcel = await tx.$queryRaw<{ id: number }[]>`
        SELECT "Inventory" AS id FROM "Inventory"
        WHERE "Item" = ${itemId} AND "OrdDetail" IS NOT NULL AND "Qty" > 0
        LIMIT 1`;
      if (reservedParcel.length) {
        throw new BadRequestException(
          'This item has stock staged to a shipping order — ship or unstage the reserved parcels before enabling lot tracking.',
        );
      }

      // Wipe the item's prior (legacy / non-lot) on-hand; the entered lots become
      // the on-hand of record. The parcels are locked FIRST in one ascending-id
      // scan — the system-wide parcel lock order (see ValuationService.
      // depleteSpecificMany): a bare DELETE acquires its row locks in plan
      // order and could invert against a concurrent depleter's ascending scan
      // over the same item. New parcels can't appear between the scan and the
      // delete — every IN-APP parcel creator serializes on the advisory lock
      // held above, and the legacy import skips Inventory rows of lot-tracked
      // items entirely (ERP1 owns their on-hand from this moment — see
      // legacy-import upsertRows).
      const parcels = await tx.$queryRaw<{ id: number }[]>`
        SELECT "Inventory" AS id FROM "Inventory"
        WHERE "Item" = ${itemId}
        ORDER BY "Inventory" ASC
        FOR UPDATE`;
      if (parcels.length) {
        await tx.inventory.deleteMany({ where: { id: { in: parcels.map((p) => p.id) } } });
      }

      let subId =
        (await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE;
      // Inventory ids are also allocated in the native range so a later legacy
      // re-import (upsert by legacy PK) can't clobber these opening-stock rows.
      let invId =
        (await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE;
      // Raw-material lot sequence (from 100), shared with purchase receiving.
      let lotSeq = await maxRawLotNumber(tx);

      const created: { lot: string; vendorLot: string | null; qty: number; unitCost: number | null; locationId: number; raw: boolean; sublotId: number }[] = [];
      for (const g of dto.groups) {
        for (const e of g.entries) {
          const raw = !!e.vendorLot?.trim();
          let lotNumber: string;
          const unitCost = e.unitCost ?? null;
          if (raw) {
            lotNumber = String((lotSeq += 1));
            await tx.lot.create({
              data: {
                lot: lotNumber,
                context: 'LOT',
                itemId,
                supplierId: e.supplierId ?? null,
                supLot: e.vendorLot!.trim(),
                manfLot: e.vendorLot!.trim(),
                receivedDate: at,
                unitCost,
              },
            });
          } else {
            lotNumber = e.lotNumber!.trim();
            const existing = await tx.lot.findUnique({ where: { lot: lotNumber }, select: { itemId: true } });
            if (!existing) {
              await tx.lot.create({ data: { lot: lotNumber, context: 'LOT', itemId, manfLot: lotNumber, unitCost } });
            } else if (existing.itemId != null && existing.itemId !== itemId) {
              throw new BadRequestException(
                `Lot ${lotNumber} already belongs to a different item — enter a lot number for ${item.itemCode}.`,
              );
            } else if (unitCost != null) {
              // Existing (e.g. imported) finished-good lot — record the entered cost.
              await tx.lot.update({ where: { lot: lotNumber }, data: { unitCost } });
            }
          }

          // Sublot is 1:1 with a lot in this install — reuse an existing sublot for
          // the lot (e.g. an imported FG lot), else mint a native one.
          const existingSub = await tx.sublot.findFirst({ where: { lot: lotNumber }, select: { id: true } });
          const sublotId = existingSub?.id ?? (subId += 1);
          if (!existingSub) {
            await tx.sublot.create({ data: { id: sublotId, lot: lotNumber, sublotCode: lotNumber, context: 'LOT' } });
          }

          await tx.inventory.create({
            data: { id: (invId += 1), itemId, sublotId, locationId: g.locationId, qty: e.qty, status: null },
          });
          // QA release at birth for opening-stock sublots — Approved (this is
          // stock the plant already owns and uses); idempotent for reused
          // imported FG sublots that already carry a release (ASSUMPTIONS §21).
          await this.sampling.createApprovedRelease(tx, { sublotId, actorLabel: actor.label ?? actor.id, at });
          created.push({ lot: lotNumber, vendorLot: e.vendorLot?.trim() ?? null, qty: e.qty, unitCost, locationId: g.locationId, raw, sublotId });
        }
      }

      await tx.item.update({ where: { id: itemId }, data: { lotTracked: true } });

      // Movement ledger: the wipe + opening stock as one COUNT event set. The
      // item's movement-implied balance (Σ non-B legs per owner — the exact
      // at-date formula) is NEGATED first: without it, at-date would keep the
      // legacy balance under the new opening legs and double-count. Negating
      // the LEG sums (not the wiped parcels) is deliberate — at-date is defined
      // by the ledger, so this zeroes it exactly even where the legacy parcels
      // and legs disagree. Then one MK leg per opening entry.
      const csId =
        ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
          NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: 'COUNT', changeDate: at } });
      const events: MovementEvent[] = [];
      const balances = await tx.$queryRaw<{ owner: number; qty: number | null; value: number | null }[]>`
        SELECT imd."Owner" AS owner,
               SUM(COALESCE(imd."Qty", 0))::float8 AS qty,
               SUM(imd."Value"::numeric)::float8 AS value
        FROM "InvMovementDtl" imd
        JOIN "InvMovement" im ON im."InvMovement" = imd."InvMovement"
        WHERE im."Item" = ${itemId}
          AND imd."Context" IN ('MK', 'MKCA', 'US', 'USCA', 'ADJ', 'SCRAP')
        GROUP BY imd."Owner"`;
      for (const b of balances) {
        const qty = b.qty ?? 0; // full float precision — the negation must cancel the sum exactly
        const value = b.value != null ? this.movements.money4(b.value) : null;
        if (Math.abs(qty) < 1e-9 && (value == null || value === 0)) continue;
        events.push({
          context: 'COUNT', changeSetId: csId, itemId,
          legs: [
            Math.abs(qty) >= 1e-9
              ? { context: 'US', ownerId: b.owner, qty: -qty, value: value != null ? -value : null }
              : { context: 'USCA', ownerId: b.owner, qty: null, value: value != null ? -value : null },
          ],
        });
      }
      const owner = await this.movements.defaultOwnerId(tx);
      for (const c of created) {
        events.push({
          context: 'COUNT', changeSetId: csId, itemId, sublotId: c.sublotId,
          legs: [{
            context: 'MK', ownerId: owner, locationId: c.locationId,
            qty: c.qty, value: c.unitCost != null ? this.movements.money4(c.qty * c.unitCost) : null,
          }],
        });
      }
      await this.movements.record(tx, events);

      await this.audit.record(
        {
          action: 'item.lottracking.enable',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.lotTracking',
          summary:
            `Lot tracking enabled for ${item.itemCode}: ${created.length} opening lot` +
            `${created.length === 1 ? '' : 's'} captured, prior inventory replaced`,
          changes: [
            { tableName: 'Item', recordId: String(itemId), fieldName: 'lotTracked', oldValue: String(item.lotTracked), newValue: 'true' },
          ],
        },
        tx,
      );

      return { itemId, lotTracked: true, lots: created };
    });
  }

  /**
   * Disable lot tracking for an item (revert to FIFO-by-quantity). The lot-keyed
   * on-hand rows remain but the item is no longer lot-traced. Audited.
   */
  async disable(itemId: number, actor: Actor) {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, itemCode: true, lotTracked: true },
    });
    if (!item) throw new NotFoundException('Item not found');
    if (!item.lotTracked) return { itemId, lotTracked: false };

    await this.prisma.$transaction(async (tx) => {
      await tx.item.update({ where: { id: itemId }, data: { lotTracked: false } });
      await this.audit.record(
        {
          action: 'item.lottracking.disable',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.lotTracking',
          summary: `Lot tracking disabled for ${item.itemCode} (reverted to FIFO by quantity)`,
          changes: [
            { tableName: 'Item', recordId: String(itemId), fieldName: 'lotTracked', oldValue: 'true', newValue: 'false' },
          ],
        },
        tx,
      );
    });
    return { itemId, lotTracked: false };
  }
}
