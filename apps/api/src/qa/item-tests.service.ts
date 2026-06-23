import { Injectable, NotFoundException } from '@nestjs/common';
import { formatSpec } from '../orders/order-format';
import { PrismaService } from '../prisma/prisma.service';

// Read-only viewer for item testing requirements (legacy ItemTest): per item, the
// QC tests + specifications and the stages they apply to. The same ItemTest rows
// drive native order QC specs and the CofA; this surfaces them directly for QA.
@Injectable()
export class ItemTestsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Items matching a search term that have at least one test requirement. */
  async itemOptions(q?: string) {
    const term = q?.trim();
    if (!term) return { rows: [] };
    const items = await this.prisma.item.findMany({
      where: { OR: [{ itemCode: { contains: term, mode: 'insensitive' } }, { description: { contains: term, mode: 'insensitive' } }] },
      orderBy: { itemCode: 'asc' },
      take: 50,
      select: { id: true, itemCode: true, description: true },
    });
    if (!items.length) return { rows: [] };
    const counts = await this.prisma.itemTest.groupBy({
      by: ['itemId'],
      where: { itemId: { in: items.map((i) => i.id) } },
      _count: { _all: true },
    });
    const testCount = new Map(counts.map((c) => [c.itemId, c._count._all]));
    const rows = items
      .filter((i) => testCount.has(i.id))
      .slice(0, 25)
      .map((i) => ({ id: i.id, itemCode: i.itemCode, description: i.description, testCount: testCount.get(i.id) ?? 0 }));
    return { rows };
  }

  /** An item's testing requirements (specifications) ordered by line. */
  async forItem(itemId: number) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { id: true, itemCode: true, description: true } });
    if (!item) throw new NotFoundException('Item not found');
    const tests = await this.prisma.itemTest.findMany({
      where: { itemId },
      orderBy: [{ line: 'asc' }, { id: 'asc' }],
      select: { test: true, min: true, max: true, target: true, specification: true, testGroup: true, grade: true, onReceipt: true, onProduction: true, onRetest: true },
    });
    return {
      item,
      tests: tests.map((t) => ({
        test: t.test,
        specification: formatSpec(t.min, t.max, t.specification),
        target: t.target,
        testGroup: t.testGroup,
        grade: t.grade,
        stages: [t.onReceipt ? 'Receipt' : null, t.onProduction ? 'Production' : null, t.onRetest ? 'Retest' : null].filter(Boolean).join(', '),
      })),
    };
  }
}
