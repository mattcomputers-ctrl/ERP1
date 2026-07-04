import { Injectable } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { tierPrice } from './price-tiers';

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

export interface LineSourcing {
  priceVersionId: number | null;
  priceDetailId: number;
  entityItemCode: string | null;
  pkgTypeId: number | null;
  pkgTypeCode: string | null;
  entityQuantity: number | null;
  entityUnit: string | null;
  priceByPackage: boolean;
  price: number | null;
  leadTime: number | null;
}

/**
 * Purchase price versions: a supplier's effective-dated pricing (PriceVersion +
 * PriceDetail). This is where Mar-Kov configures supplier packaging + tiered
 * prices; a PO line snapshots the matching detail onto OrdDetailPricing.
 */
@Injectable()
export class PriceVersionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The supplier's current price version: the latest EffectiveDate ≤ now (legacy
   * EffectiveDate is NOT NULL, so undated versions are excluded; future-dated ones
   * too). Ties broken by version then id, descending.
   */
  async effectiveVersion(supplierId: number, at: Date = new Date()) {
    return this.prisma.priceVersion.findFirst({
      where: { entityId: supplierId, effectiveDate: { lte: at } },
      orderBy: [{ effectiveDate: 'desc' }, { version: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  }

  /**
   * The supplier's PriceDetail for an item, from its effective version — aware
   * of a required manufacturer so the priced detail is the one that QUALIFIES
   * the offer: a manufacturer-pinned line prices from the manufacturer-specific
   * detail, else the generic (no-manufacturer) one — never another
   * manufacturer's rate. An unpinned line prefers the generic detail, falling
   * back to the lowest-id row (a version may list an item under several
   * package sizes, ≈40 live cases; lowest id keeps sourcing deterministic).
   */
  async effectivePriceDetail(
    supplierId: number,
    itemId: number,
    manufacturerId: number | null = null,
    at: Date = new Date(),
  ) {
    const v = await this.effectiveVersion(supplierId, at);
    if (!v) return null;
    if (manufacturerId != null) {
      return (
        (await this.prisma.priceDetail.findFirst({
          where: { priceVersionId: v.id, itemId, manufacturerId },
          orderBy: { id: 'asc' },
        })) ??
        (await this.prisma.priceDetail.findFirst({
          where: { priceVersionId: v.id, itemId, manufacturerId: null },
          orderBy: { id: 'asc' },
        }))
      );
    }
    return (
      (await this.prisma.priceDetail.findFirst({
        where: { priceVersionId: v.id, itemId, manufacturerId: null },
        orderBy: { id: 'asc' },
      })) ??
      (await this.prisma.priceDetail.findFirst({ where: { priceVersionId: v.id, itemId }, orderBy: { id: 'asc' } }))
    );
  }

  /**
   * Resolve the supplier's price + packaging for a PO line (price tiered by qty).
   * Returns null when the supplier has no price detail for the item — the PO line
   * then carries no packaging (degrades like a legacy PO without pricing).
   */
  async lineSourcing(
    supplierId: number,
    itemId: number,
    qty: number,
    manufacturerId: number | null = null,
  ): Promise<LineSourcing | null> {
    const pd = await this.effectivePriceDetail(supplierId, itemId, manufacturerId);
    if (!pd) return null;
    const price = tierPrice(
      {
        minOrder1: pd.minOrder1, price1: numOrNull(pd.price1),
        minOrder2: pd.minOrder2, price2: numOrNull(pd.price2),
        minOrder3: pd.minOrder3, price3: numOrNull(pd.price3),
        minOrder4: pd.minOrder4, price4: numOrNull(pd.price4),
        minOrder5: pd.minOrder5, price5: numOrNull(pd.price5),
      },
      qty,
    );
    const pkgType = pd.pkgTypeId != null
      ? await this.prisma.item.findUnique({ where: { id: pd.pkgTypeId }, select: { itemCode: true } })
      : null;
    return {
      priceVersionId: pd.priceVersionId,
      priceDetailId: pd.id,
      entityItemCode: pd.entityItemCode,
      pkgTypeId: pd.pkgTypeId,
      pkgTypeCode: pkgType?.itemCode ?? null,
      entityQuantity: pd.entityQuantity,
      entityUnit: pd.entityUnit,
      priceByPackage: pd.priceByPackage ?? false,
      price,
      leadTime: pd.leadTime,
    };
  }

  /** Browse a supplier's price details (the Purchase Price Detail Set Viewer). */
  async list(supplierId: number, query: ListQuery) {
    const version = await this.effectiveVersion(supplierId);
    if (!version) return { rows: [], total: 0, page: 1, pageSize: 25 };

    const { skip, take, page, pageSize } = buildList(query, { sortable: ['itemId'], defaultSort: { itemId: 'asc' } });
    const where: Record<string, unknown> = { priceVersionId: version.id };
    const [details, total] = await this.prisma.$transaction([
      this.prisma.priceDetail.findMany({ where, skip, take, orderBy: { itemId: 'asc' } }),
      this.prisma.priceDetail.count({ where }),
    ]);

    const itemIds = [
      ...new Set(details.flatMap((d) => [d.itemId, d.pkgTypeId]).filter((v): v is number => v != null)),
    ];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    return {
      rows: details.map((d) => ({
        itemCode: d.itemId != null ? itemById.get(d.itemId)?.itemCode ?? null : null,
        description: d.itemId != null ? itemById.get(d.itemId)?.description ?? null : d.description,
        theirCode: d.entityItemCode,
        packageType: d.pkgTypeId != null ? itemById.get(d.pkgTypeId)?.itemCode ?? null : null,
        perPackageQty: d.entityQuantity,
        perPackageUnit: d.entityUnit,
        priceByPackage: d.priceByPackage ?? false,
        price: numOrNull(d.price1),
        leadTime: d.leadTime,
      })),
      total,
      page,
      pageSize,
    };
  }
}
