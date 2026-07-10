import { Injectable, NotFoundException } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PartyService } from './party.service';

const FOB: Record<string, string> = { Dest: 'DESTINATION', Orig: 'ORIGIN', PPD: 'PREPAID', COL: 'COLLECT' };

/**
 * Packing slip = the SH ChangeSet (its PK is the printed packing-slip number).
 * Header from ChangeSet + Waybill (via ChangeSetShipment) + the order; lines
 * (qty only, no prices) from the order's OrdDetail. See sales-docs-mapping.
 */
@Injectable()
export class PackingSlipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly party: PartyService,
  ) {}

  async list(query: ListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['id', 'changeDate'],
      defaultSort: { id: 'desc' },
    });
    const where: Record<string, unknown> = { context: 'SH', ordrId: { not: null } };
    if (query.q) {
      const q = query.q.trim();
      const or: Record<string, unknown>[] = [{ poNumber: { contains: q, mode: 'insensitive' } }];
      if (/^\d+$/.test(q)) or.push({ id: Number(q) }, { ordrId: Number(q) });
      where.OR = or;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.changeSet.findMany({
        where, skip, take, orderBy,
        select: { id: true, changeDate: true, ordrId: true, poNumber: true },
      }),
      this.prisma.changeSet.count({ where }),
    ]);

    // Customer = the order's BillTo.
    const orderIds = [...new Set(rows.map((r) => r.ordrId).filter((v): v is number => v != null))];
    const orders = await this.prisma.ordr.findMany({ where: { id: { in: orderIds } }, select: { id: true, billToId: true } });
    const billToByOrder = new Map(orders.map((o) => [o.id, o.billToId]));
    const parties = await this.party.resolve(orders.map((o) => o.billToId));
    // Reversed slips (an RVSSH change set points back at them) list marked.
    const reversals = rows.length
      ? await this.prisma.changeSet.findMany({
          where: { context: 'RVSSH', reverseChangeSetId: { in: rows.map((r) => r.id) } },
          select: { reverseChangeSetId: true },
        })
      : [];
    const reversedSet = new Set(reversals.map((r) => r.reverseChangeSetId));

    return {
      rows: rows.map((r) => {
        const billTo = r.ordrId != null ? billToByOrder.get(r.ordrId) : null;
        return {
          id: r.id,
          packingSlipNumber: r.id,
          date: r.changeDate,
          orderId: r.ordrId,
          poNumber: r.poNumber,
          customer: billTo != null ? (parties.get(billTo)?.name ?? null) : null,
          reversed: reversedSet.has(r.id),
        };
      }),
      total, page, pageSize,
    };
  }

  async get(id: number) {
    const cs = await this.prisma.changeSet.findUnique({ where: { id } });
    if (!cs || cs.context !== 'SH') throw new NotFoundException('Packing slip not found');

    const [order, shipment, trans, reversal] = await Promise.all([
      cs.ordrId != null ? this.prisma.ordr.findUnique({ where: { id: cs.ordrId } }) : Promise.resolve(null),
      this.prisma.changeSetShipment.findUnique({ where: { changeSetId: id }, select: { waybillId: true } }),
      cs.transId != null ? this.prisma.trans.findUnique({ where: { id: cs.transId }, select: { transDocument: true } }) : Promise.resolve(null),
      // A reversed shipment (RVSSH back-pointer) prints marked, like the
      // legacy REJ'd waybill — the paper must not read as a live shipment.
      this.prisma.changeSet.findFirst({ where: { context: 'RVSSH', reverseChangeSetId: id }, select: { id: true } }),
    ]);
    const waybill = shipment?.waybillId != null
      ? await this.prisma.waybill.findUnique({ where: { id: shipment.waybillId }, select: { id: true, dateShipped: true, status: true, shipViaId: true, trailerNumber: true } })
      : null;

    const lines = order
      ? await this.prisma.ordDetail.findMany({
          where: { ordrId: order.id, itemId: { not: null } },
          orderBy: [{ execOrder: 'asc' }, { id: 'asc' }],
          select: { itemId: true, itemNameId: true, description: true, entityUnit: true, qtyReqd: true, qtyUsed: true },
        })
      : [];
    const itemIds = [...new Set(lines.flatMap((l) => [l.itemId, l.itemNameId]).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true, unit: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const carrierId = waybill?.shipViaId ?? order?.shipViaId ?? null;
    const [terms, parties, companyName] = await Promise.all([
      order?.terms ? this.prisma.terms.findUnique({ where: { code: order.terms }, select: { description: true } }) : Promise.resolve(null),
      this.party.resolve([order?.billToId, order?.shipToId, carrierId, cs.ownerId]),
      this.settings.get('company.name', 'Precision Ink Corporation'),
    ]);

    const docLines = lines.map((l) => {
      const alias = l.itemNameId != null ? itemById.get(l.itemNameId) : undefined;
      const stock = l.itemId != null ? itemById.get(l.itemId) : undefined;
      const qtyOrdered = l.qtyReqd ?? null;
      return {
        itemCode: alias?.itemCode ?? stock?.itemCode ?? null,
        description: l.description ?? stock?.description ?? null,
        unit: l.entityUnit ?? stock?.unit ?? null,
        qtyOrdered,
        qtyShipped: l.qtyUsed ?? null,
        backordered: qtyOrdered != null && l.qtyUsed != null ? qtyOrdered - l.qtyUsed : null,
      };
    });

    return {
      header: {
        packingSlipNumber: cs.id,
        date: cs.changeDate ?? waybill?.dateShipped ?? null,
        orderId: cs.ordrId,
        invoiceNumber: trans?.transDocument ?? null,
        poNumber: cs.poNumber ?? order?.poNumber ?? null,
        carrier: carrierId != null ? (parties.get(carrierId)?.name ?? null) : null,
        fob: order?.incoterms ? (FOB[order.incoterms] ?? order.incoterms.toUpperCase()) : null,
        status: waybill?.status ?? null,
        trailerNumber: waybill?.trailerNumber ?? null,
        termsText: terms?.description ?? order?.terms ?? null,
        reversed: reversal != null,
      },
      billTo: order?.billToId != null ? parties.get(order.billToId) ?? null : null,
      shipTo: order?.shipToId != null ? parties.get(order.shipToId) ?? null : null,
      seller: { name: companyName, ...(cs.ownerId != null ? parties.get(cs.ownerId) : null) },
      lines: docLines,
    };
  }
}
