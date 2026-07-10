import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { MovementRecorderService } from './movement-recorder.service';
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
    private readonly movements: MovementRecorderService,
    private readonly notifications: NotificationEngineService,
  ) {}

  /** The parcel's lot unit cost (for movement leg values); null when unknown. */
  private async lotUnitCost(tx: Parameters<MovementRecorderService['record']>[0], sublotId: number | null): Promise<number | null> {
    if (sublotId == null) return null;
    const sub = await tx.sublot.findUnique({ where: { id: sublotId }, select: { lot: true } });
    if (!sub?.lot) return null;
    const lot = await tx.lot.findUnique({ where: { lot: sub.lot }, select: { unitCost: true } });
    return lot?.unitCost != null ? Number(lot.unitCost) : null;
  }

  /**
   * Set ONE on-hand parcel to an absolute quantity inside an EXISTING transaction,
   * under an ALREADY-CREATED change set (the caller holds the tx + the alloc lock
   * and writes the audit): re-reads the qty under the lock, updates it, posts the
   * signed US movement leg (valued at the lot's unit cost — the legacy COUNT
   * shape), and fires the 'Reweigh Outside Threshold' notification past the
   * configured percentage. Returns before/after + delta + decoration for the
   * caller's audit; a no-op (delta 0) posts nothing and returns skipped=true. The
   * reserved / SMP / ASM fences are re-asserted here so neither caller can drain a
   * reservation or a retained sample with COUNT semantics. Shared by adjust() (one
   * change set per call) and inventory-count posting (ONE change set per sheet).
   */
  async setParcelQtyInTx(
    tx: Parameters<MovementRecorderService['record']>[0],
    opts: { parcelId: number; newQty: number; changeSetId: number; at: Date },
  ): Promise<{ oldQty: number; newQty: number; delta: number; skipped: boolean; itemCode: string | null; lot: string | null; locationCode: string | null }> {
    if (opts.newQty < 0) throw new BadRequestException('The adjusted quantity cannot be negative.');
    const parcel = await tx.inventory.findUnique({
      where: { id: opts.parcelId },
      select: { id: true, itemId: true, sublotId: true, locationId: true, ordDetailId: true, qty: true },
    });
    if (!parcel) throw new NotFoundException('Inventory parcel not found');
    if (parcel.ordDetailId != null) {
      throw new BadRequestException('This parcel is reserved to a shipping order — unstage it from the order’s staging panel instead.');
    }
    const [item, sublot, location] = await Promise.all([
      parcel.itemId != null
        ? tx.item.findUnique({ where: { id: parcel.itemId }, select: { itemCode: true, description: true, unit: true, securityGroup: true, ownerId: true } })
        : Promise.resolve(null),
      parcel.sublotId != null ? tx.sublot.findUnique({ where: { id: parcel.sublotId }, select: { lot: true } }) : Promise.resolve(null),
      parcel.locationId != null ? tx.location.findUnique({ where: { id: parcel.locationId }, select: { locationCode: true, context: true } }) : Promise.resolve(null),
    ]);
    if (location?.context === 'SMP' || location?.context === 'ASM') {
      throw new BadRequestException(
        location.context === 'ASM'
          ? 'Assembly parcels are managed from the shipping order’s staging panel — not by plain adjustment.'
          : 'Sample parcels are managed by the QA sampling flow — not by plain adjustment.',
      );
    }
    const oldQty = parcel.qty ?? 0;
    const delta = opts.newQty - oldQty;
    const decoration = { itemCode: item?.itemCode ?? null, lot: sublot?.lot ?? null, locationCode: location?.locationCode ?? null };
    if (delta === 0) return { oldQty, newQty: opts.newQty, delta: 0, skipped: true, ...decoration };

    await tx.inventory.update({ where: { id: parcel.id }, data: { qty: opts.newQty } });
    // Movement ledger: legacy COUNT shape — one US leg whose Qty is the signed
    // DELTA (counted − book), valued at the lot's unit cost.
    const unitCost = await this.lotUnitCost(tx, parcel.sublotId);
    await this.movements.record(tx, [{
      context: ADJUST_CONTEXT, changeSetId: opts.changeSetId, itemId: parcel.itemId, sublotId: parcel.sublotId,
      legs: [{
        context: 'US', ownerId: await this.movements.defaultOwnerId(tx), locationId: parcel.locationId,
        qty: delta, value: unitCost != null ? this.movements.money4(delta * unitCost) : null,
      }],
    }]);

    // UG §22.2.1 'Reweigh Outside Threshold': an adjustment beyond the configured
    // percentage of the original quantity (legacy ParamsInventory.ReweighThreshold;
    // ERP1 inventory.reweighThreshold, this plant's live value 5%). Only computable
    // against a positive original quantity; 0 disables.
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
            Container: parcel.id, Adjustment: r6(delta), ReweighThreshold: threshold,
            MaxVariance: r6(maxVariance), OriginalQty: oldQty, Unit: item?.unit,
            ItemCode: item?.itemCode, Description: item?.description, Lot: sublot?.lot,
          },
          links: sublot?.lot ? { Lot: `/lot-tracking?focus=${encodeURIComponent(sublot.lot)}` } : undefined,
        });
      }
    }
    return { oldQty, newQty: opts.newQty, delta, skipped: false, ...decoration };
  }

  /**
   * Adjust an on-hand inventory parcel to a new absolute quantity (a count /
   * correction — write-on or write-off), with a required reason. Records a
   * `ChangeSet` Context='COUNT' header (native id) and sets `Inventory.qty` via
   * the shared per-parcel core; atomic, audited. A no-op (same quantity)
   * short-circuits without a change set.
   */
  async adjust(dto: AdjustInventoryDto, actor: Actor) {
    if (!dto.reason?.trim()) throw new BadRequestException('A reason is required to adjust inventory.');
    if (dto.newQty < 0) throw new BadRequestException('The adjusted quantity cannot be negative.');
    const reason = dto.reason.trim();
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Peek the current qty under the lock to preserve the no-op → no-change-set
      // behavior (the shared core assumes the change set already exists). The
      // reserved fence is re-asserted in the core too.
      const cur = await tx.inventory.findUnique({ where: { id: dto.inventoryId }, select: { qty: true, ordDetailId: true, locationId: true } });
      if (!cur) throw new NotFoundException('Inventory parcel not found');
      if (cur.ordDetailId != null) {
        throw new BadRequestException('This parcel is reserved to a shipping order — unstage it from the order’s staging panel instead.');
      }
      // Re-assert the SMP/ASM fence BEFORE the no-op short-circuit (setParcelQtyInTx
      // holds it too, but that runs only for a real change — a no-op adjust on a
      // sample/assembly parcel must still be refused, matching the pre-refactor path).
      if (cur.locationId != null) {
        const loc = await tx.location.findUnique({ where: { id: cur.locationId }, select: { context: true } });
        if (loc?.context === 'SMP' || loc?.context === 'ASM') {
          throw new BadRequestException(
            loc.context === 'ASM'
              ? 'Assembly parcels are managed from the shipping order’s staging panel — not by plain adjustment.'
              : 'Sample parcels are managed by the QA sampling flow — not by plain adjustment.',
          );
        }
      }
      const oldQty = cur.qty ?? 0;
      if (dto.newQty - oldQty === 0) return { inventoryId: dto.inventoryId, oldQty, newQty: dto.newQty, delta: 0, unchanged: true };

      const csId = ((await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.changeSet.create({ data: { id: csId, context: ADJUST_CONTEXT, changeDate: at } });
      const r = await this.setParcelQtyInTx(tx, { parcelId: dto.inventoryId, newQty: dto.newQty, changeSetId: csId, at });
      await this.audit.record(
        {
          action: 'inventory.adjust',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.adjust',
          summary:
            `Inventory adjusted${r.itemCode ? ` — ${r.itemCode}` : ''}${r.lot ? ` lot ${r.lot}` : ''}` +
            `${r.locationCode ? ` @ ${r.locationCode}` : ''}: ${r.oldQty} → ${r.newQty} (${r.delta > 0 ? '+' : ''}${r.delta}) — ${reason}`,
          changes: [
            { tableName: 'Inventory', recordId: String(dto.inventoryId), fieldName: 'qty', oldValue: String(r.oldQty), newValue: String(r.newQty) },
            { tableName: 'ChangeSet', recordId: String(csId), fieldName: 'Context', oldValue: null, newValue: ADJUST_CONTEXT },
          ],
        },
        tx,
      );
      return { inventoryId: dto.inventoryId, oldQty: r.oldQty, newQty: r.newQty, delta: r.delta, changeSetId: csId };
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
      select: { id: true, itemId: true, sublotId: true, locationId: true, status: true, ordDetailId: true },
    });
    if (!src) throw new NotFoundException('Inventory parcel not found');
    if (src.locationId === dto.toLocationId) throw new BadRequestException('The destination must be a different location.');
    // A reserved parcel (staged to a shipping-order line) is not free stock —
    // a plain move would silently strip or strand its reservation. The staging
    // flow (unstage) is the only door out.
    if (src.ordDetailId != null) {
      throw new BadRequestException('This parcel is reserved to a shipping order — unstage it from the order’s staging panel instead.');
    }

    const toLocation = await this.prisma.location.findUnique({ where: { id: dto.toLocationId }, select: { id: true, locationCode: true, context: true } });
    if (!toLocation) throw new NotFoundException('Destination location not found');
    // Special-purpose namespaces move through their own flows only: SMP =
    // retained samples (sampling seam), ASM = shipping assemblies (staging).
    // Stock parked there by a plain transfer would vanish from every
    // consumable/nettable view.
    if (toLocation.context === 'SMP' || toLocation.context === 'ASM') {
      throw new BadRequestException(
        toLocation.context === 'ASM'
          ? 'Assemblies are filled from the shipping order’s staging panel — not by plain transfer.'
          : 'Sample locations are managed by the QA sampling flow — not by plain transfer.',
      );
    }

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
        // ordDetailId: null — free stock must never coalesce into a parcel
        // reserved to a shipping order (that would silently inflate the
        // reservation with unstaged quantity).
        where: { itemId: src.itemId, sublotId: src.sublotId, locationId: dto.toLocationId, status: src.status, ordDetailId: null },
        select: { id: true },
      });

      // ONE ascending-id locked scan over every parcel this transfer touches —
      // the system-wide lock order (see ValuationService.depleteSpecificMany).
      // Depleters don't take the advisory lock, so this both prevents a
      // source-then-destination lock inversion against their single ascending
      // scans AND makes the quantity reads race-free (the previous unlocked
      // read-modify-write could overwrite a concurrent depletion).
      const ids = existing ? [src.id, existing.id] : [src.id];
      const locked = await tx.$queryRaw<{ id: number; qty: number | null; ordDetailId: number | null }[]>`
        SELECT "Inventory" AS id, "Qty" AS qty, "OrdDetail" AS "ordDetailId" FROM "Inventory"
        WHERE "Inventory" = ANY(${ids})
        ORDER BY "Inventory" ASC
        FOR UPDATE`;
      const qtyById = new Map(locked.map((r) => [r.id, r.qty ?? 0]));
      if (!qtyById.has(src.id)) throw new NotFoundException('Inventory parcel not found');
      // Re-assert the unreserved precondition under the lock (pre-tx check
      // above gives the friendly error; this one closes the race).
      if (locked.find((r) => r.id === src.id)?.ordDetailId != null) {
        throw new BadRequestException('This parcel is reserved to a shipping order — unstage it from the order’s staging panel instead.');
      }
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

      // Movement ledger: a pure location move — US out of the source, MK into
      // the destination, NO value fields (the legacy PICK no-value rule, so
      // at-date qty/value are untouched by moves). Header context TRNSFR
      // matches the change set (legacy TRNSFR movements are consignment
      // transfers; ERP1 repurposes the code for its location transfer —
      // deliberate deviation, ASSUMPTIONS §20).
      const owner = await this.movements.defaultOwnerId(tx);
      await this.movements.record(tx, [{
        context: TRANSFER_CONTEXT, changeSetId: csId, itemId: src.itemId, sublotId: src.sublotId,
        legs: [
          { context: 'US', ownerId: owner, locationId: src.locationId, qty: -dto.qty },
          { context: 'MK', ownerId: owner, locationId: dto.toLocationId, qty: dto.qty },
        ],
      }]);

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
      const parcels = await tx.inventory.findMany({ where: { sublotId }, select: { id: true, qty: true, locationId: true } });
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
      if (parcel) {
        await tx.inventory.delete({ where: { id: parcel.id } });
        // Movement ledger: a negative MK leg under the reversing change set,
        // keeping the FORWARD movement context (legacy idiom — corrections are
        // negative receipt legs; RVSPO/RVSMISC are not viewer filter options.
        // RVSSH is — but that's the shipment-reversal context, not ours).
        const unitCost = await this.lotUnitCost(tx, sublotId);
        await this.movements.record(tx, [{
          context: cs.context as 'PO' | 'MISC', changeSetId: csId, itemId: receipt.itemId, sublotId,
          legs: [{
            context: 'MK', ownerId: await this.movements.defaultOwnerId(tx), locationId: parcel.locationId,
            ordDetailId: receipt.ordDetailId, qty: -received,
            value: unitCost != null ? this.movements.money4(-received * unitCost) : null,
          }],
        }]);
      }

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

  /**
   * Container/lot label data for one parcel (legacy PrintContainerLabel —
   * 25,434 uses, ~3,000/yr): item, our lot + the manufacturer/supplier lots
   * (the recall keys), the parcel quantity, dates, and the sublot's QA
   * disposition. Reprinting is just reopening the label page.
   */
  async containerLabel(id: number) {
    const parcel = await this.prisma.inventory.findUnique({ where: { id } });
    if (!parcel) throw new NotFoundException('Inventory parcel not found');

    const [item, location, sublot] = await Promise.all([
      this.prisma.item.findUnique({
        where: { id: parcel.itemId },
        select: { itemCode: true, description: true, unit: true },
      }),
      this.prisma.location.findUnique({ where: { id: parcel.locationId }, select: { locationCode: true } }),
      parcel.sublotId != null
        ? this.prisma.sublot.findUnique({ where: { id: parcel.sublotId }, select: { id: true, sublotCode: true, lot: true } })
        : null,
    ]);
    const lot = sublot?.lot
      ? await this.prisma.lot.findUnique({
          where: { lot: sublot.lot },
          select: { lot: true, supLot: true, manfLot: true, manfDate: true, receivedDate: true, supplierId: true, ordDetailId: true },
        })
      : null;
    // The sublot's QA disposition (latest Release row — legacy Release is
    // append-only history, highest id = current).
    const release = sublot
      ? await this.prisma.release.findFirst({
          where: { sublotId: sublot.id },
          orderBy: { id: 'desc' },
          select: { status: true, grade: true, expiryDate: true },
        })
      : null;

    return {
      inventoryId: parcel.id,
      itemCode: item?.itemCode ?? null,
      description: item?.description ?? null,
      qty: parcel.qty ?? null,
      unit: item?.unit ?? null,
      locationCode: location?.locationCode ?? null,
      lot: lot?.lot ?? sublot?.lot ?? null,
      sublotCode: sublot?.sublotCode ?? null,
      supLot: lot?.supLot ?? null,
      manfLot: lot?.manfLot ?? null,
      manfDate: lot?.manfDate ?? null,
      receivedDate: lot?.receivedDate ?? null,
      // Produced lots (ordDetailId set) are made here; purchased ones received.
      madeHere: lot?.ordDetailId != null,
      status: release?.status ?? parcel.status ?? null,
      grade: release?.grade ?? null,
      expiryDate: release?.expiryDate ?? null,
    };
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
