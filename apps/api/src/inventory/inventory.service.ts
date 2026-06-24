import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import type { AdjustInventoryDto } from './dto/adjust-inventory.dto';

// Legacy ChangeSet context for a stock count/adjustment (verified: 1,491 'COUNT'
// change sets in the live data). The quantity change itself lands directly on the
// Inventory parcel — ERP1 tracks on-hand as Inventory rows, not InvMovement (the
// same model native receiving uses).
const ADJUST_CONTEXT = 'COUNT';

interface InventoryRow {
  id: number;
  itemId: number;
  locationId: number;
  sublotId: number | null;
  status: string | null;
  qty: number | null;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Adjust an on-hand inventory parcel to a new absolute quantity (a count /
   * correction — write-on or write-off), with a required reason. Records a
   * `ChangeSet` Context='COUNT' header (native id) as the adjustment event and
   * sets `Inventory.qty`; atomic, audited (the before→after quantity + reason). A
   * no-op (same quantity) short-circuits without a transaction or change set.
   */
  async adjust(dto: AdjustInventoryDto, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to adjust inventory.');
    if (dto.newQty < 0) throw new BadRequestException('The adjusted quantity cannot be negative.');

    const parcel = await this.prisma.inventory.findUnique({
      where: { id: dto.inventoryId },
      select: { id: true, itemId: true, sublotId: true, locationId: true },
    });
    if (!parcel) throw new NotFoundException('Inventory parcel not found');

    // Decoration for a readable audit summary (item / lot / location) — reference
    // data, resolved outside the transaction.
    const [item, sublot, location] = await Promise.all([
      parcel.itemId != null ? this.prisma.item.findUnique({ where: { id: parcel.itemId }, select: { itemCode: true } }) : Promise.resolve(null),
      parcel.sublotId != null ? this.prisma.sublot.findUnique({ where: { id: parcel.sublotId }, select: { lot: true } }) : Promise.resolve(null),
      parcel.locationId != null ? this.prisma.location.findUnique({ where: { id: parcel.locationId }, select: { locationCode: true } }) : Promise.resolve(null),
    ]);
    const reason = dto.reason.trim();
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Read the current qty under the serialization lock so the recorded delta /
      // before-value and the no-op check reflect any concurrent adjust that just
      // committed (the lock makes adjusts mutually exclusive). The parcel can't be
      // deleted in this app, but guard defensively.
      const cur = await tx.inventory.findUnique({ where: { id: parcel.id }, select: { qty: true } });
      if (!cur) throw new NotFoundException('Inventory parcel not found');
      const oldQty = cur.qty ?? 0;
      const delta = dto.newQty - oldQty;
      if (delta === 0) return { inventoryId: parcel.id, oldQty, newQty: dto.newQty, delta: 0, unchanged: true };

      const csId = ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: ADJUST_CONTEXT, changeDate: at } });
      await tx.inventory.update({ where: { id: parcel.id }, data: { qty: dto.newQty } });
      await this.audit.record(
        {
          action: 'inventory.adjust',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.adjust',
          summary:
            `Inventory adjusted${item?.itemCode ? ` — ${item.itemCode}` : ''}${sublot?.lot ? ` lot ${sublot.lot}` : ''}` +
            `${location?.locationCode ? ` @ ${location.locationCode}` : ''}: ${oldQty} → ${dto.newQty} (${delta > 0 ? '+' : ''}${delta}) — ${reason}`,
          changes: [
            { tableName: 'Inventory', recordId: String(parcel.id), fieldName: 'qty', oldValue: String(oldQty), newValue: String(dto.newQty) },
            { tableName: 'ChangeSet', recordId: String(csId), fieldName: 'Context', oldValue: null, newValue: ADJUST_CONTEXT },
          ],
        },
        tx,
      );
      return { inventoryId: parcel.id, oldQty, newQty: dto.newQty, delta, changeSetId: csId };
    });
  }

  /** Current on-hand stock (Inventory joined to item/location/sublot/lot). */
  async list(query: ListQuery & { status?: string; item?: string; onHand?: string }) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['qty', 'status'],
      defaultSort: { id: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.onHand === '1') where.qty = { gt: 0 };
    if (query.item) {
      const item = await this.prisma.item.findUnique({ where: { itemCode: query.item }, select: { id: true } });
      where.itemId = item?.id ?? -1;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventory.findMany({ where, skip, take, orderBy }),
      this.prisma.inventory.count({ where }),
    ]);
    return { rows: await this.decorate(rows), total, page, pageSize };
  }

  // Genealogy/trace/recall moved to GenealogyService (lot-level, traversing the
  // derived lot_genealogy graph — SublotParent is empty in this install).

  // --- joins / decoration --------------------------------------------------

  private async decorate(rows: InventoryRow[]) {
    const itemIds = [...new Set(rows.map((r) => r.itemId).filter((v) => v != null))];
    const locIds = [...new Set(rows.map((r) => r.locationId).filter((v) => v != null))];
    const subIds = [...new Set(rows.map((r) => r.sublotId).filter((v): v is number => v != null))];

    const [items, locs, subs] = await Promise.all([
      this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }),
      this.prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true, locationCode: true } }),
      this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, sublotCode: true, lot: true } }),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const locById = new Map(locs.map((l) => [l.id, l]));
    const subById = new Map(subs.map((s) => [s.id, s]));

    return rows.map((r) => ({
      id: r.id,
      qty: r.qty,
      status: r.status,
      itemCode: itemById.get(r.itemId)?.itemCode ?? null,
      itemDescription: itemById.get(r.itemId)?.description ?? null,
      locationCode: r.locationId != null ? (locById.get(r.locationId)?.locationCode ?? null) : null,
      sublotCode: r.sublotId != null ? (subById.get(r.sublotId)?.sublotCode ?? null) : null,
      lot: r.sublotId != null ? (subById.get(r.sublotId)?.lot ?? null) : null,
    }));
  }
}
