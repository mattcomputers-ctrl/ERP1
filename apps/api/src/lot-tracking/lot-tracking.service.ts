import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { maxRawLotNumber } from '../common/lot-numbers';
import { PrismaService } from '../prisma/prisma.service';
import type { EnableLotTrackingDto } from './dto/enable-lot-tracking.dto';

@Injectable()
export class LotTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

      // Wipe the item's prior (legacy / non-lot) on-hand; the entered lots become
      // the on-hand of record.
      await tx.inventory.deleteMany({ where: { itemId } });

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

      const created: { lot: string; vendorLot: string | null; qty: number; unitCost: number | null; locationId: number; raw: boolean }[] = [];
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
          created.push({ lot: lotNumber, vendorLot: e.vendorLot?.trim() ?? null, qty: e.qty, unitCost, locationId: g.locationId, raw });
        }
      }

      await tx.item.update({ where: { id: itemId }, data: { lotTracked: true } });

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
