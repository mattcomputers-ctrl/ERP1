import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import type { ReverseReceiptDto } from './dto/reverse-receipt.dto';
import type { TransferInventoryDto } from './dto/transfer-inventory.dto';

// Legacy ChangeSet context for a stock count/adjustment (verified: 1,491 'COUNT'
// change sets in the live data). The quantity change itself lands directly on the
// Inventory parcel — ERP1 tracks on-hand as Inventory rows, not InvMovement (the
// same model native receiving uses).
const ADJUST_CONTEXT = 'COUNT';

// Legacy ChangeSet context for a stock transfer between locations (verified: 181
// 'TRNSFR' change sets). Like COUNT, the movement lands directly on the Inventory
// parcels (no InvMovement detail in ERP1).
const TRANSFER_CONTEXT = 'TRNSFR';

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
    private readonly notifications: NotificationEngineService,
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
      parcel.itemId != null
        ? this.prisma.item.findUnique({
            where: { id: parcel.itemId },
            select: { itemCode: true, description: true, unit: true, securityGroup: true, ownerId: true },
          })
        : Promise.resolve(null),
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

      // UG §22.2.1 'Reweigh Outside Threshold': an adjustment beyond the
      // configured percentage of the original quantity (legacy
      // ParamsInventory.ReweighThreshold; ERP1 inventory.reweighThreshold,
      // seeded with this plant's live value 5%). Only computable against a
      // positive original quantity; 0 disables.
      const thresholdRaw = (await tx.appSetting.findUnique({ where: { key: 'inventory.reweighThreshold' } }))?.value;
      const threshold = Number(thresholdRaw ?? '5');
      if (Number.isFinite(threshold) && threshold > 0 && oldQty > 0) {
        const maxVariance = (oldQty * threshold) / 100;
        if (Math.abs(delta) > maxVariance) {
          const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
          await this.notifications.emit(tx, 'Reweigh Outside Threshold', {
            securityGroup: item?.securityGroup,
            ownerId: item?.ownerId,
            params: {
              Container: parcel.id,
              Adjustment: r6(delta),
              ReweighThreshold: threshold,
              MaxVariance: r6(maxVariance),
              OriginalQty: oldQty,
              Unit: item?.unit,
              ItemCode: item?.itemCode,
              Description: item?.description,
              Lot: sublot?.lot,
            },
            links: sublot?.lot ? { Lot: `/lot-tracking?focus=${encodeURIComponent(sublot.lot)}` } : undefined,
          });
        }
      }

      return { inventoryId: parcel.id, oldQty, newQty: dto.newQty, delta, changeSetId: csId };
    });
  }

  /**
   * Move a quantity of an on-hand parcel to another location. The moved quantity
   * is deducted from the source parcel and merged into an existing same-item +
   * same-lot parcel at the destination (or a new parcel is minted there, native
   * id). Records a `ChangeSet` Context='TRNSFR' header; atomic + audited. The
   * source quantity is re-read under the id-allocation lock so a concurrent
   * adjust/transfer can't let more leave than is on hand.
   */
  async transfer(dto: TransferInventoryDto, actor: Actor) {
    if (!(dto.qty > 0)) throw new BadRequestException('Transfer quantity must be positive.');

    const src = await this.prisma.inventory.findUnique({
      where: { id: dto.inventoryId },
      select: { id: true, itemId: true, sublotId: true, locationId: true, status: true },
    });
    if (!src) throw new NotFoundException('Inventory parcel not found');
    if (src.locationId === dto.toLocationId) throw new BadRequestException('The destination must be a different location.');

    const toLocation = await this.prisma.location.findUnique({ where: { id: dto.toLocationId }, select: { id: true, locationCode: true } });
    if (!toLocation) throw new NotFoundException('Destination location not found');

    // Decoration for the audit summary (item / lot / from-location).
    const [item, sublot, fromLocation] = await Promise.all([
      src.itemId != null ? this.prisma.item.findUnique({ where: { id: src.itemId }, select: { itemCode: true } }) : Promise.resolve(null),
      src.sublotId != null ? this.prisma.sublot.findUnique({ where: { id: src.sublotId }, select: { lot: true } }) : Promise.resolve(null),
      src.locationId != null ? this.prisma.location.findUnique({ where: { id: src.locationId }, select: { locationCode: true } }) : Promise.resolve(null),
    ]);
    const reason = dto.reason?.trim() || null;
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // Identify the destination merge candidate BEFORE locking: a same-item +
      // same-lot + same-STATUS parcel at the destination (status is part of
      // the match so released stock never silently coalesces into a hold/
      // quarantine parcel, or vice-versa). Parcel identity keys never change
      // and every IN-APP parcel creator serializes on the advisory lock held
      // above, so the candidate set is stable; only QUANTITIES move
      // concurrently, and those are read from the locked scan below. (The
      // legacy-import mirror writer is the one exception — the qtyById guard
      // below degrades that race to minting a separate parcel, exactly the
      // pre-alignment behavior.)
      const existing = await tx.inventory.findFirst({
        where: { itemId: src.itemId, sublotId: src.sublotId, locationId: dto.toLocationId, status: src.status },
        select: { id: true },
      });

      // ONE ascending-id locked scan over every parcel this transfer touches —
      // the system-wide lock order (see ValuationService.depleteSpecificMany).
      // Depleters don't take the advisory lock, so this both prevents a
      // source-then-destination lock inversion against their single ascending
      // scans AND makes the quantity reads race-free (the previous unlocked
      // read-modify-write could overwrite a concurrent depletion).
      const ids = existing ? [src.id, existing.id] : [src.id];
      const locked = await tx.$queryRaw<{ id: number; qty: number | null }[]>`
        SELECT "Inventory" AS id, "Qty" AS qty FROM "Inventory"
        WHERE "Inventory" = ANY(${ids})
        ORDER BY "Inventory" ASC
        FOR UPDATE`;
      const qtyById = new Map(locked.map((r) => [r.id, r.qty ?? 0]));
      if (!qtyById.has(src.id)) throw new NotFoundException('Inventory parcel not found');
      const sourceQty = qtyById.get(src.id)!;
      if (dto.qty > sourceQty) throw new BadRequestException(`Cannot transfer ${dto.qty} — only ${sourceQty} on hand.`);

      await tx.inventory.update({ where: { id: src.id }, data: { qty: sourceQty - dto.qty } });

      let targetInventoryId: number;
      if (existing && qtyById.has(existing.id)) {
        await tx.inventory.update({ where: { id: existing.id }, data: { qty: qtyById.get(existing.id)! + dto.qty } });
        targetInventoryId = existing.id;
      } else {
        targetInventoryId = ((await tx.inventory.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
        await tx.inventory.create({
          data: { id: targetInventoryId, itemId: src.itemId, sublotId: src.sublotId, locationId: dto.toLocationId, qty: dto.qty, status: src.status },
        });
      }

      const csId = ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: TRANSFER_CONTEXT, changeDate: at } });

      await this.audit.record(
        {
          action: 'inventory.transfer',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.transfer',
          summary:
            `Inventory transfer${item?.itemCode ? ` — ${item.itemCode}` : ''}${sublot?.lot ? ` lot ${sublot.lot}` : ''}: ` +
            `${dto.qty} from ${fromLocation?.locationCode ?? src.locationId ?? '—'} to ${toLocation.locationCode ?? dto.toLocationId}` +
            `${reason ? ` — ${reason}` : ''}`,
          changes: [
            { tableName: 'Inventory', recordId: String(src.id), fieldName: 'qty', oldValue: String(sourceQty), newValue: String(sourceQty - dto.qty) },
            { tableName: 'Inventory', recordId: String(targetInventoryId), fieldName: 'location', oldValue: null, newValue: String(dto.toLocationId) },
            { tableName: 'ChangeSet', recordId: String(csId), fieldName: 'Context', oldValue: null, newValue: TRANSFER_CONTEXT },
          ],
        },
        tx,
      );
      return { inventoryId: src.id, fromLocationId: src.locationId, toLocationId: dto.toLocationId, qty: dto.qty, sourceRemaining: sourceQty - dto.qty, targetInventoryId, changeSetId: csId };
    });
  }

  /**
   * Reverse a posted receipt (legacy `ChangeSet` Context='PO' or 'MISC', each 1:1
   * with a `ChangeSetReceipt`). Allowed ONLY while the received stock is still
   * untouched — exactly one Inventory parcel for the receipt's sublot, holding the
   * full received quantity (so anything consumed, moved, split, or adjusted is
   * refused). Creates a reversing `ChangeSet` (Context='RVS'+original, pointing
   * back via reverseChangeSetId), removes the minted on-hand parcel, and for a PO
   * receipt unwinds the `OrdDetail.QtyUsed` bump. Atomic + audited.
   */
  async reverseReceipt(changeSetId: number, dto: ReverseReceiptDto, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to reverse a receipt.');

    const cs = await this.prisma.changeSet.findUnique({ where: { id: changeSetId }, select: { id: true, context: true, ordrId: true } });
    if (!cs) throw new NotFoundException('Receipt not found');
    if (cs.context !== 'PO' && cs.context !== 'MISC') {
      throw new BadRequestException('Only purchase or miscellaneous receipts can be reversed.');
    }
    const receipt = await this.prisma.changeSetReceipt.findUnique({
      where: { changeSetId },
      select: { sublotId: true, itemId: true, psQty: true, ordDetailId: true },
    });
    if (!receipt) throw new BadRequestException('That change set is not a receipt.');
    if (receipt.sublotId == null) throw new BadRequestException('This receipt has no sublot to reverse.');

    const received = receipt.psQty ?? 0;
    const sublotId = receipt.sublotId;
    const reason = dto.reason.trim();
    const reverseContext = `RVS${cs.context}`;
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // Dup-check + untouched-check INSIDE the lock so two concurrent reversals of
      // the same receipt can't both pass the gate (the lock serializes them; the
      // second sees the first's reversing change set and is refused cleanly).
      const already = await tx.changeSet.findFirst({ where: { reverseChangeSetId: changeSetId }, select: { id: true } });
      if (already) throw new BadRequestException('This receipt has already been reversed.');

      // Untouched check: at most one parcel for the sublot, holding the full
      // received quantity. Zero parcels = the receipt minted no on-hand (e.g. a
      // location-less install) — allowed, with nothing to delete. Anything else
      // (consumed / moved / split / adjusted) is refused.
      const parcels = await tx.inventory.findMany({ where: { sublotId }, select: { id: true, qty: true } });
      const totalOnHand = parcels.reduce((s, p) => s + (p.qty ?? 0), 0);
      if (parcels.length > 1 || (parcels.length === 1 && (parcels[0].qty ?? 0) !== received)) {
        throw new BadRequestException(
          `Cannot reverse — the received stock has since been moved, split, consumed, or adjusted (on hand ${totalOnHand}, received ${received}).`,
        );
      }
      const parcel = parcels[0] ?? null;

      const csId = ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: reverseContext, changeDate: at, reverseChangeSetId: changeSetId, ordrId: cs.ordrId } });

      // Remove the minted on-hand (the receipt never happened).
      if (parcel) await tx.inventory.delete({ where: { id: parcel.id } });

      // PO: unwind the receipt's QtyUsed bump on the ordered line (floored at 0).
      // The read-modify-write is safe under the advisory lock, which a concurrent
      // receive also takes before its own QtyUsed increment.
      if (cs.context === 'PO' && receipt.ordDetailId != null && received > 0) {
        const line = await tx.ordDetail.findUnique({ where: { id: receipt.ordDetailId }, select: { qtyUsed: true } });
        await tx.ordDetail.update({ where: { id: receipt.ordDetailId }, data: { qtyUsed: Math.max(0, (line?.qtyUsed ?? 0) - received) } });
      }

      await this.audit.record(
        {
          action: 'inventory.reverseReceipt',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.reverse',
          summary: `Reversed ${cs.context} receipt (change set ${changeSetId}) — removed ${parcel ? received : 0} on hand — ${reason}`,
          changes: [
            { tableName: 'ChangeSet', recordId: String(csId), fieldName: 'reverseChangeSet', oldValue: null, newValue: String(changeSetId) },
            ...(parcel ? [{ tableName: 'Inventory', recordId: String(parcel.id), fieldName: 'removed', oldValue: String(received), newValue: null }] : []),
          ],
        },
        tx,
      );

      // UG §22.2.6 'Reverse purchase receipt' / 'Reverse miscellaneous receipt'.
      const item = receipt.itemId != null
        ? await tx.item.findUnique({
            where: { id: receipt.itemId },
            select: { itemCode: true, description: true, altDescription: true, securityGroup: true, ownerId: true },
          })
        : null;
      const sublot = await tx.sublot.findUnique({ where: { id: sublotId }, select: { lot: true } });
      await this.notifications.emit(tx, cs.context === 'PO' ? 'Reverse purchase receipt' : 'Reverse miscellaneous receipt', {
        securityGroup: item?.securityGroup,
        ownerId: item?.ownerId,
        params: {
          Area: null, Ordr: cs.ordrId, PONumber: null, Receipt: changeSetId,
          Item: item?.itemCode, Description: item?.description, AltDescription: item?.altDescription,
          Supplier: null, SupName: null, SupLot: null, Manufacturer: null, ManfName: null, ManfLot: null,
          Lot: sublot?.lot, Sublot: sublot?.lot,
        },
      });

      return { changeSetId, reversedBy: csId, removedQty: parcel ? received : 0, context: cs.context };
    });
  }

  /** Pickable storage locations (those with a code) for the transfer picker. */
  async locationOptions(q?: string) {
    const term = q?.trim();
    const rows = await this.prisma.location.findMany({
      where: { locationCode: term ? { contains: term, mode: 'insensitive' } : { not: null } },
      orderBy: { locationCode: 'asc' },
      take: 50,
      select: { id: true, locationCode: true, context: true },
    });
    return { rows };
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
      locationId: r.locationId ?? null,
      locationCode: r.locationId != null ? (locById.get(r.locationId)?.locationCode ?? null) : null,
      sublotCode: r.sublotId != null ? (subById.get(r.sublotId)?.sublotCode ?? null) : null,
      lot: r.sublotId != null ? (subById.get(r.sublotId)?.lot ?? null) : null,
    }));
  }
}
