import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { buildList, type ListQuery } from '../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { PartyService } from '../sales/party.service';
import { PriceVersionService } from './price-version.service';
import type {
  CreateSupplierPriceDetailDto,
  CreateSupplierPriceVersionDto,
  UpdateSupplierPriceDetailDto,
} from './dto/price-version.dto';

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

// The detail columns the editor writes (shared by create + update).
const DETAIL_FIELDS = [
  'entityItemCode', 'description', 'currency', 'pkgTypeId', 'entityQuantity', 'entityUnit',
  'priceByPackage', 'minOrder1', 'price1', 'minOrder2', 'price2', 'minOrder3', 'price3',
  'minOrder4', 'price4', 'minOrder5', 'price5', 'leadTime', 'manufacturerId',
] as const;

/**
 * Supplier price-version editor (master data): the write counterpart of the
 * read-only Purchase Price Detail Set Viewer + PO line-sourcing. The
 * price-version-owning entity IS the supplier (PriceVersion.Entity = supplierId;
 * suppliers self-reference their price list), so — unlike the sales editor which
 * mints a price-list Entity — there is no list to create: the supplier already
 * exists. Details key off Item (not the sales InvItem), MULTIPLE details per item
 * per version are legitimate (different package sizes / manufacturers — 362 live
 * cases), and the effective-version rule is REUSED from PriceVersionService (never
 * re-derived). Natively-created versions/details take ids ≥ NATIVE_ID_BASE under
 * the shared id-allocation lock; every mutation is atomically audited.
 */
