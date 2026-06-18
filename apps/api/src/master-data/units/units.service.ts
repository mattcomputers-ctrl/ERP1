import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../auth/current-user.decorator';
import { buildList } from '../../common/list';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateUnitDto, UnitListQuery, UpdateUnitDto } from './units.dto';

const SORTABLE = ['code', 'description', 'category'];

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: UnitListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { code: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      where.OR = [
        { code: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.category) where.category = query.category;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.unit.findMany({ where, skip, take, orderBy }),
      this.prisma.unit.count({ where }),
    ]);
    return { rows, total, page, pageSize };
  }

  async get(code: string) {
    const unit = await this.prisma.unit.findUnique({ where: { code } });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  async create(dto: CreateUnitDto, actor: Actor) {
    const exists = await this.prisma.unit.findUnique({ where: { code: dto.code } });
    if (exists) throw new BadRequestException('Unit already exists');

    const unit = await this.prisma.$transaction(async (tx) => {
      const created = await tx.unit.create({
        data: {
          code: dto.code,
          description: dto.description,
          category: dto.category ?? '',
          baseUnit: dto.baseUnit,
          baseQty: dto.baseQty,
          context: '',
        },
      });
      await this.audit.record(
        {
          action: 'unit.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.units',
          summary: `Created unit ${created.code}`,
          changes: [{ tableName: 'Unit', recordId: created.code, fieldName: 'code', oldValue: null, newValue: created.code }],
        },
        tx,
      );
      return created;
    });
    return { code: unit.code };
  }

  async update(code: string, dto: UpdateUnitDto, actor: Actor) {
    const existing = await this.prisma.unit.findUnique({ where: { code } });
    if (!existing) throw new NotFoundException('Unit not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.unit.update({ where: { code }, data: { ...dto } });
      await this.audit.record(
        {
          action: 'unit.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.units',
          summary: `Updated unit ${code}`,
          changes: Object.keys(dto).map((k) => ({
            tableName: 'Unit',
            recordId: code,
            fieldName: k,
            oldValue: String((existing as Record<string, unknown>)[k] ?? ''),
            newValue: String((dto as Record<string, unknown>)[k] ?? ''),
          })),
        },
        tx,
      );
      return u;
    });
    return { code: updated.code };
  }
}
