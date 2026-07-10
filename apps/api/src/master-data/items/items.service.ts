import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../auth/current-user.decorator';
import { buildList } from '../../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../../common/locks';
import { NotificationEngineService } from '../../notifications/notification-engine.service';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateItemDto,
  CreatePackagedProductDto,
  ItemListQuery,
  UpdateItemDto,
  UpdateItemPlanningDto,
} from './items.dto';

const SORTABLE = ['itemCode', 'description', 'createdAt', 'status', 'context'];
// ItemEntity ST-row planning knobs the editor writes.
const PLANNING_FIELDS = ['minimumStock', 'leadTime', 'testingLeadTime'] as const;

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationEngineService,
  ) {}

  async list(query: ItemListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { itemCode: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      where.OR = [
        { itemCode: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.context) where.context = query.context;
    if (query.controlled === '1') where.controlledSubstance = true;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({ where, skip, take, orderBy }),
      this.prisma.item.count({ where }),
    ]);
    // Decorate NAME aliases with their target's code so the list is legible.
    const aliasTargetIds = [...new Set(rows.map((r) => r.replacedById).filter((v): v is number => v != null))];
    const targets = aliasTargetIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: aliasTargetIds } }, select: { id: true, itemCode: true } })
      : [];
    const targetCode = new Map(targets.map((t) => [t.id, t.itemCode]));
    return {
      rows: rows.map((r) => ({ ...r, replacedByCode: r.replacedById != null ? targetCode.get(r.replacedById) ?? null : null })),
      total,
      page,
      pageSize,
    };
  }

  async get(id: number) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    const replacedBy = item.replacedById != null
      ? await this.prisma.item.findUnique({ where: { id: item.replacedById }, select: { id: true, itemCode: true, description: true } })
      : null;
    return { ...item, replacedBy };
  }

  async create(dto: CreateItemDto, actor: Actor) {
    const exists = await this.prisma.item.findUnique({ where: { itemCode: dto.itemCode } });
    if (exists) throw new BadRequestException('Item code already exists');
    if (dto.replacedById != null) await this.assertAliasTarget(dto.replacedById);

    const item = await this.prisma.$transaction(async (tx) => {
      const i = await tx.item.create({
        data: {
          itemCode: dto.itemCode,
          description: dto.description,
          unit: dto.unit,
          context: dto.context ?? 'SUNDRY',
          controlledSubstance: dto.controlledSubstance ?? false,
          specificGravity: dto.specificGravity,
          replacedById: dto.replacedById ?? null,
        },
      });
      // UG §22.2.2 'New Item Notification'. Emit BEFORE the audit row
      // (native-id lock before audit-chain lock — the system-wide
      // advisory-lock order; reversed = ABBA deadlock).
      const creatorEmail = (await tx.user.findUnique({ where: { id: actor.id }, select: { email: true } }))?.email;
      await this.notifications.emit(tx, 'New Item Notification', {
        securityGroup: i.securityGroup,
        ownerId: i.ownerId,
        contextEmails: [creatorEmail],
        params: { ItemCode: i.itemCode, Description: i.description },
        links: { ItemCode: `/items?focus=${encodeURIComponent(i.itemCode)}` },
      });

      await this.audit.record(
        {
          action: 'item.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.items',
          summary: `Created item ${i.itemCode}`,
          changes: [
            { tableName: 'Item', recordId: String(i.id), fieldName: 'itemCode', oldValue: null, newValue: i.itemCode },
          ],
        },
        tx,
      );
      return i;
    });
    return { id: item.id, itemCode: item.itemCode };
  }

  async update(id: number, dto: UpdateItemDto, actor: Actor) {
    const existing = await this.prisma.item.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Item not found');
    if (dto.replacedById != null) {
      if (dto.replacedById === id) throw new BadRequestException('An item cannot alias itself');
      await this.assertAliasTarget(dto.replacedById);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const i = await tx.item.update({ where: { id }, data: { ...dto } });
      await this.audit.record(
        {
          action: 'item.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.items',
          summary: `Updated item ${i.itemCode}`,
          changes: Object.keys(dto)
            .map((k) => ({
              tableName: 'Item',
              recordId: String(id),
              fieldName: k,
              oldValue: String((existing as Record<string, unknown>)[k] ?? ''),
              newValue: String((dto as Record<string, unknown>)[k] ?? ''),
            }))
            .filter((c) => c.oldValue !== c.newValue),
        },
        tx,
      );
      return i;
    });
    return { id: updated.id, itemCode: updated.itemCode };
  }

  // --- planning knobs (ItemEntity ST row) ----------------------------------

  /** Read an item's ST-row planning knobs (min stock / lead time / testing lead
   * time). Returns nulls when the item has no ST row yet. */
  async getPlanning(id: number) {
    const item = await this.prisma.item.findUnique({ where: { id }, select: { id: true } });
    if (!item) throw new NotFoundException('Item not found');
    const st = await this.prisma.itemEntity.findFirst({
      where: { itemId: id, context: 'ST' },
      orderBy: { id: 'asc' },
      select: { id: true, minimumStock: true, leadTime: true, testingLeadTime: true },
    });
    return {
      itemId: id,
      minimumStock: st?.minimumStock ?? null,
      leadTime: st?.leadTime ?? null,
      testingLeadTime: st?.testingLeadTime ?? null,
    };
  }

  /** Upsert an item's ST-row planning knobs. Updates the existing ST row, or
   * mints a native one (id ≥ NATIVE_ID_BASE, Entity = the site owner) so the
   * planning engine — which keys min stock / lead times off ST rows — sees it. */
  async updatePlanning(id: number, dto: UpdateItemPlanningDto, actor: Actor) {
    const item = await this.prisma.item.findUnique({ where: { id }, select: { id: true, itemCode: true } });
    if (!item) throw new NotFoundException('Item not found');
    const data: Record<string, unknown> = {};
    for (const f of PLANNING_FIELDS) {
      if ((dto as Record<string, unknown>)[f] !== undefined) data[f] = (dto as Record<string, unknown>)[f];
    }
    if (Object.keys(data).length === 0) return { itemId: id, unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const existing = await tx.itemEntity.findFirst({
        where: { itemId: id, context: 'ST' },
        orderBy: { id: 'asc' },
        select: { id: true, minimumStock: true, leadTime: true, testingLeadTime: true },
      });
      let rowId: number;
      if (existing) {
        rowId = existing.id;
        await tx.itemEntity.update({ where: { id: existing.id }, data });
      } else {
        const siteOwnerId = await this.resolveSiteOwnerId(tx);
        rowId = ((await tx.itemEntity.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
        await tx.itemEntity.create({ data: { id: rowId, itemId: id, entityId: siteOwnerId, context: 'ST', inactive: false, ...data } });
      }
      await this.audit.record(
        {
          action: 'item.planning.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.items',
          summary: `Updated planning knobs for item ${item.itemCode}`,
          changes: Object.keys(data).map((k) => ({
            tableName: 'ItemEntity',
            recordId: String(rowId),
            fieldName: k,
            oldValue: existing ? String((existing as Record<string, unknown>)[k] ?? '') : '',
            newValue: String((data as Record<string, unknown>)[k] ?? ''),
          })),
        },
        tx,
      );
      return { itemId: id };
    });
  }

  // --- packaged-product binding (make a packout orderable) ------------------

  /** List an item's packaged-product bindings (bulk -> packout). */
  async listPackagedProducts(id: number) {
    const item = await this.prisma.item.findUnique({ where: { id }, select: { id: true } });
    if (!item) throw new NotFoundException('Item not found');
    const bindings = await this.prisma.itemPackagedProduct.findMany({ where: { itemId: id }, orderBy: { id: 'asc' } });
    const refIds = [...new Set(bindings.flatMap((b) => [b.packagingPrototypeId, b.packagedProductId]).filter((v): v is number => v != null))];
    const items = refIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: refIds } }, select: { id: true, itemCode: true, description: true } })
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    return {
      rows: bindings.map((b) => ({
        id: b.id,
        packagingPrototypeId: b.packagingPrototypeId,
        packagingPrototypeCode: byId.get(b.packagingPrototypeId)?.itemCode ?? null,
        packagedProductId: b.packagedProductId,
        packagedProductCode: byId.get(b.packagedProductId)?.itemCode ?? null,
        packagedProductDescription: byId.get(b.packagedProductId)?.description ?? null,
        recipeId: b.recipeId,
        inactive: b.inactive ?? false,
      })),
    };
  }

  /** Create a packaged-product binding so a new packaged product becomes
   * orderable (native id ≥ NATIVE_ID_BASE). The RMPP recipe is resolved to its
   * active revision at read time (packoutOptions), so recipeId is an optional
   * hint here. */
  async createPackagedProduct(id: number, dto: CreatePackagedProductDto, actor: Actor) {
    const item = await this.prisma.item.findUnique({ where: { id }, select: { id: true, itemCode: true } });
    if (!item) throw new NotFoundException('Item not found');
    const prototype = await this.prisma.item.findUnique({ where: { id: dto.packagingPrototypeId }, select: { id: true } });
    if (!prototype) throw new BadRequestException(`Unknown packaging prototype item id ${dto.packagingPrototypeId}`);
    const product = await this.prisma.item.findUnique({ where: { id: dto.packagedProductId }, select: { id: true } });
    if (!product) throw new BadRequestException(`Unknown packaged product item id ${dto.packagedProductId}`);
    if (dto.recipeId != null) {
      const recipe = await this.prisma.recipe.findUnique({ where: { id: dto.recipeId }, select: { id: true, context: true } });
      if (!recipe) throw new BadRequestException(`Unknown recipe id ${dto.recipeId}`);
      if (recipe.context !== 'RMPP') throw new BadRequestException('A packout recipe must be a packaging (RMPP) recipe');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-check for a duplicate binding INSIDE the locked tx (no DB unique
      // constraint backs this, so a pre-tx check is TOCTOU-racy).
      const dup = await tx.itemPackagedProduct.findFirst({
        where: { itemId: id, packagingPrototypeId: dto.packagingPrototypeId, packagedProductId: dto.packagedProductId },
        select: { id: true },
      });
      if (dup) throw new BadRequestException('That packaged-product binding already exists for this item');
      const newId = ((await tx.itemPackagedProduct.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      await tx.itemPackagedProduct.create({
        data: {
          id: newId,
          itemId: id,
          packagingPrototypeId: dto.packagingPrototypeId,
          packagedProductId: dto.packagedProductId,
          recipeId: dto.recipeId ?? null,
          qty: 1.0,
          inactive: false,
        },
      });
      await this.audit.record(
        {
          action: 'item.packagedProduct.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.items',
          summary: `Packaged-product binding #${newId} (product ${dto.packagedProductId}) added to item ${item.itemCode}`,
          changes: [{ tableName: 'ItemPackagedProduct', recordId: String(newId), fieldName: 'PackagedProduct', oldValue: null, newValue: String(dto.packagedProductId) }],
        },
        tx,
      );
      return { id: newId };
    });
  }

  // --- pickers -------------------------------------------------------------

  /** Item picker (optionally filtered by context) for the alias/prototype/
   * packaged-product selectors. */
  async itemOptions(q?: string, context?: string) {
    const term = q?.trim();
    const and: Prisma.ItemWhereInput[] = [];
    if (context) and.push({ context });
    if (term)
      and.push({ OR: [{ itemCode: { contains: term, mode: 'insensitive' } }, { description: { contains: term, mode: 'insensitive' } }] });
    const where: Prisma.ItemWhereInput = and.length ? { AND: and } : {};
    const rows = await this.prisma.item.findMany({ where, take: 25, orderBy: { itemCode: 'asc' }, select: { id: true, itemCode: true, description: true, unit: true, context: true } });
    return { rows };
  }

  // --- helpers -------------------------------------------------------------

  private async assertAliasTarget(targetId: number) {
    const target = await this.prisma.item.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) throw new BadRequestException(`Unknown alias target item id ${targetId}`);
  }

  /** The single site-owner Entity that ST rows hang off (this install has
   * exactly one; the planning engine relies on that too). */
  private async resolveSiteOwnerId(tx: Prisma.TransactionClient): Promise<number> {
    const distinct = await tx.itemEntity.findMany({
      where: { context: 'ST', entityId: { not: null } },
      distinct: ['entityId'],
      select: { entityId: true },
      take: 2,
    });
    if (distinct.length === 1 && distinct[0].entityId != null) return distinct[0].entityId;
    throw new BadRequestException('Cannot determine the site owner for planning knobs (expected exactly one ST-row site entity)');
  }
}
