import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { maxRawLotNumber } from '../common/lot-numbers';
import { NotificationEngineService } from '../notifications/notification-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { MovementRecorderService } from './movement-recorder.service';
import { ValuationService } from './valuation.service';
import type { CreateMiscReceiptDto } from './dto/misc-receipt.dto';

const MISC_CONTEXT = 'MISC';
const RECEIVING_LOCATION_SETTING = 'inventory.receivingLocation';

/**
 * Miscellaneous (non-PO) inventory receipts — legacy `ChangeSet` Context='MISC'
 * (Ordr null) with a 1:1 `ChangeSetReceipt` (OrdDetail null, Item + PSQty). Used
 * to create stock without a purchase order: opening balances, found stock,
 * samples in, adjustments-in. Each line mints a system lot (the shared
 * raw-material sequence), its sublot, and on-hand at the receiving location via
 * the valuation engine — mirroring purchase receiving, minus the supplier/PO line
 * (so the manufacturer lot is optional). Native ids (ChangeSet, Sublot) ≥
 * NATIVE_ID_BASE under the shared id-allocation lock; one transaction, atomic audit.
 */
@Injectable()
export class MiscReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly valuation: ValuationService,
    private readonly movements: MovementRecorderService,
    private readonly notifications: NotificationEngineService,
  ) {}

  async receive(dto: CreateMiscReceiptDto, actor: Actor) {
    const itemIds = [...new Set(dto.lines.map((l) => l.itemId))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, unit: true, description: true, altDescription: true, securityGroup: true, ownerId: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));
    const missing = itemIds.filter((id) => !itemById.has(id));
    if (missing.length) throw new BadRequestException(`Unknown item id(s): ${missing.join(', ')}`);

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      let csId = (await tx.changeSet.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE;
      let subId = (await tx.sublot.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE;
      let lotSeq = await maxRawLotNumber(tx);
      const receivingLocationId = await this.valuation.resolveLocationId(tx, RECEIVING_LOCATION_SETTING);

      const created: { lot: string; itemId: number; qty: number; manufacturerLot: string | null; changeSetId: number }[] = [];
      for (const l of dto.lines) {
        const item = itemById.get(l.itemId)!;
        const lotNumber = String((lotSeq += 1));
        const newSubId = (subId += 1);
        const newCsId = (csId += 1);
        const mfrLot = l.manufacturerLot?.trim() || null;

        await tx.lot.create({
          data: {
            lot: lotNumber,
            context: 'LOT',
            itemId: l.itemId,
            // No supplier on a misc receipt; tag the manufacturer lot when given so
            // the lot is recall-findable (the recall key is SupLot).
            supLot: mfrLot,
            manfLot: mfrLot,
            receivedDate: at,
            unitCost: l.unitCost ?? null,
          },
        });
        await tx.sublot.create({ data: { id: newSubId, lot: lotNumber, sublotCode: lotNumber, context: 'LOT' } });
        const mintedId = await this.valuation.mintInventory(tx, { itemId: l.itemId, sublotId: newSubId, locationId: receivingLocationId, qty: l.qty });

        await tx.changeSet.create({
          data: { id: newCsId, context: MISC_CONTEXT, ordrId: null, changeDate: at },
        });
        // Movement ledger: legacy MISC shape (one MK leg). On-hand truth only.
        if (mintedId != null) {
          await this.movements.record(tx, [{
            context: 'MISC', changeSetId: newCsId, itemId: l.itemId, sublotId: newSubId,
            legs: [{
              context: 'MK', ownerId: await this.movements.defaultOwnerId(tx), locationId: receivingLocationId,
              qty: l.qty, value: l.unitCost != null ? this.movements.money4(l.qty * l.unitCost) : null,
            }],
          }]);
        }
        await tx.changeSetReceipt.create({
          data: {
            changeSetId: newCsId,
            ordDetailId: null,
            itemId: l.itemId,
            sublotId: newSubId,
            psQty: l.qty,
            psUnit: l.unit ?? item.unit ?? null,
            qtyPerPsQty: 1,
            numberOfContainers: l.numberOfContainers ?? 1,
          },
        });
        created.push({ lot: lotNumber, itemId: l.itemId, qty: l.qty, manufacturerLot: mfrLot, changeSetId: newCsId });
      }

      await this.audit.record(
        {
          action: 'inventory.miscReceipt',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'inventory.receipts',
          summary:
            `Miscellaneous receipt: ${created.length} lot${created.length === 1 ? '' : 's'} created` +
            (dto.reference ? ` (ref ${dto.reference})` : ''),
          changes: created.map((c) => ({
            tableName: 'Lot',
            recordId: c.lot,
            fieldName: 'received',
            oldValue: null,
            newValue: `item ${c.itemId}: ${c.qty}${c.manufacturerLot ? ` (mfr lot ${c.manufacturerLot})` : ''}`,
          })),
        },
        tx,
      );

      // UG §22.2.6 'Miscellaneous receipt' — one notification per created lot.
      const receiverEmail = (await tx.user.findUnique({ where: { id: actor.id }, select: { email: true } }))?.email;
      for (const c of created) {
        const item = itemById.get(c.itemId)!;
        await this.notifications.emit(tx, 'Miscellaneous receipt', {
          securityGroup: item.securityGroup,
          ownerId: item.ownerId,
          contextEmails: [receiverEmail],
          params: {
            Area: null, Ordr: null, PONumber: null, Receipt: c.changeSetId,
            Item: item.itemCode, Description: item.description, AltDescription: item.altDescription,
            Supplier: null, SupName: null, SupLot: c.manufacturerLot,
            Manufacturer: null, ManfName: null, ManfLot: c.manufacturerLot,
            Lot: c.lot, Sublot: c.lot,
          },
          links: { Lot: `/lot-tracking?focus=${encodeURIComponent(c.lot)}` },
        });
      }

      return { received: created.length, lots: created };
    });
  }

  /** Browse miscellaneous receipts (Context='MISC' change sets + their receipt). */
  async list(query: ListQuery) {
    const { skip, take, page, pageSize } = buildList(query, { sortable: ['id'], defaultSort: { id: 'desc' } });
    const where = { context: MISC_CONTEXT };
    const [changeSets, total] = await this.prisma.$transaction([
      this.prisma.changeSet.findMany({ where, skip, take, orderBy: { id: 'desc' }, select: { id: true, changeDate: true } }),
      this.prisma.changeSet.count({ where }),
    ]);
    if (!changeSets.length) return { rows: [], total, page, pageSize };

    const csIds = changeSets.map((c) => c.id);
    const receipts = await this.prisma.changeSetReceipt.findMany({
      where: { changeSetId: { in: csIds } },
      select: { changeSetId: true, itemId: true, sublotId: true, psQty: true, psUnit: true, numberOfContainers: true },
    });
    const receiptByCs = new Map(receipts.map((r) => [r.changeSetId, r]));
    const itemIds = [...new Set(receipts.map((r) => r.itemId).filter((v): v is number => v != null))];
    const subIds = [...new Set(receipts.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const [items, sublots] = await Promise.all([
      itemIds.length ? this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } }) : Promise.resolve([]),
      subIds.length ? this.prisma.sublot.findMany({ where: { id: { in: subIds } }, select: { id: true, lot: true } }) : Promise.resolve([]),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const subById = new Map(sublots.map((s) => [s.id, s]));

    return {
      rows: changeSets.map((cs) => {
        const r = receiptByCs.get(cs.id);
        const item = r?.itemId != null ? itemById.get(r.itemId) : undefined;
        return {
          changeSetId: cs.id,
          date: cs.changeDate,
          itemCode: item?.itemCode ?? null,
          itemDescription: item?.description ?? null,
          qty: r?.psQty ?? null,
          unit: r?.psUnit ?? null,
          containers: r?.numberOfContainers ?? null,
          lot: r?.sublotId != null ? subById.get(r.sublotId)?.lot ?? null : null,
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  /** Item picker for the misc-receipt form. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    const where = term
      ? { OR: [{ itemCode: { contains: term, mode: 'insensitive' as const } }, { description: { contains: term, mode: 'insensitive' as const } }] }
      : {};
    const rows = await this.prisma.item.findMany({ where, take: 25, orderBy: { itemCode: 'asc' }, select: { id: true, itemCode: true, description: true, unit: true } });
    return { rows };
  }
}
