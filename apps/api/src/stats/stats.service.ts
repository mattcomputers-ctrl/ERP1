import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** System-wide counts + recent activity for the dashboard overview. */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const [
      entities, items, recipes, lots, ordersTotal, ordersByCtx,
      inventoryOnHand, genealogyEdges, auditRecords, lastImport, recent,
    ] = await Promise.all([
      this.prisma.entity.count(),
      this.prisma.item.count(),
      this.prisma.recipe.count(),
      this.prisma.lot.count(),
      this.prisma.ordr.count(),
      this.prisma.ordr.groupBy({ by: ['context'], _count: { _all: true } }),
      this.prisma.inventory.count({ where: { qty: { gt: 0 } } }),
      this.prisma.lotGenealogy.count(),
      this.prisma.auditLog.count(),
      this.prisma.importRun.findFirst({ orderBy: { id: 'desc' } }),
      this.prisma.auditLog.findMany({
        orderBy: { id: 'desc' },
        take: 8,
        select: { at: true, actorLabel: true, action: true, summary: true },
      }),
    ]);

    const orders: Record<string, number> = { total: ordersTotal };
    for (const g of ordersByCtx) if (g.context) orders[g.context] = g._count._all;

    return {
      counts: { entities, items, recipes, lots, orders, inventoryOnHand, genealogyEdges, auditRecords },
      lastImport: lastImport
        ? {
            status: lastImport.status,
            mode: lastImport.mode,
            finishedAt: lastImport.finishedAt,
            genealogyEdges: (lastImport.report as { genealogyEdges?: number } | null)?.genealogyEdges ?? null,
          }
        : null,
      recentActivity: recent,
    };
  }
}