@Injectable()
export class SupplierPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly party: PartyService,
    private readonly priceVersions: PriceVersionService,
  ) {}

  // --- reads ---------------------------------------------------------------

  /** Browse suppliers with a pricing summary (versions, effective version + its
   * priced-detail count). */
  async list(query: ListQuery & { q?: string }) {
    const { skip, take, page, pageSize } = buildList(query, { sortable: ['id'], defaultSort: { id: 'asc' } });
    const term = query.q?.trim();
    const where = term
      ? { isSupplier: true, entityCode: { contains: term, mode: 'insensitive' as const } }
      : { isSupplier: true };
    const [suppliers, total] = await this.prisma.$transaction([
      this.prisma.entity.findMany({ where, skip, take, orderBy: { id: 'asc' }, select: { id: true, entityCode: true, inactive: true } }),
      this.prisma.entity.count({ where }),
    ]);
    const parties = await this.party.resolve(suppliers.map((s) => s.id));
    const rows = await Promise.all(
      suppliers.map(async (s) => {
        const v = await this.priceVersions.effectiveVersion(s.id);
        const versions = await this.prisma.priceVersion.count({ where: { entityId: s.id } });
        const effective = v ? await this.prisma.priceVersion.findUnique({ where: { id: v.id }, select: { effectiveDate: true } }) : null;
        const effectiveDetails = v ? await this.prisma.priceDetail.count({ where: { priceVersionId: v.id } }) : 0;
        return {
          id: s.id,
          code: s.entityCode,
          name: parties.get(s.id)?.name ?? s.entityCode,
          inactive: s.inactive ?? false,
          versions,
          effectiveDate: effective?.effectiveDate ?? null,
          effectiveDetails,
        };
      }),
    );
    return { rows, total, page, pageSize };
  }

  /** A supplier's pricing detail: name, all versions, the effective version's
   * priced details. */
  async get(supplierId: number) {
    const supplier = await this.prisma.entity.findUnique({ where: { id: supplierId }, select: { id: true, entityCode: true, isSupplier: true } });
    if (!supplier || !supplier.isSupplier) throw new NotFoundException('Supplier not found');

    const versions = await this.prisma.priceVersion.findMany({
      where: { entityId: supplierId },
      orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
      select: { id: true, effectiveDate: true, version: true, comment: true },
    });
    const effective = await this.priceVersions.effectiveVersion(supplierId);
    const details = effective ? await this.detailsForVersion(effective.id) : [];
    const parties = await this.party.resolve([supplierId]);

    return {
      id: supplierId,
      code: supplier.entityCode,
      name: parties.get(supplierId)?.name ?? supplier.entityCode,
      effectiveVersionId: effective?.id ?? null,
      versions,
      details,
    };
  }

  /** The priced details of a version, decorated with item + package + manufacturer. */
  private async detailsForVersion(priceVersionId: number) {
    const details = await this.prisma.priceDetail.findMany({ where: { priceVersionId }, orderBy: { id: 'asc' } });
    const itemIds = [...new Set(details.flatMap((d) => [d.itemId, d.pkgTypeId]).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, description: true, unit: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const mfrIds = [...new Set(details.map((d) => d.manufacturerId).filter((v): v is number => v != null))];
    const mfrs = mfrIds.length ? await this.party.resolve(mfrIds) : new Map();

    return details.map((d) => {
      const item = d.itemId != null ? itemById.get(d.itemId) : undefined;
      return {
        id: d.id,
        itemId: d.itemId,
        itemCode: item?.itemCode ?? null,
        description: item?.description ?? d.description ?? null,
        unit: item?.unit ?? null,
        theirCode: d.entityItemCode,
        packageTypeId: d.pkgTypeId,
        packageType: d.pkgTypeId != null ? itemById.get(d.pkgTypeId)?.itemCode ?? null : null,
        perPackageQty: d.entityQuantity,
        perPackageUnit: d.entityUnit,
        priceByPackage: d.priceByPackage ?? false,
        manufacturerId: d.manufacturerId,
        manufacturer: d.manufacturerId != null ? mfrs.get(d.manufacturerId)?.name ?? null : null,
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

  /** Item picker for the detail editor. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    const where = term
      ? { OR: [{ itemCode: { contains: term, mode: 'insensitive' as const } }, { description: { contains: term, mode: 'insensitive' as const } }] }
      : {};
    const rows = await this.prisma.item.findMany({ where, take: 25, orderBy: { itemCode: 'asc' }, select: { id: true, itemCode: true, description: true, unit: true } });
    return { rows };
  }

  /** Supplier picker for choosing which supplier to price. */
  async supplierOptions(q?: string) {
    const term = q?.trim();
    const where = term
      ? { isSupplier: true, entityCode: { contains: term, mode: 'insensitive' as const } }
      : { isSupplier: true };
    const rows = await this.prisma.entity.findMany({ where, take: 25, orderBy: { entityCode: 'asc' }, select: { id: true, entityCode: true } });
    const parties = await this.party.resolve(rows.map((r) => r.id));
    return { rows: rows.map((r) => ({ id: r.id, code: r.entityCode, name: parties.get(r.id)?.name ?? r.entityCode })) };
  }

  /** Manufacturer picker for the optional manufacturer pin. */
  async manufacturerOptions(q?: string) {
    const term = q?.trim();
    const where = term
      ? { isManufacturer: true, entityCode: { contains: term, mode: 'insensitive' as const } }
      : { isManufacturer: true };
    const rows = await this.prisma.entity.findMany({ where, take: 25, orderBy: { entityCode: 'asc' }, select: { id: true, entityCode: true } });
    const parties = await this.party.resolve(rows.map((r) => r.id));
    return { rows: rows.map((r) => ({ id: r.id, code: r.entityCode, name: parties.get(r.id)?.name ?? r.entityCode })) };
  }

  // --- writes (native ids ≥ NATIVE_ID_BASE, atomic audit) ------------------

  /** Add an effective-dated version to a supplier. */
  async createVersion(supplierId: number, dto: CreateSupplierPriceVersionDto, actor: Actor) {
    await this.assertSupplier(supplierId);
    const effectiveDate = new Date(dto.effectiveDate);
    if (Number.isNaN(effectiveDate.getTime())) throw new BadRequestException('effectiveDate is not a valid date');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const id = ((await tx.priceVersion.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const version = dto.version ?? (((await tx.priceVersion.aggregate({ _max: { version: true }, where: { entityId: supplierId } }))._max.version ?? 0) + 1);
      await tx.priceVersion.create({ data: { id, entityId: supplierId, effectiveDate, version, comment: dto.comment ?? null } });
      await this.audit.record(
        {
          action: 'supplier.pricing.version.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.priceVersionEditor',
          summary: `Price version #${id} (v${version}, effective ${effectiveDate.toISOString().slice(0, 10)}) added to supplier ${supplierId}`,
          changes: [{ tableName: 'PriceVersion', recordId: String(id), fieldName: 'Entity', oldValue: null, newValue: String(supplierId) }],
        },
        tx,
      );
      return { id, version, effectiveDate };
    });
  }

  /** Add a priced detail to a version (IDOR-safe: the version must belong to the
   * supplier). Multiple details per item are allowed; only an EXACT
   * (item + package type + manufacturer) duplicate — a dead shadowed row — is refused. */
  async addDetail(supplierId: number, priceVersionId: number, dto: CreateSupplierPriceDetailDto, actor: Actor) {
    await this.assertVersionOnSupplier(supplierId, priceVersionId);
    await this.assertDetailRefs(dto);
    if (dto.pkgTypeId == null && (dto.entityQuantity != null || dto.entityUnit != null || dto.priceByPackage)) {
      throw new BadRequestException('Packaging fields (qty / unit / price-by-package) require a package type.');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-check for an exact shadowed duplicate INSIDE the locked tx (no DB
      // constraint backs it). null pkg/manufacturer are part of the identity.
      const dup = await tx.priceDetail.findFirst({
        where: { priceVersionId, itemId: dto.itemId, pkgTypeId: dto.pkgTypeId ?? null, manufacturerId: dto.manufacturerId ?? null },
        select: { id: true },
      });
      if (dup) throw new BadRequestException('That exact item + package + manufacturer is already priced in this version.');
      const id = ((await tx.priceDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.priceDetail.create({
        data: {
          id,
          priceVersionId,
          // Purchase details key off Item (there is no name-alias split here).
          itemId: dto.itemId,
          ...this.detailData(dto),
        },
      });
      await this.audit.record(
        {
          action: 'supplier.pricing.detail.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.priceVersionEditor',
          summary: `Price detail #${id} (item ${dto.itemId}) added to version ${priceVersionId}`,
          changes: [{ tableName: 'PriceDetail', recordId: String(id), fieldName: 'Item', oldValue: null, newValue: String(dto.itemId) }],
        },
        tx,
      );
      return { id };
    });
  }

  /** Edit a detail (IDOR-safe). Re-asserts BOTH write invariants against the
   * MERGED (post-update) row inside the locked tx: packaging is all-or-nothing
   * (clearing/omitting the package type while qty/unit/price-by-package remain
   * would let the by-package trap divide the price at valuation), and the exact
   * (item + package + manufacturer) identity must stay unique in the version
   * (re-pointing must not create the shadowed duplicate addDetail refuses). */
  async updateDetail(supplierId: number, priceDetailId: number, dto: UpdateSupplierPriceDetailDto, actor: Actor) {
    await this.assertDetailOnSupplier(supplierId, priceDetailId);
    await this.assertDetailRefs(dto);
    const data = {
      ...this.detailData(dto),
      ...(dto.itemId != null ? { itemId: dto.itemId } : {}),
    };
    if (Object.keys(data).length === 0) return { id: priceDetailId, unchanged: true };
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const existing = await tx.priceDetail.findUnique({ where: { id: priceDetailId } });
      if (!existing || existing.priceVersionId == null) throw new NotFoundException('Price detail not found');
      // Effective (post-update) fields: the DTO value when present, else the current.
      const effPkg = dto.pkgTypeId !== undefined ? dto.pkgTypeId : existing.pkgTypeId;
      const effQty = dto.entityQuantity !== undefined ? dto.entityQuantity : existing.entityQuantity;
      const effUnit = dto.entityUnit !== undefined ? dto.entityUnit : existing.entityUnit;
      const effByPkg = dto.priceByPackage !== undefined ? dto.priceByPackage : existing.priceByPackage;
      if (effPkg == null && (effQty != null || effUnit != null || effByPkg)) {
        throw new BadRequestException('Packaging fields (qty / unit / price-by-package) require a package type.');
      }
      const effItem = dto.itemId !== undefined ? dto.itemId : existing.itemId;
      const effMfr = dto.manufacturerId !== undefined ? dto.manufacturerId : existing.manufacturerId;
      const clash = await tx.priceDetail.findFirst({
        where: { priceVersionId: existing.priceVersionId, id: { not: priceDetailId }, itemId: effItem, pkgTypeId: effPkg ?? null, manufacturerId: effMfr ?? null },
        select: { id: true },
      });
      if (clash) throw new BadRequestException('That exact item + package + manufacturer is already priced in this version.');

      await tx.priceDetail.update({ where: { id: priceDetailId }, data });
      await this.audit.record(
        {
          action: 'supplier.pricing.detail.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.priceVersionEditor',
          summary: `Price detail #${priceDetailId} (version ${existing.priceVersionId}) updated`,
        },
        tx,
      );
      return { id: priceDetailId };
    });
  }

  /** Delete a detail (IDOR-safe). */
  async deleteDetail(supplierId: number, priceDetailId: number, actor: Actor) {
    await this.assertDetailOnSupplier(supplierId, priceDetailId);
    return this.prisma.$transaction(async (tx) => {
      await tx.priceDetail.delete({ where: { id: priceDetailId } });
      await this.audit.record(
        {
          action: 'supplier.pricing.detail.delete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'purchasing.priceVersionEditor',
          summary: `Price detail #${priceDetailId} deleted from supplier ${supplierId}`,
        },
        tx,
      );
      return { id: priceDetailId, deleted: true };
    });
  }

  // --- helpers -------------------------------------------------------------

  /** Pick only the editable detail columns present on the DTO. */
  private detailData(dto: CreateSupplierPriceDetailDto | UpdateSupplierPriceDetailDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of DETAIL_FIELDS) {
      if ((dto as Record<string, unknown>)[f] !== undefined) out[f] = (dto as Record<string, unknown>)[f];
    }
    return out;
  }

  /** Validate item / package-type / manufacturer references before a write
   * (no DB foreign keys, so this layer catches dangling references). */
  private async assertDetailRefs(dto: { itemId?: number | null; pkgTypeId?: number | null; manufacturerId?: number | null }) {
    if (dto.itemId != null) {
      const item = await this.prisma.item.findUnique({ where: { id: dto.itemId }, select: { id: true } });
      if (!item) throw new BadRequestException(`Unknown item id ${dto.itemId}`);
    }
    if (dto.pkgTypeId != null) {
      const pkg = await this.prisma.item.findUnique({ where: { id: dto.pkgTypeId }, select: { id: true } });
      if (!pkg) throw new BadRequestException(`Unknown package-type item id ${dto.pkgTypeId}`);
    }
    if (dto.manufacturerId != null) {
      const mfr = await this.prisma.entity.findUnique({ where: { id: dto.manufacturerId }, select: { id: true, isManufacturer: true } });
      if (!mfr || !mfr.isManufacturer) throw new BadRequestException(`Unknown manufacturer id ${dto.manufacturerId}`);
    }
  }

  private async assertSupplier(supplierId: number) {
    const s = await this.prisma.entity.findUnique({ where: { id: supplierId }, select: { id: true, isSupplier: true } });
    if (!s || !s.isSupplier) throw new NotFoundException('Supplier not found');
  }

  private async assertVersionOnSupplier(supplierId: number, priceVersionId: number) {
    const v = await this.prisma.priceVersion.findUnique({ where: { id: priceVersionId }, select: { id: true, entityId: true } });
    if (!v || v.entityId !== supplierId) throw new NotFoundException('Price version not found on this supplier');
    return v;
  }

  private async assertDetailOnSupplier(supplierId: number, priceDetailId: number) {
    const d = await this.prisma.priceDetail.findUnique({ where: { id: priceDetailId }, select: { id: true, priceVersionId: true } });
    if (!d || d.priceVersionId == null) throw new NotFoundException('Price detail not found');
    await this.assertVersionOnSupplier(supplierId, d.priceVersionId);
    return d;
  }
}
