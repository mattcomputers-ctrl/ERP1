import { Injectable, NotFoundException } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PartyService } from './party.service';

const num = (v: unknown) => (v == null ? 0 : Number(v));

@Injectable()
export class BillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly party: PartyService,
  ) {}

  async list(query: ListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['id', 'invoice', 'invoiceDate', 'amount'],
      defaultSort: { id: 'desc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      const q = query.q.trim();
      const or: Record<string, unknown>[] = [{ invoice: { contains: q, mode: 'insensitive' } }];
      if (/^\d+$/.test(q)) or.push({ id: Number(q) });
      where.OR = or;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bill.findMany({
        where, skip, take, orderBy,
        select: { id: true, invoice: true, invoiceDate: true, supplierId: true, amount: true, currency: true, terms: true },
      }),
      this.prisma.bill.count({ where }),
    ]);

    const parties = await this.party.resolve(rows.map((r) => r.supplierId));
    return {
      rows: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoice,
        invoiceDate: r.invoiceDate,
        supplier: r.supplierId != null ? (parties.get(r.supplierId)?.name ?? parties.get(r.supplierId)?.entityCode ?? null) : null,
        terms: r.terms,
        currency: r.currency,
        total: num(r.amount),
      })),
      total, page, pageSize,
    };
  }

  async get(id: number) {
    const bill = await this.prisma.bill.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException('Bill not found');

    const lines = await this.prisma.billDetail.findMany({
      where: { billId: id },
      orderBy: { id: 'asc' },
      select: { id: true, ordDetailId: true, receiptId: true, amount: true, addCost: true, inventoryValue: true },
    });

    const ordDetailIds = [...new Set(lines.map((l) => l.ordDetailId).filter((v): v is number => v != null))];
    const ordDetails = await this.prisma.ordDetail.findMany({
      where: { id: { in: ordDetailIds } },
      select: { id: true, itemId: true, qtyReqd: true, qtyUsed: true, entityUnit: true, description: true },
    });
    const odById = new Map(ordDetails.map((o) => [o.id, o]));
    const itemIds = [...new Set(ordDetails.map((o) => o.itemId).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const [terms, currencyRow, parties, companyName] = await Promise.all([
      bill.terms ? this.prisma.terms.findUnique({ where: { code: bill.terms }, select: { description: true } }) : Promise.resolve(null),
      bill.currency ? this.prisma.currency.findUnique({ where: { code: bill.currency }, select: { description: true } }) : Promise.resolve(null),
      this.party.resolve([bill.supplierId]),
      this.settings.get('company.name', 'Precision Ink Corporation'),
    ]);

    const docLines = lines.map((l) => {
      const od = l.ordDetailId != null ? odById.get(l.ordDetailId) : undefined;
      const item = od?.itemId != null ? itemById.get(od.itemId) : undefined;
      return {
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? od?.description ?? null,
        qty: od?.qtyUsed ?? od?.qtyReqd ?? null,
        unit: od?.entityUnit ?? null,
        amount: num(l.amount),
        addCost: num(l.addCost),
        extended: num(l.inventoryValue) || num(l.amount) + num(l.addCost),
      };
    });

    const subtotal = docLines.reduce((s, l) => s + l.amount, 0);
    const addCost = docLines.reduce((s, l) => s + l.addCost, 0);
    const tax = num(bill.tax1Amount) + num(bill.tax2Amount) + num(bill.tax3Amount);

    return {
      header: {
        billId: bill.id,
        invoiceNumber: bill.invoice,
        invoiceDate: bill.invoiceDate,
        termsText: terms?.description ?? bill.terms ?? null,
        currency: bill.currency,
        currencyLabel: currencyRow?.description ?? bill.currency,
        memo: bill.memo,
      },
      supplier: bill.supplierId != null ? parties.get(bill.supplierId) ?? null : null,
      buyer: { name: companyName },
      lines: docLines,
      totals: { subtotal, addCost, tax, total: num(bill.amount) || subtotal + addCost + tax },
    };
  }
}
