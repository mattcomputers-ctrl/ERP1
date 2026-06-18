import { Injectable, NotFoundException } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

// Customer invoices are Trans rows with these contexts (CI = customer invoice).
const INVOICE_CONTEXTS = ['CI', 'TI'];
const num = (v: unknown) => (v == null ? 0 : Number(v));
const FOB: Record<string, string> = { Dest: 'DESTINATION', Orig: 'ORIGIN', PPD: 'PREPAID', COL: 'COLLECT' };

interface Party {
  entityCode: string | null;
  name: string | null;
  line1: string | null;
  line2: string | null;
  cityStateZip: string | null;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async list(query: ListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['id', 'transDocument', 'documentDate'],
      defaultSort: { id: 'desc' },
    });
    const where: Record<string, unknown> = { context: 'CI' };
    if (query.q) {
      const q = query.q.trim();
      const or: Record<string, unknown>[] = [
        { transDocument: { contains: q, mode: 'insensitive' } },
        { poNumber: { contains: q, mode: 'insensitive' } },
      ];
      if (/^\d+$/.test(q)) or.push({ ordrId: Number(q) });
      where.OR = or;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.trans.findMany({
        where, skip, take, orderBy,
        select: {
          id: true, transDocument: true, documentDate: true, ordrId: true, billToId: true,
          poNumber: true, currency: true, freightCharge: true, tax1Amount: true, tax2Amount: true, tax3Amount: true,
        },
      }),
      this.prisma.trans.count({ where }),
    ]);

    const subtotalByTrans = await this.subtotals(rows.map((r) => r.id));
    const parties = await this.resolveParties(rows.map((r) => r.billToId));

    return {
      rows: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.transDocument,
        documentDate: r.documentDate,
        orderId: r.ordrId,
        poNumber: r.poNumber,
        customer: r.billToId != null ? (parties.get(r.billToId)?.name ?? parties.get(r.billToId)?.entityCode ?? null) : null,
        total: (subtotalByTrans.get(r.id) ?? 0) + num(r.freightCharge) + num(r.tax1Amount) + num(r.tax2Amount) + num(r.tax3Amount),
      })),
      total, page, pageSize,
    };
  }

  async get(id: number) {
    const trans = await this.prisma.trans.findUnique({ where: { id } });
    if (!trans || !INVOICE_CONTEXTS.includes(trans.context ?? '')) throw new NotFoundException('Invoice not found');

    const lines = await this.prisma.transDetail.findMany({
      where: { transId: id },
      orderBy: { id: 'asc' },
      select: { ordDetailId: true, itemId: true, qty: true, price: true, unit: true },
    });
    const order = trans.ordrId != null ? await this.prisma.ordr.findUnique({ where: { id: trans.ordrId } }) : null;

    const ordDetailIds = [...new Set(lines.map((l) => l.ordDetailId).filter((v): v is number => v != null))];
    const ordDetails = await this.prisma.ordDetail.findMany({
      where: { id: { in: ordDetailIds } },
      select: { id: true, qtyReqd: true, qtyUsed: true, description: true, itemNameId: true, itemId: true },
    });
    const odById = new Map(ordDetails.map((o) => [o.id, o]));

    // Printed item code is the NAME-context alias (OrdDetail.itemName); fall back to the stock item.
    const itemIds = [
      ...new Set([
        ...ordDetails.map((o) => o.itemNameId),
        ...ordDetails.map((o) => o.itemId),
        ...lines.map((l) => l.itemId),
      ].filter((v): v is number => v != null)),
    ];
    const items = await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const [terms, currencyRow, parties] = await Promise.all([
      order?.terms ? this.prisma.terms.findUnique({ where: { code: order.terms }, select: { description: true } }) : Promise.resolve(null),
      trans.currency ? this.prisma.currency.findUnique({ where: { code: trans.currency }, select: { description: true } }) : Promise.resolve(null),
      this.resolveParties([trans.billToId, order?.shipToId, trans.ownerId, trans.salesmanId, order?.shipViaId]),
    ]);

    const docLines = lines.map((l) => {
      const od = l.ordDetailId != null ? odById.get(l.ordDetailId) : undefined;
      const aliasItem = od?.itemNameId != null ? itemById.get(od.itemNameId) : undefined;
      const stockItem = (od?.itemId ?? l.itemId) != null ? itemById.get((od?.itemId ?? l.itemId) as number) : undefined;
      const amount = num(l.qty) * num(l.price);
      const qtyOrdered = od?.qtyReqd ?? null;
      const qtyShipped = l.qty;
      return {
        itemCode: aliasItem?.itemCode ?? stockItem?.itemCode ?? null,
        description: od?.description ?? stockItem?.description ?? null,
        unit: l.unit,
        qtyOrdered,
        qtyShipped,
        backordered: qtyOrdered != null && od?.qtyUsed != null ? qtyOrdered - od.qtyUsed : null,
        price: num(l.price),
        amount,
      };
    });

    const subtotal = docLines.reduce((s, l) => s + l.amount, 0);
    const freight = num(trans.freightCharge);
    const tax = num(trans.tax1Amount) + num(trans.tax2Amount) + num(trans.tax3Amount);

    const companyName = await this.settings.get('company.name', 'Precision Ink Corporation');

    return {
      header: {
        invoiceNumber: trans.transDocument,
        documentDate: trans.documentDate,
        poNumber: trans.poNumber ?? order?.poNumber ?? null,
        orderId: trans.ordrId,
        termsText: terms?.description ?? order?.terms ?? null,
        carrier: order?.shipViaId != null ? (parties.get(order.shipViaId)?.name ?? parties.get(order.shipViaId)?.entityCode ?? null) : null,
        fob: order?.incoterms ? (FOB[order.incoterms] ?? order.incoterms.toUpperCase()) : null,
        currency: trans.currency,
        currencyLabel: currencyRow?.description ?? trans.currency,
        salesman: trans.salesmanId != null ? (parties.get(trans.salesmanId)?.name ?? null) : null,
      },
      billTo: trans.billToId != null ? parties.get(trans.billToId) ?? null : null,
      shipTo: order?.shipToId != null ? parties.get(order.shipToId) ?? null : null,
      seller: { name: companyName, ...(trans.ownerId != null ? parties.get(trans.ownerId) : null) },
      lines: docLines,
      totals: { subtotal, freight, tax, total: subtotal + freight + tax },
    };
  }

  // --- helpers -------------------------------------------------------------

  /** Σ(qty*price) per Trans for a set of invoices. */
  private async subtotals(transIds: number[]): Promise<Map<number, number>> {
    if (!transIds.length) return new Map();
    const lines = await this.prisma.transDetail.findMany({
      where: { transId: { in: transIds } },
      select: { transId: true, qty: true, price: true },
    });
    const m = new Map<number, number>();
    for (const l of lines) if (l.transId != null) m.set(l.transId, (m.get(l.transId) ?? 0) + num(l.qty) * num(l.price));
    return m;
  }

  /**
   * Resolve entity ids to display name + address. Entity has NO Name column —
   * the name and street address live on Address, linked via AddressReference
   * (TableName='Entity'), with Reference='Address' preferred.
   */
  private async resolveParties(ids: (number | null | undefined)[]): Promise<Map<number, Party>> {
    const distinct = [...new Set(ids.filter((v): v is number => v != null))];
    if (!distinct.length) return new Map();

    const [entities, refs] = await Promise.all([
      this.prisma.entity.findMany({ where: { id: { in: distinct } }, select: { id: true, entityCode: true } }),
      this.prisma.addressReference.findMany({
        where: { tableName: 'Entity', tableId: { in: distinct } },
        select: { tableId: true, address: true, reference: true },
      }),
    ]);
    // Prefer the canonical 'Address' reference, else any.
    const addrIdByEntity = new Map<number, number>();
    for (const r of refs) {
      if (!addrIdByEntity.has(r.tableId) || r.reference === 'Address') addrIdByEntity.set(r.tableId, r.address);
    }
    const addrIds = [...new Set([...addrIdByEntity.values()])];
    const addresses = addrIds.length
      ? await this.prisma.address.findMany({
          where: { id: { in: addrIds } },
          select: { id: true, name: true, addrLine1: true, addrLine2: true, city: true, state: true, zipCode: true },
        })
      : [];
    const addrById = new Map(addresses.map((a) => [a.id, a]));

    const out = new Map<number, Party>();
    for (const e of entities) {
      const a = addrIdByEntity.has(e.id) ? addrById.get(addrIdByEntity.get(e.id)!) : undefined;
      const cityStateZip = a ? [a.city, a.state].filter(Boolean).join(', ') + (a.zipCode ? ` ${a.zipCode}` : '') : null;
      out.set(e.id, {
        entityCode: e.entityCode,
        name: a?.name ?? e.entityCode,
        line1: a?.addrLine1 ?? null,
        line2: a?.addrLine2 ?? null,
        cityStateZip: cityStateZip || null,
      });
    }
    return out;
  }
}
