import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { MovementRecorderService } from './movement-recorder.service';
import type { CreateInventoryCountDto, EnterCountsDto } from './dto/inventory-count.dto';

const COUNT_CONTEXT = 'COUNT';

/**
 * Inventory count sheets (UG §4 cycle/physical count). A count snapshots the
 * on-hand PARCELS matching a scope (a location, optionally one item / status)
 * into a draft worksheet; the operator enters a counted quantity per parcel;
 * posting applies every parcel's adjustment through the SHARED per-parcel core
 * (`InventoryService.setParcelQtyInTx`) under ONE Context='COUNT' ChangeSet — the
 * 1:1 header↔ChangeSet relationship the legacy data shows (1,499 posted headers ↔
 * 1,499 distinct COUNT change sets). Legacy counted at item+location aggregate
 * (Sublot NULL on all 21,053 rows); ERP1 counts per-parcel (its lot-traced grain,
 * a documented refinement) so each line adjusts the exact on-hand parcel. Native
 * ids ≥ NATIVE_ID_BASE; every mutation atomically audited.
 */
@Injectable()
export class InventoryCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly movements: MovementRecorderService,
  ) {}

  // --- create --------------------------------------------------------------

  /** Snapshot the parcels matching the scope into a new draft count. */
  async createCount(dto: CreateInventoryCountDto, actor: Actor) {
    const location = await this.prisma.location.findUnique({ where: { id: dto.locationId }, select: { id: true, locationCode: true, context: true } });
    if (!location) throw new NotFoundException('Location not found');
    if (location.context === 'SMP' || location.context === 'ASM') {
      throw new BadRequestException('Sample (SMP) and assembly (ASM) locations are managed by their own flows, not by counting.');
    }
    if (dto.itemId != null) {
      const item = await this.prisma.item.findUnique({ where: { id: dto.itemId }, select: { id: true } });
      if (!item) throw new BadRequestException(`Unknown item id ${dto.itemId}`);
    }

    // The countable parcels: on-hand (qty > 0) at the location, not reserved to a
    // shipping order (those move through staging), narrowed by item / status.
    const parcels = await this.prisma.inventory.findMany({
      where: {
        locationId: dto.locationId,
        ordDetailId: null,
        qty: { gt: 0 },
        ...(dto.itemId != null ? { itemId: dto.itemId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      select: { id: true, itemId: true, sublotId: true, locationId: true },
      orderBy: { id: 'asc' },
    });

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const headerId = ((await tx.inventoryCount.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      let detailId = ((await tx.inventoryCountDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE);
      const ownerId = await this.movements.defaultOwnerId(tx);
      await tx.inventoryCount.create({
        data: { id: headerId, ownerId, description: dto.description ?? null, effectiveDate: new Date(), posted: false },
      });
      if (parcels.length) {
        await tx.inventoryCountDetail.createMany({
          data: parcels.map((p) => ({
            id: ++detailId,
            inventoryCountId: headerId,
            itemId: p.itemId,
            sublotId: p.sublotId,
            locationId: p.locationId,
            inventoryId: p.id,
          })),
        });
      }
      await this.audit.record(
        {
          action: 'inventory.count.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.count',
          summary: `Inventory count #${headerId} created @ ${location.locationCode ?? location.id} (${parcels.length} parcels)`,
          changes: [{ tableName: 'InventoryCount', recordId: String(headerId), fieldName: 'Location', oldValue: null, newValue: String(dto.locationId) }],
        },
        tx,
      );
      return { id: headerId, parcels: parcels.length };
    });
  }

  // --- pickers -------------------------------------------------------------

  /** Location picker for the create form (excludes SMP/ASM — not plain-countable). */
  async locationOptions(q?: string) {
    const term = q?.trim();
    const where: Record<string, unknown> = { NOT: { context: { in: ['SMP', 'ASM'] } } };
    if (term) where.locationCode = { contains: term, mode: 'insensitive' };
    const rows = await this.prisma.location.findMany({ where, take: 25, orderBy: { locationCode: 'asc' }, select: { id: true, locationCode: true, context: true } });
    return { rows: rows.map((r) => ({ id: r.id, code: r.locationCode, context: r.context })) };
  }

  /** Item picker for narrowing a count to one item. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    const where = term
      ? { OR: [{ itemCode: { contains: term, mode: 'insensitive' as const } }, { description: { contains: term, mode: 'insensitive' as const } }] }
      : {};
    const rows = await this.prisma.item.findMany({ where, take: 25, orderBy: { itemCode: 'asc' }, select: { id: true, itemCode: true, description: true } });
    return { rows };
  }

  // --- reads ---------------------------------------------------------------

  async list(query: ListQuery & { posted?: string }) {
    const { skip, take, page, pageSize } = buildList(query, { sortable: ['id'], defaultSort: { id: 'desc' } });
    const where: Record<string, unknown> = {};
    if (query.posted === '1') where.posted = true;
    else if (query.posted === '0') where.posted = false;
    const [headers, total] = await this.prisma.$transaction([
      this.prisma.inventoryCount.findMany({ where, skip, take, orderBy: { id: 'desc' } }),
      this.prisma.inventoryCount.count({ where }),
    ]);
    const rows = await Promise.all(
      headers.map(async (h) => ({
        id: h.id,
        description: h.description,
        effectiveDate: h.effectiveDate,
        posted: h.posted,
        changeSetId: h.changeSetId,
        lines: await this.prisma.inventoryCountDetail.count({ where: { inventoryCountId: h.id } }),
      })),
    );
    return { rows, total, page, pageSize };
  }

  /** A count with its lines decorated with book vs counted + the computed adjust.
   * Draft book = the live parcel qty; posted book = counted − stored adjust. */
  async get(id: number) {
    const header = await this.prisma.inventoryCount.findUnique({ where: { id } });
    if (!header) throw new NotFoundException('Inventory count not found');
    const details = await this.prisma.inventoryCountDetail.findMany({ where: { inventoryCountId: id }, orderBy: { id: 'asc' } });

    const parcelIds = [...new Set(details.map((d) => d.inventoryId).filter((v): v is number => v != null))];
    const liveParcels = !header.posted && parcelIds.length
      ? await this.prisma.inventory.findMany({ where: { id: { in: parcelIds } }, select: { id: true, qty: true } })
      : [];
    const liveQty = new Map(liveParcels.map((p) => [p.id, p.qty ?? 0]));

    const itemIds = [...new Set(details.map((d) => d.itemId))];
    const sublotIds = [...new Set(details.map((d) => d.sublotId).filter((v): v is number => v != null))];
    const locationIds = [...new Set(details.map((d) => d.locationId))];
    const [items, sublots, locations] = await Promise.all([
      itemIds.length ? this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true, unit: true } }) : [],
      sublotIds.length ? this.prisma.sublot.findMany({ where: { id: { in: sublotIds } }, select: { id: true, lot: true } }) : [],
      locationIds.length ? this.prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, locationCode: true } }) : [],
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const lotById = new Map(sublots.map((s) => [s.id, s.lot]));
    const locById = new Map(locations.map((l) => [l.id, l.locationCode]));

    const lines = details.map((d) => {
      const counted = d.qty;
      // Posted line: book = counted − stored adjust. A line snapshotted but never
      // counted (qty null) stays uncounted — blank book/adjust, not a false zero.
      // Draft line: book = the live parcel qty; adjust previews counted − book.
      const book = header.posted
        ? counted != null ? counted - (d.qtyAdjust ?? 0) : null
        : d.inventoryId != null ? liveQty.get(d.inventoryId) ?? 0 : 0;
      const adjust = header.posted ? d.qtyAdjust : counted != null && book != null ? counted - book : null;
      const item = itemById.get(d.itemId);
      return {
        id: d.id,
        inventoryId: d.inventoryId,
        itemId: d.itemId,
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? null,
        unit: item?.unit ?? null,
        lot: d.sublotId != null ? lotById.get(d.sublotId) ?? null : null,
        locationCode: locById.get(d.locationId) ?? null,
        book,
        counted,
        qtyEntered: d.qtyEntered,
        adjust,
      };
    });
    return {
      id: header.id,
      description: header.description,
      effectiveDate: header.effectiveDate,
      posted: header.posted,
      changeSetId: header.changeSetId,
      lines,
    };
  }

  // --- enter (draft) -------------------------------------------------------

  /** Set counted quantities on a draft count (bulk). Only unposted counts accept
   * edits; the adjust preview is computed at read time against the live book. */
  async enterCounts(id: number, dto: EnterCountsDto, actor: Actor) {
    const header = await this.prisma.inventoryCount.findUnique({ where: { id }, select: { id: true, posted: true } });
    if (!header) throw new NotFoundException('Inventory count not found');
    if (header.posted) throw new BadRequestException('This count is already posted and can no longer be edited.');
    if (!dto.counts.length) return { id, updated: 0 };

    const ids = dto.counts.map((c) => c.detailId);
    const owned = await this.prisma.inventoryCountDetail.findMany({ where: { id: { in: ids }, inventoryCountId: id }, select: { id: true } });
    const ownedIds = new Set(owned.map((d) => d.id));
    const stray = ids.find((x) => !ownedIds.has(x));
    if (stray != null) throw new BadRequestException(`Count line ${stray} is not part of this count.`);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-assert unposted under the lock so a concurrent postCount (which also
      // takes it) can't have flipped the count to posted between the check above
      // and this write — overwriting a posted count corrupts its book/adjust
      // reconstruction.
      const cur = await tx.inventoryCount.findUnique({ where: { id }, select: { posted: true } });
      if (!cur) throw new NotFoundException('Inventory count not found');
      if (cur.posted) throw new BadRequestException('This count is already posted and can no longer be edited.');
      for (const c of dto.counts) {
        const counted = c.countedQty ?? null;
        await tx.inventoryCountDetail.update({
          where: { id: c.detailId },
          data: { qty: counted, qtyEntered: counted != null ? String(counted) : null },
        });
      }
      await this.audit.record(
        {
          action: 'inventory.count.enter',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.count',
          summary: `Inventory count #${id}: ${dto.counts.length} counted quantities entered`,
        },
        tx,
      );
      return { id, updated: dto.counts.length };
    });
  }

  // --- post ----------------------------------------------------------------

  /** Post a draft count: apply every counted line's adjustment through the shared
   * per-parcel core under ONE COUNT ChangeSet, store each line's actual adjust,
   * mark the header posted + linked. Atomic; the whole post fails if any parcel is
   * no longer adjustable (e.g. became reserved). */
  async postCount(id: number, actor: Actor) {
    const header = await this.prisma.inventoryCount.findUnique({ where: { id }, select: { id: true, posted: true } });
    if (!header) throw new NotFoundException('Inventory count not found');
    if (header.posted) throw new BadRequestException('This count is already posted.');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-assert unposted under the lock so two concurrent posts enact once.
      const cur = await tx.inventoryCount.findUnique({ where: { id }, select: { posted: true } });
      if (!cur) throw new NotFoundException('Inventory count not found');
      if (cur.posted) throw new BadRequestException('This count is already posted.');

      const counted = await tx.inventoryCountDetail.findMany({
        where: { inventoryCountId: id, qty: { not: null }, inventoryId: { not: null } },
        orderBy: { id: 'asc' },
      });
      if (!counted.length) throw new BadRequestException('Enter at least one counted quantity before posting.');

      const csId = ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: COUNT_CONTEXT, changeDate: new Date() } });

      const changes: Array<{ tableName: string; recordId: string; fieldName: string; oldValue: string | null; newValue: string | null }> = [];
      let adjusted = 0;
      for (const d of counted) {
        const r = await this.inventory.setParcelQtyInTx(tx, { parcelId: d.inventoryId!, newQty: d.qty!, changeSetId: csId, at: new Date() });
        await tx.inventoryCountDetail.update({ where: { id: d.id }, data: { qtyAdjust: r.delta } });
        if (!r.skipped) {
          adjusted += 1;
          changes.push({ tableName: 'Inventory', recordId: String(d.inventoryId), fieldName: 'qty', oldValue: String(r.oldQty), newValue: String(r.newQty) });
        }
      }
      await tx.inventoryCount.update({ where: { id }, data: { posted: true, changeSetId: csId } });

      changes.push({ tableName: 'InventoryCount', recordId: String(id), fieldName: 'Posted', oldValue: 'false', newValue: 'true' });
      changes.push({ tableName: 'ChangeSet', recordId: String(csId), fieldName: 'Context', oldValue: null, newValue: COUNT_CONTEXT });
      await this.audit.record(
        {
          action: 'inventory.count.post',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.count',
          summary: `Inventory count #${id} posted — ${adjusted} parcel(s) adjusted (of ${counted.length} counted) under COUNT change set #${csId}`,
          changes,
        },
        tx,
      );
      return { id, changeSetId: csId, counted: counted.length, adjusted };
    });
  }

  // --- delete (draft) ------------------------------------------------------

  /** Delete a draft count (+ its lines). Posted counts are immutable. */
  async deleteCount(id: number, actor: Actor) {
    const header = await this.prisma.inventoryCount.findUnique({ where: { id }, select: { id: true, posted: true } });
    if (!header) throw new NotFoundException('Inventory count not found');
    if (header.posted) throw new BadRequestException('A posted count cannot be deleted.');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-assert unposted under the lock so a concurrent postCount can't slip in
      // between the check above and the delete — deleting a just-posted count
      // would orphan its COUNT ChangeSet + the adjustments it applied.
      const cur = await tx.inventoryCount.findUnique({ where: { id }, select: { posted: true } });
      if (!cur) throw new NotFoundException('Inventory count not found');
      if (cur.posted) throw new BadRequestException('A posted count cannot be deleted.');
      await tx.inventoryCountDetail.deleteMany({ where: { inventoryCountId: id } });
      await tx.inventoryCount.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'inventory.count.delete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.count',
          summary: `Draft inventory count #${id} deleted`,
        },
        tx,
      );
      return { id, deleted: true };
    });
  }
}
