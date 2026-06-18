import { Injectable, NotFoundException } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';

const SORTABLE = ['recipeNumber', 'dateUpdated', 'context'];

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListQuery & { context?: string; published?: string }) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { recipeNumber: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) where.recipeNumber = { contains: query.q, mode: 'insensitive' };
    if (query.context) where.context = query.context;
    if (query.published === '1') where.isPublished = true;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recipe.findMany({
        where,
        skip,
        take,
        orderBy,
        select: {
          id: true, recipeNumber: true, version: true, context: true, ordSubType: true,
          isPublished: true, inactive: true, developmentStatus: true, dateUpdated: true,
        },
      }),
      this.prisma.recipe.count({ where }),
    ]);
    return { rows, total, page, pageSize };
  }

  async get(id: number) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id },
      select: {
        id: true, recipeNumber: true, version: true, context: true, ordSubType: true,
        isPublished: true, inactive: true, comment: true, developmentStatus: true,
        weightUnit: true, volumeUnit: true, dateCreated: true, dateUpdated: true, datePublished: true,
      },
    });
    if (!recipe) throw new NotFoundException('Recipe not found');

    const lines = await this.prisma.recipeDetail.findMany({
      where: { recipeId: id },
      orderBy: [{ execOrder: 'asc' }, { line: 'asc' }],
      select: {
        id: true, itemId: true, description: true, qtyReqd: true, entityUnit: true,
        phase: true, execOrder: true, batchType: true, qtyYield: true, yieldPercent: true,
        totalWeightPercent: true,
      },
    });
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, itemCode: true, description: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    return {
      ...recipe,
      lines: lines.map((l) => ({
        ...l,
        itemCode: l.itemId != null ? (itemById.get(l.itemId)?.itemCode ?? null) : null,
        itemDescription:
          l.itemId != null ? (itemById.get(l.itemId)?.description ?? null) : null,
      })),
    };
  }
}
