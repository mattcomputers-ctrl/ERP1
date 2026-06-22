import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { tierPrice } from '../purchasing/price-tiers';
import { PartyService } from './party.service';
import type {
  AssignCustomerDto,
  CreatePriceDetailDto,
  CreatePriceListDto,
  CreatePriceVersionDto,
  UpdatePriceDetailDto,
} from './dto/price-list.dto';

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

// The detail columns the editor writes (shared by create + update).
const DETAIL_FIELDS = [
  'entityItemCode', 'description', 'currency', 'pkgTypeId', 'entityQuantity', 'entityUnit',
  'priceByPackage', 'minOrder1', 'price1', 'minOrder2', 'price2', 'minOrder3', 'price3',
  'minOrder4', 'price4', 'minOrder5', 'price5', 'leadTime',
] as const;

export interface SalesPriceSourcing {
  priceListId: number;
  priceVersionId: number;
  priceDetailId: number;
  pkgTypeId: number | null;
  pkgTypeCode: string | null;
  entityQuantity: number | null;
  entityUnit: string | null;
  priceByPackage: boolean;
  price: number | null;
}

/**
 * Sales price lists (master data): a price list is an Entity flagged
 * `IsPriceList`; customers reference it via `Entity.PriceList`. It owns
 * effective-dated `PriceVersion`s, each carrying per-item `PriceDetail`s — the
 * same base tables purchasing uses, differing only in who owns the version.
 * This is the read+write editor; sales-order price sourcing builds on
 * `priceForCustomer` (mirrors the purchasing line-sourcing path).
 *
 * Natively-created rows (price-list Entity + its Address, PriceVersion,
 * PriceDetail) take ids ≥ NATIVE_ID_BASE under the shared id-allocation lock so a
 * later legacy import can't clobber them. Every mutation is atomically audited.
 */
