import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../auth/current-user.decorator';
import { buildList } from '../../common/list';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateEntityDto, EntityListQuery, UpdateEntityDto } from './entities.dto';

const SORTABLE = ['entityCode', 'createdAt', 'customerType', 'group'];
const ROLE_FLAG: Record<string, string> = {
  supplier: 'isSupplier',
  manufacturer: 'isManufacturer',
  customer: 'isBillTo',
  shipto: 'isShipTo',
  salesman: 'isSalesman',
  shipvia: 'isShipVia',
  warehouse: 'isWarehouse',
  lab: 'isLab',
};

@Injectable()
export class EntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: EntityListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { entityCode: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      where.OR = [
        { entityCode: { contains: query.q, mode: 'insensitive' } },
        { theirCode: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.role && ROLE_FLAG[query.role]) {
      where[ROLE_FLAG[query.role]] = true;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.entity.findMany({ where, skip, take, orderBy }),
      this.prisma.entity.count({ where }),
    ]);
    const names = await this.primaryNames(rows.map((r) => r.id));
    return {
      rows: rows.map((r) => ({ ...r, name: names[r.id] ?? null })),
      total,
      page,
      pageSize,
    };
  }

  async get(id: number) {
    const entity = await this.prisma.entity.findUnique({ where: { id } });
    if (!entity) throw new NotFoundException('Entity not found');
    return { ...entity, addresses: await this.addressesFor(id) };
  }

  async create(dto: CreateEntityDto, actor: Actor) {
    const exists = await this.prisma.entity.findUnique({ where: { entityCode: dto.entityCode } });
    if (exists) throw new BadRequestException('Entity code already exists');

    const entity = await this.prisma.$transaction(async (tx) => {
      const e = await tx.entity.create({
        data: {
          entityCode: dto.entityCode,
          isSupplier: dto.isSupplier ?? false,
          isManufacturer: dto.isManufacturer ?? false,
          isBillTo: dto.isBillTo ?? false,
          isShipTo: dto.isShipTo ?? false,
          isSalesman: dto.isSalesman ?? false,
          isShipVia: dto.isShipVia ?? false,
          isWarehouse: dto.isWarehouse ?? false,
          isLab: dto.isLab ?? false,
          currency: dto.currency,
          terms: dto.terms,
          customerType: dto.customerType,
          isDivision: false,
          context: '',
        },
      });
      if (dto.name) {
        const addr = await tx.address.create({ data: { name: dto.name } });
        await tx.addressReference.create({
          data: { address: addr.id, tableName: 'Entity', tableId: e.id, reference: 'Main' },
        });
      }
      await this.audit.record(
        {
          action: 'entity.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.entities',
          summary: `Created entity ${e.entityCode}`,
          changes: [
            { tableName: 'Entity', recordId: String(e.id), fieldName: 'entityCode', oldValue: null, newValue: e.entityCode },
          ],
        },
        tx,
      );
      return e;
    });
    return { id: entity.id, entityCode: entity.entityCode };
  }

  async update(id: number, dto: UpdateEntityDto, actor: Actor) {
    const existing = await this.prisma.entity.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Entity not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const e = await tx.entity.update({ where: { id }, data: { ...dto } });
      await this.audit.record(
        {
          action: 'entity.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.entities',
          summary: `Updated entity ${e.entityCode}`,
          // Only record fields that actually changed — the edit form sends every
          // role flag each time, so logging all keys would be pure noise.
          changes: Object.keys(dto)
            .map((k) => ({
              tableName: 'Entity',
              recordId: String(id),
              fieldName: k,
              oldValue: String((existing as Record<string, unknown>)[k] ?? ''),
              newValue: String((dto as Record<string, unknown>)[k] ?? ''),
            }))
            .filter((c) => c.oldValue !== c.newValue),
        },
        tx,
      );
      return e;
    });
    return { id: updated.id, entityCode: updated.entityCode };
  }

  private async primaryNames(ids: number[]): Promise<Record<number, string>> {
    if (!ids.length) return {};
    const refs = await this.prisma.addressReference.findMany({
      where: { tableName: 'Entity', tableId: { in: ids } },
    });
    const pick = new Map<number, number>(); // entityId -> addressId (prefer "Main")
    for (const r of refs) {
      if (!pick.has(r.tableId) || r.reference?.toLowerCase() === 'main') pick.set(r.tableId, r.address);
    }
    const addrIds = [...new Set(pick.values())];
    if (!addrIds.length) return {};
    const addrs = await this.prisma.address.findMany({
      where: { id: { in: addrIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(addrs.map((a) => [a.id, a.name]));
    const out: Record<number, string> = {};
    for (const [eid, aid] of pick) {
      const n = nameById.get(aid);
      if (n) out[eid] = n;
    }
    return out;
  }

  private async addressesFor(id: number) {
    const refs = await this.prisma.addressReference.findMany({
      where: { tableName: 'Entity', tableId: id },
    });
    if (!refs.length) return [];
    const addrs = await this.prisma.address.findMany({ where: { id: { in: refs.map((r) => r.address) } } });
    const byId = new Map(addrs.map((a) => [a.id, a]));
    return refs.map((r) => ({ reference: r.reference, ...byId.get(r.address) }));
  }
}
