import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TaxService } from '../accounting/tax.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import type { GenerateInvoiceDto } from './dto/generate-invoice.dto';
import { PartyService } from './party.service';
import { num, transTotals } from './trans-math';

// Customer invoices are Trans rows with these contexts (CI = customer invoice).
const INVOICE_CONTEXTS = ['CI', 'TI'];
const FOB: Record<string, string> = { Dest: 'DESTINATION', Orig: 'ORIGIN', PPD: 'PREPAID', COL: 'COLLECT' };

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly party: PartyService,
    private readonly tax: TaxService,
    private readonly audit: AuditService,
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
    const parties = await this.party.resolve(rows.map((r) => r.billToId));

    return {
      rows: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.transDocument,
        documentDate: r.documentDate,
        orderId: r.ordrId,
        poNumber: r.poNumber,
        customer: r.billToId != null ? (parties.get(r.billToId)?.name ?? parties.get(r.billToId)?.entityCode ?? null) : null,
        total: transTotals(subtotalByTrans.get(r.id) ?? 0, r).total,
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
      this.party.resolve([trans.billToId, order?.shipToId, trans.ownerId, trans.salesmanId, order?.shipViaId]),
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
    const totals = transTotals(subtotal, trans);

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
      totals,
    };
  }

  /**
   * Generate a customer invoice (Trans Context='CI' + TransDetail lines) for a
   * shipping (SH) order's shipped-but-not-yet-invoiced quantities. Legacy
   * invoices per shipment event (2,861 orders carry several CI invoices), so
   * the invoiceable quantity per line is QtyUsed (shipped so far — native
   * shipments stamp it too) minus what previous non-reversed invoices already
   * billed. Header fields (bill-to / owner / salesman / currency / customer
   * PO) copy the order, exactly like the 22K live CI rows do; the invoice
   * number continues the plant's N-sequence; taxes come from the TaxRule
   * engine over the bill-to's and items' tax groups; price is the order
   * line's sale price. Atomic under the Ordr row lock (a concurrent generate
   * for the same order re-reads invoiced state and can't double-bill) +
   * native-id allocation lock; audited.
   */
  async generate(dto: GenerateInvoiceDto, actor: Actor) {
    const order = await this.prisma.ordr.findUnique({
      where: { id: dto.orderId },
      select: {
        id: true, context: true, status: true, billToId: true, ownerId: true,
        salesmanId: true, currency: true, poNumber: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.context !== 'SH') throw new BadRequestException('Invoices are generated from shipping (SH) orders.');
    if (order.billToId == null) throw new BadRequestException('The order has no bill-to customer.');
    if (order.status === 'NST') throw new BadRequestException('The order has not shipped anything yet.');
    const freight = dto.freightCharge ?? 0;

    return this.prisma.$transaction(async (tx) => {
      // Convention: anything reading/mutating one order's state serializes on
      // the Ordr row lock FIRST (then the shared id-allocation lock).
      await tx.$queryRaw`SELECT "Ordr" FROM "Ordr" WHERE "Ordr" = ${order.id} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      // Shipped state + prior invoices, both re-read under the lock.
      const lines = await tx.ordDetail.findMany({
        where: { ordrId: order.id, context: 'SH', itemId: { not: null } },
        orderBy: { id: 'asc' },
        select: { id: true, itemId: true, qtyUsed: true, price: true, entityUnit: true },
      });
      const priorInvoices = await tx.trans.findMany({
        where: { ordrId: order.id, context: 'CI' },
        select: { id: true, reversedTransId: true },
      });
      // A reversing invoice restores the reversed one's quantities as
      // invoiceable; exclude both sides of a reversal pair.
      const reversedIds = new Set(priorInvoices.map((t) => t.reversedTransId).filter((v): v is number => v != null));
      const activeInvoiceIds = priorInvoices
        .filter((t) => t.reversedTransId == null && !reversedIds.has(t.id))
        .map((t) => t.id);
      const invoicedByLine = new Map<number, number>();
      if (activeInvoiceIds.length) {
        const prior = await tx.transDetail.findMany({
          where: { transId: { in: activeInvoiceIds } },
          select: { ordDetailId: true, qty: true },
        });
        for (const p of prior) {
          if (p.ordDetailId != null) invoicedByLine.set(p.ordDetailId, (invoicedByLine.get(p.ordDetailId) ?? 0) + num(p.qty));
        }
      }

      const billable = lines
        .map((l) => ({
          line: l,
          qty: Math.max(0, num(l.qtyUsed) - (invoicedByLine.get(l.id) ?? 0)),
        }))
        .filter((b) => b.qty > 0);
      if (!billable.length) {
        throw new BadRequestException(
          'Nothing to invoice — no shipped quantity remains uninvoiced on this order.',
        );
      }

      // Taxes over the billable lines (bill-to's groups x item groups) +
      // freight — computed ON the tx client (this tx holds the Ordr row lock
      // and the id-allocation lock; reads must not borrow pool connections).
      const taxes = await this.tax.forCustomer(
        order.billToId!,
        billable.map((b) => ({ itemId: b.line.itemId, amount: b.qty * num(b.line.price), qty: b.qty })),
        freight,
        tx,
      );

      // Line unit: the customer-facing unit when the line has one, else the
      // item's stock unit (what the live TransDetail rows carry).
      const unitItemIds = [...new Set(billable.map((b) => b.line.itemId).filter((v): v is number => v != null))];
      const unitItems = unitItemIds.length
        ? await tx.item.findMany({ where: { id: { in: unitItemIds } }, select: { id: true, unit: true } })
        : [];
      const unitByItem = new Map(unitItems.map((i) => [i.id, i.unit]));

      // Next invoice number: the plant's N-sequence (N + 8 digits, zero-padded,
      // so the lexicographic max IS the numeric max). Computed under the
      // advisory lock; imported legacy rows share the sequence — see
      // OPEN_QUESTIONS on parallel-running collisions.
      const [{ max: lastNum }] = await tx.$queryRaw<[{ max: number | null }]>`
        SELECT MAX(substring("TransDocument" from 2)::int) AS max
        FROM "Trans" WHERE "TransDocument" ~ '^N[0-9]{8}$'`;
      const transDocument = `N${String((lastNum ?? 0) + 1).padStart(8, '0')}`;

      const transId = ((await tx.trans.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const maxDetail = ((await tx.transDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE);
      const at = new Date();

      await tx.trans.create({
        data: {
          id: transId,
          context: 'CI',
          transDocument,
          documentDate: at,
          transDate: at,
          ordrId: order.id,
          billToId: order.billToId,
          ownerId: order.ownerId,
          salesmanId: order.salesmanId,
          currency: order.currency,
          poNumber: order.poNumber,
          freightCharge: freight || null,
          tax1Amount: taxes.taxes[0] || null,
          tax2Amount: taxes.taxes[1] || null,
          tax3Amount: taxes.taxes[2] || null,
        },
      });
      await tx.transDetail.createMany({
        data: billable.map((b, i) => ({
          id: maxDetail + 1 + i,
          transId,
          context: 'SH', // legacy convention: detail rows keep the ORDER context
          ordDetailId: b.line.id,
          itemId: b.line.itemId,
          qty: b.qty,
          price: b.line.price,
          unit: b.line.entityUnit ?? (b.line.itemId != null ? unitByItem.get(b.line.itemId) ?? null : null),
        })),
      });

      const subtotal = billable.reduce((s, b) => s + b.qty * num(b.line.price), 0);
      await this.audit.record(
        {
          action: 'invoice.generate',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.invoice',
          summary:
            `Invoice ${transDocument} generated for shipping order #${order.id} — ` +
            `${billable.length} line(s), subtotal ${subtotal.toFixed(2)}, tax ${(taxes.taxes[0] + taxes.taxes[1] + taxes.taxes[2]).toFixed(2)}` +
            (freight ? `, freight ${freight.toFixed(2)}` : ''),
          changes: [
            { tableName: 'Trans', recordId: String(transId), fieldName: 'TransDocument', oldValue: null, newValue: transDocument },
            ...billable.map((b, i) => ({
              tableName: 'TransDetail',
              recordId: String(maxDetail + 1 + i), // the CREATED detail row
              fieldName: 'Qty',
              oldValue: null,
              newValue: `${b.qty} (order line ${b.line.id})`,
            })),
          ],
        },
        tx,
      );

      return { id: transId, invoiceNumber: transDocument, lines: billable.length, subtotal, taxes: taxes.taxes, freight };
    });
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
}