@Injectable()
export class SalesPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
  ) {}

  // --- reads ---------------------------------------------------------------

  /** The price list's current version: latest EffectiveDate ≤ now (undated and
   * future-dated versions excluded). Ties broken by version then id, descending. */
  async effectiveVersion(priceListId: number, at: Date = new Date()) {
    return this.prisma.priceVersion.findFirst({
      where: { entityId: priceListId, effectiveDate: { lte: at } },
      orderBy: [{ effectiveDate: 'desc' }, { version: 'desc' }, { id: 'desc' }],
      select: { id: true, effectiveDate: true, version: true },
    });
  }

  /** Browse all price lists (entities flagged IsPriceList), with name + counts. */
  async list(query: ListQuery) {
    const { skip, take, page, pageSize } = buildList(query, { sortable: ['id'], defaultSort: { id: 'asc' } });
    const where = { isPriceList: true };
    const [lists, total] = await this.prisma.$transaction([
      this.prisma.entity.findMany({ where, skip, take, orderBy: { id: 'asc' }, select: { id: true, entityCode: true, inactive: true } }),
      this.prisma.entity.count({ where }),
    ]);
    const parties = await this.party.resolve(lists.map((l) => l.id));
    const rows = await Promise.all(
      lists.map(async (l) => {
        const v = await this.effectiveVersion(l.id);
        const [versions, customers] = await this.prisma.$transaction([
          this.prisma.priceVersion.count({ where: { entityId: l.id } }),
          this.prisma.entity.count({ where: { priceListId: l.id } }),
        ]);
        const effectiveDetails = v ? await this.prisma.priceDetail.count({ where: { priceVersionId: v.id } }) : 0;
        return {
          id: l.id,
          code: l.entityCode,
          name: parties.get(l.id)?.name ?? l.entityCode,
          inactive: l.inactive ?? false,
          versions,
          customers,
          effectiveDate: v?.effectiveDate ?? null,
          effectiveDetails,
        };
      }),
    );
    return { rows, total, page, pageSize };
  }

  /** A price list's full detail: name, all versions, the effective version's
   * priced details, and the customers assigned to it. */
  async get(id: number) {
    const list = await this.prisma.entity.findUnique({ where: { id }, select: { id: true, entityCode: true, isPriceList: true } });
    if (!list || !list.isPriceList) throw new NotFoundException('Price list not found');

    const [versions, customers] = await this.prisma.$transaction([
      this.prisma.priceVersion.findMany({ where: { entityId: id }, orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }], select: { id: true, effectiveDate: true, version: true, comment: true } }),
      this.prisma.entity.findMany({ where: { priceListId: id }, select: { id: true, entityCode: true } }),
    ]);
    const effective = await this.effectiveVersion(id);
    const details = effective ? await this.detailsForVersion(effective.id) : [];

    const parties = await this.party.resolve([id, ...customers.map((c) => c.id)]);
    return {
      id,
      code: list.entityCode,
      name: parties.get(id)?.name ?? list.entityCode,
      effectiveVersionId: effective?.id ?? null,
      versions: versions.map((v) => ({ id: v.id, effectiveDate: v.effectiveDate, version: v.version, comment: v.comment })),
      details,
      customers: customers.map((c) => ({ id: c.id, code: c.entityCode, name: parties.get(c.id)?.name ?? c.entityCode })),
    };
  }

  /** The priced details of a version, decorated with item + package codes. */
  private async detailsForVersion(priceVersionId: number) {
    const details = await this.prisma.priceDetail.findMany({ where: { priceVersionId }, orderBy: { id: 'asc' } });
    const itemIds = [...new Set(details.flatMap((d) => [d.invItemId ?? d.itemId, d.pkgTypeId]).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true, unit: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    return details.map((d) => {
      const stockId = d.invItemId ?? d.itemId;
      const item = stockId != null ? itemById.get(stockId) : undefined;
      return {
        id: d.id,
        invItemId: stockId,
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? d.description ?? null,
        unit: item?.unit ?? null,
        theirCode: d.entityItemCode,
        packageTypeId: d.pkgTypeId,
        packageType: d.pkgTypeId != null ? itemById.get(d.pkgTypeId)?.itemCode ?? null : null,
        perPackageQty: d.entityQuantity,
        perPackageUnit: d.entityUnit,
        priceByPackage: d.priceByPackage ?? false,
        tiers: [
          { minOrder: d.minOrder1, price: numOrNull(d.price1) },
          { minOrder: d.minOrder2, price: numOrNull(d.price2) },
          { minOrder: d.minOrder3, price: numOrNull(d.price3) },
          { minOrder: d.minOrder4, price: numOrNull(d.price4) },
          { minOrder: d.minOrder5, price: numOrNull(d.price5) },
        ].filter((t) => t.price != null),
        leadTime: d.leadTime,
      };
    });
  }

  /**
   * Resolve a customer's sales price + packaging for an item (price tiered by
   * qty), via the customer's assigned price list → effective version → detail.
   * Returns null when the customer has no price list or no detail for the item —
   * the caller then falls back (e.g. Item.salesPrice). Mirrors the purchasing
   * line-sourcing path.
   */
  async priceForCustomer(customerId: number, itemId: number, qty: number, at: Date = new Date()): Promise<SalesPriceSourcing | null> {
    const customer = await this.prisma.entity.findUnique({ where: { id: customerId }, select: { priceListId: true } });
    if (!customer?.priceListId) return null;
    const version = await this.effectiveVersion(customer.priceListId, at);
    if (!version) return null;
    // The view joins details on InvItem (the stock item); fall back to Item for
    // legacy rows where InvItem isn't populated. Lowest id is deterministic.
    const pd = await this.prisma.priceDetail.findFirst({
      where: { priceVersionId: version.id, OR: [{ invItemId: itemId }, { invItemId: null, itemId }] },
      orderBy: { id: 'asc' },
    });
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
      priceListId: customer.priceListId,
      priceVersionId: version.id,
      priceDetailId: pd.id,
      pkgTypeId: pd.pkgTypeId,
      pkgTypeCode: pkgType?.itemCode ?? null,
      entityQuantity: pd.entityQuantity,
      entityUnit: pd.entityUnit,
      priceByPackage: pd.priceByPackage ?? false,
      price,
    };
  }

  /** Item picker for the detail editor. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    const where = term
      ? { OR: [{ itemCode: { contains: term, mode: 'insensitive' as const } }, { description: { contains: term, mode: 'insensitive' as const } }] }
      : {};
    const rows = await this.prisma.item.findMany({ where, take: 25, orderBy: { itemCode: 'asc' }, select: { id: true, itemCode: true, description: true, unit: true } });
    return { rows };
  }

  /** Customer picker for assigning a price list. */
  async customerOptions(q?: string) {
    const term = q?.trim();
    const base = { OR: [{ isBillTo: true }, { isShipTo: true }] };
    const where = term ? { AND: [base, { entityCode: { contains: term, mode: 'insensitive' as const } }] } : base;
    const rows = await this.prisma.entity.findMany({ where, take: 25, orderBy: { entityCode: 'asc' }, select: { id: true, entityCode: true } });
    const parties = await this.party.resolve(rows.map((r) => r.id));
    return { rows: rows.map((r) => ({ id: r.id, code: r.entityCode, name: parties.get(r.id)?.name ?? r.entityCode })) };
  }

  // --- writes (native ids ≥ NATIVE_ID_BASE, atomic audit) ------------------

  /** Create a price list: a native Entity (IsPriceList) + its Address (the name) +
   * the AddressReference linking them. */
  async createPriceList(dto: CreatePriceListDto, actor: Actor) {
    if (dto.code) {
      const clash = await this.prisma.entity.findUnique({ where: { entityCode: dto.code }, select: { id: true } });
      if (clash) throw new BadRequestException(`Entity code "${dto.code}" is already in use.`);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const nativeWhere = { id: { gte: NATIVE_ID_BASE } };
      const entityId = ((await tx.entity.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE) + 1;
      const addressId = ((await tx.address.aggregate({ _max: { id: true }, where: nativeWhere }))._max.id ?? NATIVE_ID_BASE) + 1;
      const code = dto.code ?? `PL${entityId}`;

      await tx.address.create({ data: { id: addressId, name: dto.name } });
      await tx.entity.create({ data: { id: entityId, entityCode: code, isPriceList: true } });
      await tx.addressReference.create({ data: { address: addressId, tableId: entityId, tableName: 'Entity', reference: 'Address' } });

      await this.audit.record(
        {
          action: 'pricelist.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Sales price list "${dto.name}" (${code}) created`,
          changes: [
            { tableName: 'Entity', recordId: String(entityId), fieldName: 'IsPriceList', oldValue: null, newValue: 'true' },
            { tableName: 'Address', recordId: String(addressId), fieldName: 'Name', oldValue: null, newValue: dto.name },
          ],
        },
        tx,
      );
      return { id: entityId, code, name: dto.name };
    });
  }

  /** Add an effective-dated version to a price list. */
  async createPriceVersion(priceListId: number, dto: CreatePriceVersionDto, actor: Actor) {
    const list = await this.prisma.entity.findUnique({ where: { id: priceListId }, select: { id: true, isPriceList: true } });
    if (!list || !list.isPriceList) throw new NotFoundException('Price list not found');

    const effectiveDate = new Date(dto.effectiveDate);
    if (Number.isNaN(effectiveDate.getTime())) throw new BadRequestException('effectiveDate is not a valid date');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const id = ((await tx.priceVersion.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const version = dto.version ?? (((await tx.priceVersion.aggregate({ _max: { version: true }, where: { entityId: priceListId } }))._max.version ?? 0) + 1);
      await tx.priceVersion.create({ data: { id, entityId: priceListId, effectiveDate, version, comment: dto.comment ?? null } });
      await this.audit.record(
        {
          action: 'pricelist.version.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Price version #${id} (v${version}, effective ${effectiveDate.toISOString().slice(0, 10)}) added to price list ${priceListId}`,
          changes: [{ tableName: 'PriceVersion', recordId: String(id), fieldName: 'Entity', oldValue: null, newValue: String(priceListId) }],
        },
        tx,
      );
      return { id, version, effectiveDate };
    });
  }

  /** Add a priced detail to a version (IDOR-safe: the version must belong to the list). */
  async addPriceDetail(priceListId: number, priceVersionId: number, dto: CreatePriceDetailDto, actor: Actor) {
    await this.assertVersionOnList(priceListId, priceVersionId);
    await this.assertDetailRefs(dto);
    // Packaging fields are meaningless without a package type — reject the
    // inconsistent combination rather than persist a stray unit/qty that the
    // editor hides but price resolution would still surface.
    if (dto.pkgTypeId == null && (dto.entityQuantity != null || dto.entityUnit != null || dto.priceByPackage)) {
      throw new BadRequestException('Packaging fields (qty / unit / price-by-package) require a package type.');
    }
    // One priced detail per item per version: a duplicate is a dead, shadowed
    // row (resolution takes the lowest id), so reject it with a clear message.
    const dup = await this.prisma.priceDetail.findFirst({
      where: { priceVersionId, OR: [{ invItemId: dto.invItemId }, { invItemId: null, itemId: dto.invItemId }] },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('That item is already priced in this version.');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const id = ((await tx.priceDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.priceDetail.create({
        data: {
          id,
          priceVersionId,
          // Native sales details carry no name-alias, so Item == InvItem (matches
          // legacy, where they're equal in 99.9% of rows).
          itemId: dto.invItemId,
          invItemId: dto.invItemId,
          ...this.detailData(dto),
        },
      });
      await this.audit.record(
        {
          action: 'pricelist.detail.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Price detail #${id} (item ${dto.invItemId}) added to version ${priceVersionId}`,
          changes: [{ tableName: 'PriceDetail', recordId: String(id), fieldName: 'InvItem', oldValue: null, newValue: String(dto.invItemId) }],
        },
        tx,
      );
      return { id };
    });
  }

  /** Edit a detail (IDOR-safe). */
  async updatePriceDetail(priceListId: number, priceDetailId: number, dto: UpdatePriceDetailDto, actor: Actor) {
    const existing = await this.assertDetailOnList(priceListId, priceDetailId);
    await this.assertDetailRefs(dto);
    const data = {
      ...this.detailData(dto),
      ...(dto.invItemId != null ? { invItemId: dto.invItemId, itemId: dto.invItemId } : {}),
    };
    // Nothing to change → don't write or audit a misleading no-op.
    if (Object.keys(data).length === 0) return { id: priceDetailId, unchanged: true };
    return this.prisma.$transaction(async (tx) => {
      await tx.priceDetail.update({ where: { id: priceDetailId }, data });
      await this.audit.record(
        {
          action: 'pricelist.detail.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Price detail #${priceDetailId} (version ${existing.priceVersionId}) updated`,
        },
        tx,
      );
      return { id: priceDetailId };
    });
  }

  /** Delete a detail (IDOR-safe). */
  async deletePriceDetail(priceListId: number, priceDetailId: number, actor: Actor) {
    await this.assertDetailOnList(priceListId, priceDetailId);
    return this.prisma.$transaction(async (tx) => {
      await tx.priceDetail.delete({ where: { id: priceDetailId } });
      await this.audit.record(
        {
          action: 'pricelist.detail.delete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Price detail #${priceDetailId} deleted from price list ${priceListId}`,
        },
        tx,
      );
      return { id: priceDetailId, deleted: true };
    });
  }

  /** Put a customer on this price list (sets Entity.PriceList). */
  async assignCustomer(priceListId: number, dto: AssignCustomerDto, actor: Actor) {
    const list = await this.prisma.entity.findUnique({ where: { id: priceListId }, select: { isPriceList: true } });
    if (!list || !list.isPriceList) throw new NotFoundException('Price list not found');
    const customer = await this.prisma.entity.findUnique({ where: { id: dto.customerId }, select: { id: true, entityCode: true, isBillTo: true, isShipTo: true, priceListId: true } });
    if (!customer) throw new BadRequestException('Customer not found');
    if (!customer.isBillTo && !customer.isShipTo) throw new BadRequestException(`Entity ${customer.entityCode} is not a customer (bill-to/ship-to).`);

    return this.prisma.$transaction(async (tx) => {
      await tx.entity.update({ where: { id: customer.id }, data: { priceListId } });
      await this.audit.record(
        {
          action: 'pricelist.customer.assign',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Customer ${customer.entityCode} assigned to price list ${priceListId}`,
          changes: [{ tableName: 'Entity', recordId: String(customer.id), fieldName: 'PriceList', oldValue: customer.priceListId != null ? String(customer.priceListId) : null, newValue: String(priceListId) }],
        },
        tx,
      );
      return { customerId: customer.id, priceListId };
    });
  }

  /** Remove a customer from this price list (clears Entity.PriceList; only if it
   * currently points here, so we never silently detach a different list). */
  async unassignCustomer(priceListId: number, customerId: number, actor: Actor) {
    const customer = await this.prisma.entity.findUnique({ where: { id: customerId }, select: { id: true, entityCode: true, priceListId: true } });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.priceListId !== priceListId) throw new BadRequestException('That customer is not on this price list.');

    return this.prisma.$transaction(async (tx) => {
      await tx.entity.update({ where: { id: customerId }, data: { priceListId: null } });
      await this.audit.record(
        {
          action: 'pricelist.customer.unassign',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'sales.priceListEditor',
          summary: `Customer ${customer.entityCode} removed from price list ${priceListId}`,
          changes: [{ tableName: 'Entity', recordId: String(customerId), fieldName: 'PriceList', oldValue: String(priceListId), newValue: null }],
        },
        tx,
      );
      return { customerId, priceListId: null };
    });
  }

  // --- helpers -------------------------------------------------------------

  /** Pick only the editable detail columns present on the DTO (so an update
   * patches exactly what was sent and a create sets exactly what was given). */
  private detailData(dto: CreatePriceDetailDto | UpdatePriceDetailDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of DETAIL_FIELDS) {
      if ((dto as Record<string, unknown>)[f] !== undefined) out[f] = (dto as Record<string, unknown>)[f];
    }
    return out;
  }

  /** Validate the item references on a detail DTO before a write (shared by
   * create + update). pkgTypeId has no DB foreign key, so this layer is the only
   * place a dangling package-type reference can be caught. NULL refs are allowed. */
  private async assertDetailRefs(dto: { invItemId?: number | null; pkgTypeId?: number | null }) {
    if (dto.invItemId != null) {
      const item = await this.prisma.item.findUnique({ where: { id: dto.invItemId }, select: { id: true } });
      if (!item) throw new BadRequestException(`Unknown item id ${dto.invItemId}`);
    }
    if (dto.pkgTypeId != null) {
      const pkg = await this.prisma.item.findUnique({ where: { id: dto.pkgTypeId }, select: { id: true } });
      if (!pkg) throw new BadRequestException(`Unknown package-type item id ${dto.pkgTypeId}`);
    }
  }

  private async assertVersionOnList(priceListId: number, priceVersionId: number) {
    const v = await this.prisma.priceVersion.findUnique({ where: { id: priceVersionId }, select: { id: true, entityId: true } });
    if (!v || v.entityId !== priceListId) throw new NotFoundException('Price version not found on this price list');
    return v;
  }

  private async assertDetailOnList(priceListId: number, priceDetailId: number) {
    const d = await this.prisma.priceDetail.findUnique({ where: { id: priceDetailId }, select: { id: true, priceVersionId: true } });
    if (!d || d.priceVersionId == null) throw new NotFoundException('Price detail not found');
    await this.assertVersionOnList(priceListId, d.priceVersionId);
    return d;
  }
}
