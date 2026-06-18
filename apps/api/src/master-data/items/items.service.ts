import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../auth/current-user.decorator';
import { buildList } from '../../common/list';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateItemDto, ItemListQuery, UpdateItemDto } from './items.dto';

const SORTABLE = ['itemCode', 'description', 'createdAt', 'status', 'context'];

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
    return { rows, total, page, pageSize };
  }

  async get(id: number) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  async create(dto: CreateItemDto, actor: Actor) {
    const exists = await this.prisma.item.findUnique({ where: { itemCode: dto.itemCode } });
    if (exists) throw new BadRequestException('Item code already exists');

    const item = await this.prisma.$transaction(async (tx) => {
      const i = await tx.item.create({
        data: {
          itemCode: dto.itemCode,
          description: dto.description,
          unit: dto.unit,
          context: dto.context ?? 'SUNDRY',
          controlledSubstance: dto.controlledSubstance ?? false,
          specificGravity: dto.specificGravity,
        },
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const i = await tx.item.update({ where: { id }, data: { ...dto } });
      await this.audit.record(
        {
          action: 'item.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.items',
          summary: `Updated item ${i.itemCode}`,
          changes: Object.keys(dto).map((k) => ({
            tableName: 'Item',
            recordId: String(id),
            fieldName: k,
            oldValue: String((existing as Record<string, unknown>)[k] ?? ''),
            newValue: String((dto as Record<string, unknown>)[k] ?? ''),
          })),
        },
        tx,
      );
      return i;
    });
    return { id: updated.id, itemCode: updated.itemCode };
  }
}
