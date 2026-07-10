import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import type { Actor } from '../auth/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { MovementRecorderService, MovementEvent } from '../inventory/movement-recorder.service';
import { ValuationService } from '../inventory/valuation.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from './party.service';
import { StageParcelsDto } from './dto/stage-parcels.dto';
import { UnstageParcelsDto } from './dto/unstage-parcels.dto';

/**
 * Pre-shipment staging (the legacy "Shipping Assembly" program — 15,855 uses,
 * active daily). The verified legacy mechanism, reproduced natively:
 *
 * - An ASSEMBLY is a single-use `Location` Context='ASM' (17,675 ever, each
 *   serving exactly ONE shipping order). ERP1 assemblies are native rows
 *   (id ≥ 1e9) with their own 'EA'+5-digit code namespace — NOT legacy's live
 *   'A'+6-digit sequence, whose allocator cannot see native rows during
 *   parallel running (the sample-location 'E' namespace precedent). The owning
 *   order is stamped in Location.Reference (an ERP1 extension on native rows;
 *   legacy leaves it NULL).
 * - STAGING moves parcel quantity into the assembly and RESERVES it to a
 *   shipping-order line via `Inventory.OrdDetail` — exactly how the 12 live
 *   legacy reservations looked. The movement ledger gets a PICK event:
 *   valueless US(−qty at the source) / MK(+qty at the assembly) legs, the MK
 *   leg carrying the reserved line (41,109 legacy PICK legs, all line-bound).
 *   Unstaging mirrors it with the signs flipped (the legacy unpick shape).
 * - Reserved / ASM-staged parcels are EXCLUDED from every depletion scan and
 *   from planning (like SMP retained samples) — only the owning order's
 *   shipment may draw them, reserved-first (ValuationService carve-out).
 * - Staging is restricted to LOT-TRACED items (like ship-lot capture). This
 *   also makes reservations import-safe: the legacy sync wholesale re-copies
 *   Inventory (including OrdDetail) but SKIPS rows of lot-tracked items, and
 *   never touches native-range rows.
 *
 * Lock order (hard conventions 1b/1c): Ordr row lock → NATIVE_ID_ALLOC_LOCK →
 * ONE global ascending-id parcel `FOR UPDATE` scan; audit last.
 */
