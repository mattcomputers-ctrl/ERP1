import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@erp1/db';
import { PrismaService } from '../prisma/prisma.service';
import { computeTaxes, type TaxLine, type TaxResult } from './tax-math';

export interface TaxableLine {
  itemId: number | null;
  /** Line value (qty x price) in document currency. */
  amount: number;
  qty: number;
}

/**
 * Document-level tax computation (UG §17.4.7): resolves the customer's three
 * entity tax groups and each line item's three item tax groups, then applies
 * the TaxRule table via the pure engine in tax-math.ts.
 */
@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Callers already inside a transaction MUST pass their tx client so the
   * reads share its snapshot/connection (never borrow extra pool connections
   * while row/advisory locks are held).
   */
  async forCustomer(
    billToId: number,
    lines: TaxableLine[],
    freight = 0,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<TaxResult> {
    const entity = await db.entity.findUnique({
      where: { id: billToId },
      select: { tax1Group: true, tax2Group: true, tax3Group: true },
    });
    if (!entity) throw new NotFoundException('Customer not found');

    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await db.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, tax1Group: true, tax2Group: true, tax3Group: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const missing = itemIds.filter((id) => !itemById.has(id));
    if (missing.length) throw new BadRequestException(`Unknown item id(s): ${missing.join(', ')}`);

    const rules = await db.taxRule.findMany();

    const taxLines: TaxLine[] = lines.map((l) => {
      const item = l.itemId != null ? itemById.get(l.itemId) : undefined;
      return {
        amount: l.amount,
        qty: l.qty,
        itemTaxGroups: [item?.tax1Group ?? null, item?.tax2Group ?? null, item?.tax3Group ?? null],
      };
    });

    return computeTaxes(
      rules,
      [entity.tax1Group, entity.tax2Group, entity.tax3Group],
      taxLines,
      freight,
    );
  }
}