@Injectable()
export class StagingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly movements: MovementRecorderService,
    private readonly valuation: ValuationService,
    private readonly party: PartyService,
  ) {}

  /** Statuses under which an order can still be staged to (imported legacy
   * open statuses like RTS pass — the plant stages released-to-ship orders). */
  private static readonly UNSTAGEABLE = new Set(['CMP', 'CLS', 'EDT']);

  private async requireOpenShOrder(orderId: number, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    const order = await client.ordr.findUnique({
      where: { id: orderId },
      select: { id: true, context: true, status: true, billToId: true, shipToId: true, poNumber: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') throw new BadRequestException('Only shipping (SH) orders stage assemblies.');
    const status = order.status?.trim() || 'NST';
    if (StagingService.UNSTAGEABLE.has(status)) {
      throw new BadRequestException(`Order #${orderId} is ${status} — staging applies to open shipping orders.`);
    }
    return order;
  }

  private async nextNativeId(
    tx: Prisma.TransactionClient,
    delegate: 'location' | 'inventory' | 'changeSet',
  ): Promise<number> {
    const agg = await (tx[delegate] as unknown as {
      aggregate: (args: object) => Promise<{ _max: { id: number | null } }>;
    }).aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } });
    return (agg._max.id ?? NATIVE_ID_BASE) + 1;
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /**
   * The staging panel for one shipping order: its assemblies (native ones by
   * Reference, plus any imported assembly still holding this order's
   * reservations), their contents, and the per-line reserved totals.
   */
  async staging(orderId: number) {
    const order = await this.prisma.ordr.findUnique({
      where: { id: orderId },
      select: { id: true, context: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') throw new BadRequestException('Only shipping (SH) orders stage assemblies.');
    const status = order.status?.trim() || 'NST';

    const lines = await this.prisma.ordDetail.findMany({
      where: { ordrId: orderId, context: 'SH', itemId: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, itemId: true, qtyReqd: true, qtyUsed: true, entityUnit: true, description: true },
    });
    const lineIds = lines.map((l) => l.id);
    const items = lines.length
      ? await this.prisma.item.findMany({
          where: { id: { in: [...new Set(lines.map((l) => l.itemId!).filter((v) => v != null))] } },
          select: { id: true, itemCode: true, description: true, unit: true, lotTracked: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Reserved parcels (qty > 0 — depletion leaves zeroed husks behind).
    const reserved = lineIds.length
      ? await this.prisma.inventory.findMany({
          where: { ordDetailId: { in: lineIds }, qty: { gt: 0 } },
          select: { id: true, itemId: true, sublotId: true, locationId: true, qty: true, status: true, ordDetailId: true },
        })
      : [];

    // Assemblies: native ones stamped with this order (Reference), plus any
    // location an imported reservation physically sits at (legacy staged state
    // pulled in by sync). DEL'd assemblies only appear while still non-empty.
    const nativeAsm = await this.prisma.location.findMany({
      where: { context: 'ASM', reference: String(orderId) },
      select: { id: true, locationCode: true, status: true, description: true },
    });
    const reservedLocIds = [...new Set(reserved.map((r) => r.locationId).filter((v): v is number => v != null))];
    const extraLocs = reservedLocIds.filter((id) => !nativeAsm.some((a) => a.id === id));
    const importedAsm = extraLocs.length
      ? await this.prisma.location.findMany({
          where: { id: { in: extraLocs }, context: 'ASM' },
          select: { id: true, locationCode: true, status: true, description: true },
        })
      : [];
    const assemblies = [...nativeAsm, ...importedAsm].filter(
      (a) => a.status?.trim() !== 'DEL' || reserved.some((r) => r.locationId === a.id),
    );

    // Contents per assembly (any parcel there, reserved or not — physical truth).
    const asmIds = assemblies.map((a) => a.id);
    const contents = asmIds.length
      ? await this.prisma.inventory.findMany({
          where: { locationId: { in: asmIds }, qty: { gt: 0 } },
          select: { id: true, itemId: true, sublotId: true, locationId: true, qty: true, status: true, ordDetailId: true },
        })
      : [];
    const allParcels = [...contents, ...reserved.filter((r) => !contents.some((c) => c.id === r.id))];
    const subIds = [...new Set(allParcels.map((p) => p.sublotId).filter((v): v is number => v != null))];
    const subs = subIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
      : [];
    const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));
    const contentItemIds = [...new Set(allParcels.map((p) => p.itemId).filter((v) => !itemById.has(v)))];
    if (contentItemIds.length) {
      const extra = await this.prisma.item.findMany({
        where: { id: { in: contentItemIds } },
        select: { id: true, itemCode: true, description: true, unit: true, lotTracked: true },
      });
      for (const i of extra) itemById.set(i.id, i);
    }

    const parcelView = (p: (typeof allParcels)[number]) => ({
      inventoryId: p.id,
      itemId: p.itemId,
      itemCode: itemById.get(p.itemId)?.itemCode ?? null,
      lot: p.sublotId != null ? lotBySub.get(p.sublotId) ?? null : null,
      qty: p.qty ?? 0,
      unit: itemById.get(p.itemId)?.unit ?? null,
      status: p.status,
      ordDetailId: p.ordDetailId,
      // Only native parcels of lot-tracked items are unstageable in ERP1 —
      // imported (sync-owned) reservations are released in legacy.
      native: p.id >= NATIVE_ID_BASE && (itemById.get(p.itemId)?.lotTracked ?? false),
    });

    const reservedByLine = new Map<number, number>();
    for (const r of reserved) {
      if (r.ordDetailId != null) reservedByLine.set(r.ordDetailId, (reservedByLine.get(r.ordDetailId) ?? 0) + (r.qty ?? 0));
    }

    return {
      orderId,
      status,
      stageable: !StagingService.UNSTAGEABLE.has(status),
      lines: lines.map((l) => ({
        ordDetailId: l.id,
        itemId: l.itemId,
        itemCode: l.itemId != null ? itemById.get(l.itemId)?.itemCode ?? null : null,
        description: l.itemId != null ? itemById.get(l.itemId)?.description ?? l.description ?? null : l.description ?? null,
        unit: l.entityUnit ?? (l.itemId != null ? itemById.get(l.itemId)?.unit ?? null : null),
        lotTracked: l.itemId != null ? itemById.get(l.itemId)?.lotTracked ?? false : false,
        qtyReqd: l.qtyReqd,
        qtyUsed: l.qtyUsed,
        reserved: reservedByLine.get(l.id) ?? 0,
      })),
      assemblies: assemblies.map((a) => ({
        locationId: a.id,
        locationCode: a.locationCode,
        status: a.status,
        native: a.id >= NATIVE_ID_BASE,
        parcels: contents.filter((c) => c.locationId === a.id).map(parcelView),
      })),
      // Reservations physically sitting OUTSIDE any listed assembly (shouldn't
      // happen natively; possible in imported edge states) — still shown.
      looseReservations: reserved.filter((r) => !asmIds.includes(r.locationId ?? -1)).map(parcelView),
    };
  }

  /**
   * On-hand parcels eligible to stage for one order line: the line item's
   * free stock (not reserved, not at SMP/ASM/DEL'd locations) at parcel grain.
   */
  async stageCandidates(orderId: number, ordDetailId: number) {
    await this.requireOpenShOrder(orderId);
    const line = await this.prisma.ordDetail.findFirst({
      where: { id: ordDetailId, ordrId: orderId, context: 'SH' },
      select: { id: true, itemId: true },
    });
    if (!line || line.itemId == null) throw new BadRequestException(`Line ${ordDetailId} is not an item line on shipping order #${orderId}.`);
    const item = await this.prisma.item.findUnique({
      where: { id: line.itemId },
      select: { id: true, itemCode: true, lotTracked: true, unit: true },
    });
    if (!item?.lotTracked) {
      throw new BadRequestException('Staging applies to lot-traced items — enable lot tracking for the line item first.');
    }

    const parcels = await this.prisma.inventory.findMany({
      where: { itemId: line.itemId, qty: { gt: 0 }, sublotId: { not: null }, ordDetailId: null },
      select: { id: true, sublotId: true, locationId: true, qty: true, status: true },
      orderBy: { id: 'asc' },
    });
    const locIds = [...new Set(parcels.map((p) => p.locationId).filter((v): v is number => v != null))];
    const locs = locIds.length
      ? await this.prisma.location.findMany({
          where: { id: { in: locIds } },
          select: { id: true, locationCode: true, context: true, status: true, ownerId: true },
        })
      : [];
    const locById = new Map(locs.map((l) => [l.id, l]));
    // Consigned warehouse-owned locations are protected like SMP/ASM (the
    // depleters refuse them, so they must not be offered to stage either).
    const ownerIds = [...new Set(locs.map((l) => l.ownerId).filter((v): v is number => v != null))];
    const warehouseOwners = new Set(
      ownerIds.length
        ? (await this.prisma.entity.findMany({ where: { id: { in: ownerIds }, isWarehouse: true }, select: { id: true } })).map((e) => e.id)
        : [],
    );
    const eligible = parcels.filter((p) => {
      if (p.locationId == null) return true; // location-less parcels are consumable (depleter rule)
      const loc = locById.get(p.locationId);
      return (
        loc != null &&
        loc.context !== 'SMP' &&
        loc.context !== 'ASM' &&
        loc.status?.trim() !== 'DEL' &&
        !(loc.ownerId != null && warehouseOwners.has(loc.ownerId))
      );
    });
    const subIds = [...new Set(eligible.map((p) => p.sublotId!).filter((v) => v != null))];
    const subs = subIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
      : [];
    const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));

    return {
      ordDetailId,
      itemId: item.id,
      itemCode: item.itemCode,
      unit: item.unit,
      parcels: eligible.map((p) => ({
        inventoryId: p.id,
        lot: p.sublotId != null ? lotBySub.get(p.sublotId) ?? null : null,
        qty: p.qty ?? 0,
        status: p.status,
        locationId: p.locationId,
        locationCode: p.locationId != null ? locById.get(p.locationId)?.locationCode ?? null : null,
      })),
    };
  }

  /** Data for the printable assembly label: assembly, order, ship-to, contents. */
  async assemblyLabel(locationId: number) {
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, locationCode: true, context: true, status: true, reference: true, description: true },
    });
    if (!loc || loc.context !== 'ASM') throw new NotFoundException('Shipping assembly not found');

    const parcels = await this.prisma.inventory.findMany({
      where: { locationId, qty: { gt: 0 } },
      select: { id: true, itemId: true, sublotId: true, qty: true, ordDetailId: true },
    });

    // The owning order: the native Reference stamp, else via a reserved parcel.
    let orderId: number | null = loc.reference && /^\d+$/.test(loc.reference.trim()) ? Number(loc.reference.trim()) : null;
    if (orderId == null) {
      const lineIds = [...new Set(parcels.map((p) => p.ordDetailId).filter((v): v is number => v != null))];
      if (lineIds.length) {
        const line = await this.prisma.ordDetail.findFirst({ where: { id: { in: lineIds } }, select: { ordrId: true } });
        orderId = line?.ordrId ?? null;
      }
    }
    const order = orderId != null
      ? await this.prisma.ordr.findUnique({
          where: { id: orderId },
          select: { id: true, billToId: true, shipToId: true, poNumber: true, dateRequired: true, shipViaId: true },
        })
      : null;
    const parties = order ? await this.party.resolve([order.shipToId ?? order.billToId]) : new Map();
    const shipTo = order ? parties.get((order.shipToId ?? order.billToId)!) ?? null : null;
    const carrier = order?.shipViaId != null
      ? await this.prisma.entity.findUnique({ where: { id: order.shipViaId }, select: { entityCode: true } })
      : null;

    const itemIds = [...new Set(parcels.map((p) => p.itemId))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true, unit: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const subIds = [...new Set(parcels.map((p) => p.sublotId).filter((v): v is number => v != null))];
    const subs = subIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
      : [];
    const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));

    return {
      locationId: loc.id,
      locationCode: loc.locationCode,
      status: loc.status,
      orderId,
      poNumber: order?.poNumber ?? null,
      dateRequired: order?.dateRequired?.toISOString() ?? null,
      carrier: carrier?.entityCode ?? null,
      shipTo,
      contents: parcels.map((p) => ({
        itemCode: itemById.get(p.itemId)?.itemCode ?? null,
        description: itemById.get(p.itemId)?.description ?? null,
        lot: p.sublotId != null ? lotBySub.get(p.sublotId) ?? null : null,
        qty: p.qty ?? 0,
        unit: itemById.get(p.itemId)?.unit ?? null,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /**
   * Create a native shipping assembly for an open SH order: a Location
   * Context='ASM', code 'EA'+5 digits (own native namespace), parented at the
   * imported BRECEIVE rack (the legacy assembly parent), Reference = order id.
   */
  async createAssembly(orderId: number, actor: Actor) {
    await this.requireOpenShOrder(orderId);

    return this.prisma.$transaction(async (tx) => {
      // Ordr row lock first (order-scoped mutation), then the alloc lock —
      // the order-path lock order (hard convention 1c).
      await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${orderId} FOR UPDATE`;
      await this.requireOpenShOrder(orderId, tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      const locationId = await this.nextNativeId(tx, 'location');
      // Width-agnostic numeric max (NOT a fixed-width lexical MAX): after
      // EA99999 the sequence grows to EA100000 and keeps counting — a
      // 5-digit-only regex would stop seeing the max and mint duplicates
      // (2026-07-09 review). padStart is a minimum width.
      const [seq] = await tx.$queryRaw<{ n: bigint | number | null }[]>`
        SELECT MAX(CAST(SUBSTRING("LocationCode" FROM 3) AS BIGINT)) AS n FROM "Location"
        WHERE "Context" = 'ASM' AND "LocationCode" ~ '^EA[0-9]+$'`;
      const code = 'EA' + String(Number(seq?.n ?? 0) + 1).padStart(5, '0');
      // The legacy assembly parent: every one of the 17,664 imported ASM
      // locations hangs off the BRECEIVE LCN rack (the sampling precedent
      // parents there too).
      const rack = await tx.location.findFirst({
        where: { locationCode: 'BRECEIVE', context: 'LCN' },
        select: { id: true },
      });
      const owner = await this.movements.defaultOwnerId(tx);
      await tx.location.create({
        data: {
          id: locationId,
          locationCode: code,
          context: 'ASM',
          ownerId: owner || null,
          inLocationId: rack?.id ?? null,
          reference: String(orderId),
          description: `Shipping assembly — SH order #${orderId}`,
        },
      });

      await this.audit.record(
        {
          action: 'shipping.assembly.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'shipping.stage',
          summary: `Shipping assembly ${code} created for SH order #${orderId}`,
          changes: [
            { tableName: 'Location', recordId: String(locationId), fieldName: 'Context', oldValue: null, newValue: 'ASM' },
            { tableName: 'Location', recordId: String(locationId), fieldName: 'Reference', oldValue: null, newValue: String(orderId) },
          ],
        },
        tx,
      );
      return { locationId, locationCode: code };
    });
  }

  /**
   * Stage (reserve) on-hand parcels into an assembly for this order's lines:
   * split each source parcel into the assembly with `Inventory.OrdDetail` set,
   * emitting the legacy PICK movement shape (valueless US at source / MK at
   * assembly carrying the line).
   */
  async stage(orderId: number, locationId: number, dto: StageParcelsDto, actor: Actor) {
    // Service-level re-assertion (the @IsOptional/null validator trap).
    for (const p of dto.parcels) {
      if (!(p.qty > 0)) throw new BadRequestException('Stage quantities must be positive.');
    }
    const dupCheck = new Set(dto.parcels.map((p) => p.inventoryId));
    if (dupCheck.size !== dto.parcels.length) {
      throw new BadRequestException('Each source parcel may appear only once per stage call.');
    }
    await this.requireOpenShOrder(orderId);

    return this.prisma.$transaction(async (tx) => {
      // 1) Ordr row lock; re-assert open-SH under it (line edits and shipment
      //    run under this same lock).
      await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${orderId} FOR UPDATE`;
      await this.requireOpenShOrder(orderId, tx);

      // 2) Validate the target lines in-tx.
      const lineIds = [...new Set(dto.parcels.map((p) => p.ordDetailId))];
      const lines = await tx.ordDetail.findMany({
        where: { id: { in: lineIds }, ordrId: orderId, context: 'SH' },
        select: { id: true, itemId: true },
      });
      const lineById = new Map(lines.map((l) => [l.id, l]));
      for (const id of lineIds) {
        if (!lineById.has(id)) throw new BadRequestException(`Line ${id} is not a line on shipping order #${orderId}.`);
      }
      const lineItemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
      const lineItems = lineItemIds.length
        ? await tx.item.findMany({ where: { id: { in: lineItemIds } }, select: { id: true, itemCode: true, lotTracked: true } })
        : [];
      const itemById = new Map(lineItems.map((i) => [i.id, i]));
      for (const l of lines) {
        if (l.itemId == null || !itemById.get(l.itemId)?.lotTracked) {
          throw new BadRequestException(`Line ${l.id}'s item is not lot-traced — staging applies to lot-traced items.`);
        }
      }

      // 3) Alloc lock BEFORE any parcel FOR UPDATE scan (hard convention 1c).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // 4) The assembly, re-read under the alloc lock: a native ERP1 assembly
      //    created for THIS order, still live.
      const asm = await tx.location.findUnique({
        where: { id: locationId },
        select: { id: true, locationCode: true, context: true, status: true, reference: true },
      });
      if (!asm || asm.context !== 'ASM') throw new NotFoundException('Shipping assembly not found');
      if (asm.status?.trim() === 'DEL') throw new BadRequestException(`Assembly ${asm.locationCode} is closed.`);
      if (asm.reference?.trim() !== String(orderId)) {
        throw new BadRequestException(`Assembly ${asm.locationCode} does not belong to shipping order #${orderId}.`);
      }

      // 5) Source parcels: identity pre-read (identity keys are stable — every
      //    in-app parcel creator serializes on the alloc lock; quantities come
      //    from the locked scan below). Then their locations' contexts.
      const srcIds = dto.parcels.map((p) => p.inventoryId);
      const srcRows = await tx.inventory.findMany({
        where: { id: { in: srcIds } },
        select: { id: true, itemId: true, sublotId: true, locationId: true, status: true, ordDetailId: true },
      });
      const srcById = new Map(srcRows.map((r) => [r.id, r]));
      const srcLocIds = [...new Set(srcRows.map((r) => r.locationId).filter((v): v is number => v != null))];
      const srcLocs = srcLocIds.length
        ? await tx.location.findMany({ where: { id: { in: srcLocIds } }, select: { id: true, context: true, locationCode: true } })
        : [];
      const srcLocById = new Map(srcLocs.map((l) => [l.id, l]));
      for (const p of dto.parcels) {
        const src = srcById.get(p.inventoryId);
        if (!src) throw new NotFoundException(`Inventory parcel ${p.inventoryId} not found.`);
        if (src.ordDetailId != null) {
          throw new BadRequestException(`Parcel ${p.inventoryId} is already reserved to a shipping order line.`);
        }
        if (src.sublotId == null) throw new BadRequestException(`Parcel ${p.inventoryId} has no lot identity.`);
        const line = lineById.get(p.ordDetailId)!;
        if (src.itemId !== line.itemId) {
          throw new BadRequestException(
            `Parcel ${p.inventoryId} is not line ${p.ordDetailId}'s item — stage each parcel to its own item's line.`,
          );
        }
        const srcCtx = src.locationId != null ? srcLocById.get(src.locationId)?.context ?? null : null;
        if (srcCtx === 'SMP' || srcCtx === 'ASM') {
          throw new BadRequestException(`Parcel ${p.inventoryId} sits at a ${srcCtx} location — not free stock.`);
        }
      }

      // 6) Merge candidates at the assembly: same item+sublot+status parcel
      //    reserved to the SAME line (reservation is part of parcel identity —
      //    two lines' reservations never coalesce).
      const mergeKey = (itemId: number, sublotId: number, status: string | null, lineId: number) =>
        `${itemId}|${sublotId}|${status ?? ''}|${lineId}`;
      const candidates = await tx.inventory.findMany({
        where: { locationId, ordDetailId: { in: lineIds } },
        select: { id: true, itemId: true, sublotId: true, status: true, ordDetailId: true },
      });
      const destByKey = new Map<string, number>();
      for (const c of candidates) {
        if (c.sublotId != null && c.ordDetailId != null) {
          destByKey.set(mergeKey(c.itemId, c.sublotId, c.status, c.ordDetailId), c.id);
        }
      }

      // 7) ONE global ascending-id locked scan over everything this call
      //    touches (the system-wide lock order).
      const touched = [...new Set([...srcIds, ...destByKey.values()])];
      const locked = await tx.$queryRaw<{ id: number; qty: number | null }[]>`
        SELECT "Inventory" AS id, "Qty" AS qty FROM "Inventory"
        WHERE "Inventory" = ANY(${touched})
        ORDER BY "Inventory" ASC
        FOR UPDATE`;
      const qtyById = new Map(locked.map((r) => [r.id, r.qty ?? 0]));

      // 8) Apply: decrement sources, merge-or-mint reserved assembly parcels.
      const events: MovementEvent[] = [];
      const owner = await this.movements.defaultOwnerId(tx);
      const stagedSummary: string[] = [];
      const auditChanges: { tableName: string; recordId: string; fieldName: string; oldValue: string | null; newValue: string | null }[] = [];
      const subIds = [...new Set(srcRows.map((r) => r.sublotId).filter((v): v is number => v != null))];
      const subs = subIds.length
        ? await tx.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } })
        : [];
      const lotBySub = new Map(subs.map((s) => [s.id, s.lot]));

      for (const p of dto.parcels) {
        const src = srcById.get(p.inventoryId)!;
        const available = qtyById.get(p.inventoryId);
        if (available == null) throw new NotFoundException(`Inventory parcel ${p.inventoryId} not found.`);
        if (p.qty > available) {
          throw new BadRequestException(`Cannot stage ${p.qty} from parcel ${p.inventoryId} — only ${available} on hand.`);
        }
        await tx.inventory.update({ where: { id: p.inventoryId }, data: { qty: available - p.qty } });
        qtyById.set(p.inventoryId, available - p.qty);

        const key = mergeKey(src.itemId, src.sublotId!, src.status, p.ordDetailId);
        let destId = destByKey.get(key);
        if (destId != null && qtyById.has(destId)) {
          const destQty = qtyById.get(destId)!;
          await tx.inventory.update({ where: { id: destId }, data: { qty: destQty + p.qty } });
          qtyById.set(destId, destQty + p.qty);
        } else {
          destId = await this.nextNativeId(tx, 'inventory');
          await tx.inventory.create({
            data: {
              id: destId,
              itemId: src.itemId,
              sublotId: src.sublotId,
              locationId,
              qty: p.qty,
              status: src.status,
              ordDetailId: p.ordDetailId,
            },
          });
          destByKey.set(key, destId);
          qtyById.set(destId, p.qty);
        }

        // The legacy PICK shape: valueless, US at the source first, MK at the
        // assembly second, the MK leg carrying the reserved line.
        events.push({
          context: 'PICK',
          changeSetId: 0, // patched below once the change set exists
          itemId: src.itemId,
          sublotId: src.sublotId,
          legs: [
            { context: 'US', ownerId: owner, locationId: src.locationId, qty: -p.qty, value: null },
            { context: 'MK', ownerId: owner, locationId, ordDetailId: p.ordDetailId, qty: p.qty, value: null },
          ],
        });
        const lot = src.sublotId != null ? lotBySub.get(src.sublotId) ?? null : null;
        stagedSummary.push(`${lot ?? `parcel ${p.inventoryId}`} × ${p.qty} → line ${p.ordDetailId}`);
        auditChanges.push({
          tableName: 'Inventory',
          recordId: String(destId),
          fieldName: 'OrdDetail',
          oldValue: null,
          newValue: String(p.ordDetailId),
        });
      }

      // 9) One native PICK change set per stage event (ERP1's per-event
      //    convention; legacy shared one per day — deviation documented).
      const csId = await this.nextNativeId(tx, 'changeSet');
      await tx.changeSet.create({ data: { id: csId, context: 'PICK', ordrId: orderId, changeDate: new Date() } });
      for (const ev of events) ev.changeSetId = csId;
      await this.movements.record(tx, events);

      await this.audit.record(
        {
          action: 'shipping.stage',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'shipping.stage',
          summary: `SH order #${orderId}: staged ${dto.parcels.length} parcel${dto.parcels.length === 1 ? '' : 's'} into assembly ${asm.locationCode} — ${stagedSummary.join('; ')}`,
          changes: auditChanges,
        },
        tx,
      );
      return { orderId, locationId, locationCode: asm.locationCode, staged: dto.parcels.length, changeSetId: csId };
    });
  }

  /**
   * Unstage (release) reserved assembly parcels back to free stock: move the
   * quantity to the destination (default: the receiving dock / default stock
   * location), clearing the reservation. Mirrors the legacy unpick PICK shape
   * (US +qty at the destination / MK −qty at the assembly). Allowed in any
   * order state — freeing staged stock must never be blocked.
   */
  async unstage(orderId: number, dto: UnstageParcelsDto, actor: Actor) {
    for (const p of dto.parcels) {
      if (!(p.qty > 0)) throw new BadRequestException('Unstage quantities must be positive.');
    }
    const dupCheck = new Set(dto.parcels.map((p) => p.inventoryId));
    if (dupCheck.size !== dto.parcels.length) {
      throw new BadRequestException('Each parcel may appear only once per unstage call.');
    }
    const order = await this.prisma.ordr.findUnique({ where: { id: orderId }, select: { id: true, context: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') throw new BadRequestException('Only shipping (SH) orders stage assemblies.');

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${orderId} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // Parcels must be reserved to THIS order's lines and sit at an ASM location.
      const rows = await tx.inventory.findMany({
        where: { id: { in: dto.parcels.map((p) => p.inventoryId) } },
        select: { id: true, itemId: true, sublotId: true, locationId: true, status: true, ordDetailId: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const lineIds = [...new Set(rows.map((r) => r.ordDetailId).filter((v): v is number => v != null))];
      const lines = lineIds.length
        ? await tx.ordDetail.findMany({ where: { id: { in: lineIds } }, select: { id: true, ordrId: true } })
        : [];
      const lineById = new Map(lines.map((l) => [l.id, l]));
      const asmLocIds = [...new Set(rows.map((r) => r.locationId).filter((v): v is number => v != null))];
      const asmLocs = asmLocIds.length
        ? await tx.location.findMany({ where: { id: { in: asmLocIds } }, select: { id: true, context: true, locationCode: true } })
        : [];
      const asmLocById = new Map(asmLocs.map((l) => [l.id, l]));
      // Import-safety (mirrors stage()'s lot-traced restriction): an IMPORTED
      // reservation — legacy-range parcel of a non-lot-tracked item — is
      // sync-owned; the Inventory re-copy would resurrect it after a native
      // unstage, double-counting the stock. Those are released in the legacy
      // Shipping Assembly program during parallel running (2026-07-09 review).
      const rowItems = await tx.item.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } },
        select: { id: true, lotTracked: true },
      });
      const rowItemById = new Map(rowItems.map((i) => [i.id, i]));
      for (const p of dto.parcels) {
        const row = byId.get(p.inventoryId);
        if (!row) throw new NotFoundException(`Inventory parcel ${p.inventoryId} not found.`);
        if (row.ordDetailId == null) throw new BadRequestException(`Parcel ${p.inventoryId} is not reserved.`);
        const line = lineById.get(row.ordDetailId);
        if (!line || line.ordrId !== orderId) {
          throw new BadRequestException(`Parcel ${p.inventoryId} is not reserved to shipping order #${orderId}.`);
        }
        const ctx = row.locationId != null ? asmLocById.get(row.locationId)?.context ?? null : null;
        if (ctx !== 'ASM') throw new BadRequestException(`Parcel ${p.inventoryId} is not at a shipping-assembly location.`);
        if (p.inventoryId < NATIVE_ID_BASE || !rowItemById.get(row.itemId)?.lotTracked) {
          throw new BadRequestException(
            `Parcel ${p.inventoryId} is a legacy-staged reservation mirrored by sync — release it in the legacy Shipping Assembly program; a native unstage would be undone by the next sync.`,
          );
        }
      }

      // Destination: operator's choice, else the receiving dock (where
      // unpicked goods physically land), else the install default location.
      let destLocId = dto.toLocationId ?? null;
      if (destLocId != null) {
        const dest = await tx.location.findUnique({ where: { id: destLocId }, select: { id: true, context: true } });
        if (!dest) throw new NotFoundException('Destination location not found');
        if (dest.context === 'SMP' || dest.context === 'ASM') {
          throw new BadRequestException('Unstage to a stock location — not a sample or assembly location.');
        }
      } else {
        destLocId = await this.valuation.resolveLocationId(tx, 'inventory.receivingLocation');
        if (destLocId == null) throw new BadRequestException('No destination location available — pass toLocationId.');
      }

      // Merge candidates at the destination: unreserved same-identity parcels.
      const mergeKey = (itemId: number, sublotId: number, status: string | null) => `${itemId}|${sublotId}|${status ?? ''}`;
      const candidates = await tx.inventory.findMany({
        where: {
          locationId: destLocId,
          ordDetailId: null,
          itemId: { in: [...new Set(rows.map((r) => r.itemId))] },
        },
        select: { id: true, itemId: true, sublotId: true, status: true },
      });
      const destByKey = new Map<string, number>();
      for (const c of candidates) {
        if (c.sublotId != null) destByKey.set(mergeKey(c.itemId, c.sublotId, c.status), c.id);
      }

      const touched = [...new Set([...dto.parcels.map((p) => p.inventoryId), ...destByKey.values()])];
      const locked = await tx.$queryRaw<{ id: number; qty: number | null }[]>`
        SELECT "Inventory" AS id, "Qty" AS qty FROM "Inventory"
        WHERE "Inventory" = ANY(${touched})
        ORDER BY "Inventory" ASC
        FOR UPDATE`;
      const qtyById = new Map(locked.map((r) => [r.id, r.qty ?? 0]));

      const events: MovementEvent[] = [];
      const owner = await this.movements.defaultOwnerId(tx);
      const summary: string[] = [];
      const auditChanges: { tableName: string; recordId: string; fieldName: string; oldValue: string | null; newValue: string | null }[] = [];
      for (const p of dto.parcels) {
        const row = byId.get(p.inventoryId)!;
        const available = qtyById.get(p.inventoryId);
        if (available == null) throw new NotFoundException(`Inventory parcel ${p.inventoryId} not found.`);
        if (p.qty > available) {
          throw new BadRequestException(`Cannot unstage ${p.qty} from parcel ${p.inventoryId} — only ${available} staged.`);
        }
        await tx.inventory.update({ where: { id: p.inventoryId }, data: { qty: available - p.qty } });
        qtyById.set(p.inventoryId, available - p.qty);
        auditChanges.push({
          tableName: 'Inventory', recordId: String(p.inventoryId), fieldName: 'qty',
          oldValue: String(available), newValue: String(available - p.qty),
        });

        const key = mergeKey(row.itemId, row.sublotId!, row.status);
        let destId = destByKey.get(key);
        if (destId != null && qtyById.has(destId)) {
          const destQty = qtyById.get(destId)!;
          await tx.inventory.update({ where: { id: destId }, data: { qty: destQty + p.qty } });
          qtyById.set(destId, destQty + p.qty);
          auditChanges.push({
            tableName: 'Inventory', recordId: String(destId), fieldName: 'qty',
            oldValue: String(destQty), newValue: String(destQty + p.qty),
          });
        } else {
          destId = await this.nextNativeId(tx, 'inventory');
          await tx.inventory.create({
            data: { id: destId, itemId: row.itemId, sublotId: row.sublotId, locationId: destLocId, qty: p.qty, status: row.status, ordDetailId: null },
          });
          destByKey.set(key, destId);
          qtyById.set(destId, p.qty);
          auditChanges.push({
            tableName: 'Inventory', recordId: String(destId), fieldName: 'location',
            oldValue: null, newValue: String(destLocId),
          });
        }

        // The legacy unpick shape: US +qty at the destination first, MK −qty
        // at the assembly (still line-stamped) second.
        events.push({
          context: 'PICK',
          changeSetId: 0,
          itemId: row.itemId,
          sublotId: row.sublotId,
          legs: [
            { context: 'US', ownerId: owner, locationId: destLocId, qty: p.qty, value: null },
            { context: 'MK', ownerId: owner, locationId: row.locationId, ordDetailId: row.ordDetailId, qty: -p.qty, value: null },
          ],
        });
        summary.push(`parcel ${p.inventoryId} × ${p.qty}`);
      }

      const csId = await this.nextNativeId(tx, 'changeSet');
      await tx.changeSet.create({ data: { id: csId, context: 'PICK', ordrId: orderId, changeDate: new Date() } });
      for (const ev of events) ev.changeSetId = csId;
      await this.movements.record(tx, events);

      await this.audit.record(
        {
          action: 'shipping.unstage',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'shipping.stage',
          summary: `SH order #${orderId}: unstaged ${dto.parcels.length} parcel${dto.parcels.length === 1 ? '' : 's'} back to stock — ${summary.join('; ')}`,
          // The rows record the writes that actually happen: qty moves off the
          // (still-reserved) assembly parcel into an unreserved destination
          // parcel — a partial unstage never clears the source's OrdDetail.
          changes: auditChanges,
        },
        tx,
      );
      return { orderId, unstaged: dto.parcels.length, toLocationId: destLocId, changeSetId: csId };
    });
  }
}
