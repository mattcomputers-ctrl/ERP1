import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type FieldChange } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { formatSpec } from '../orders/order-format';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateItemTestDto, UpdateItemTestDto } from './dto/item-test.dto';

// Viewer + editor for item testing requirements (legacy ItemTest): per item, the
// QC tests + specifications and the stages they apply to. The same ItemTest rows
// drive native order QC specs and the CofA; this surfaces and maintains them for QA.
@Injectable()
export class ItemTestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /** An item's testing requirements (specifications) ordered by line. Returns the
   * formatted display spec AND the raw editable fields (+ the row id) so the same
   * payload powers the viewer and the editor. */
  async forItem(itemId: number) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { id: true, itemCode: true, description: true } });
    if (!item) throw new NotFoundException('Item not found');
    const tests = await this.prisma.itemTest.findMany({
      where: { itemId },
      orderBy: [{ line: 'asc' }, { id: 'asc' }],
      select: {
        id: true, test: true, min: true, max: true, target: true, specification: true, qualifier: true,
        comment: true, testGroup: true, grade: true, onReceipt: true, onProduction: true, onRetest: true, line: true,
      },
    });
    return {
      item,
      tests: tests.map((t) => ({
        id: t.id,
        test: t.test,
        specification: formatSpec(t.min, t.max, t.specification),
        min: t.min,
        max: t.max,
        target: t.target,
        spec: t.specification,
        qualifier: t.qualifier,
        comment: t.comment,
        testGroup: t.testGroup,
        grade: t.grade,
        onReceipt: !!t.onReceipt,
        onProduction: !!t.onProduction,
        onRetest: !!t.onRetest,
        line: t.line,
        stages: [t.onReceipt ? 'Receipt' : null, t.onProduction ? 'Production' : null, t.onRetest ? 'Retest' : null].filter(Boolean).join(', '),
      })),
    };
  }

  /** Distinct existing test names (for the editor's name datalist). */
  async testNameOptions(q?: string) {
    const term = q?.trim();
    const rows = await this.prisma.itemTest.findMany({
      where: { test: term ? { contains: term, mode: 'insensitive' } : { not: null } },
      distinct: ['test'],
      orderBy: { test: 'asc' },
      take: 50,
      select: { test: true },
    });
    return { rows: rows.map((r) => r.test).filter((t): t is string => !!t) };
  }

  // --- editing (mutating; RBAC + atomic audit) -----------------------------

  /** Add a test requirement to an item. Native id (≥ NATIVE_ID_BASE) so a later
   * legacy re-import (upsert by PK) can't clobber it; line defaults to the next. */
  async addTest(itemId: number, dto: CreateItemTestDto, actor: Actor) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { id: true, itemCode: true } });
    if (!item) throw new NotFoundException('Item not found');
    if (!dto.test?.trim()) throw new BadRequestException('A test name is required.');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const id = ((await tx.itemTest.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const line = dto.line ?? ((await tx.itemTest.aggregate({ _max: { line: true }, where: { itemId } }))._max.line ?? 0) + 1;
      await tx.itemTest.create({
        data: {
          id,
          itemId,
          test: dto.test.trim(),
          testGroup: dto.testGroup ?? null,
          qualifier: dto.qualifier ?? null,
          min: dto.min ?? null,
          max: dto.max ?? null,
          target: dto.target ?? null,
          grade: dto.grade ?? null,
          specification: dto.specification ?? null,
          comment: dto.comment ?? null,
          onReceipt: dto.onReceipt ?? false,
          onProduction: dto.onProduction ?? false,
          onRetest: dto.onRetest ?? false,
          line,
        },
      });
      await this.audit.record(
        {
          action: 'qa.itemTest.add',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.itemTestsEdit',
          summary: `Test '${dto.test.trim()}' added to item ${item.itemCode}`,
          changes: [{ tableName: 'ItemTest', recordId: String(id), fieldName: 'Test', oldValue: null, newValue: dto.test.trim() }],
        },
        tx,
      );
      return { itemId, testId: id, line };
    });
  }

  /** Update a test requirement (partial; only supplied fields change). IDOR-safe. */
  async updateTest(itemId: number, testId: number, dto: UpdateItemTestDto, actor: Actor) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { id: true, itemCode: true } });
    if (!item) throw new NotFoundException('Item not found');
    const row = await this.prisma.itemTest.findUnique({
      where: { id: testId },
      select: { id: true, itemId: true, test: true, testGroup: true, qualifier: true, min: true, max: true, target: true, grade: true, specification: true, comment: true, onReceipt: true, onProduction: true, onRetest: true, line: true },
    });
    if (!row || row.itemId !== itemId) throw new NotFoundException(`Test ${testId} is not on item #${itemId}.`);

    const data: Record<string, unknown> = {};
    const changes: FieldChange[] = [];
    const set = (field: string, key: keyof typeof row, next: unknown, str: (v: unknown) => string | null) => {
      if (next === undefined) return;
      const norm = typeof next === 'string' ? (next as string).trim() || null : next;
      if (norm === row[key]) return;
      data[key as string] = norm;
      changes.push({ tableName: 'ItemTest', recordId: String(testId), fieldName: field, oldValue: str(row[key]), newValue: str(norm) });
    };
    const s = (v: unknown) => (v == null ? null : String(v));
    if (dto.test !== undefined && !dto.test.trim()) throw new BadRequestException('The test name cannot be blank.');
    set('Test', 'test', dto.test, s);
    set('TestGroup', 'testGroup', dto.testGroup, s);
    set('Qualifier', 'qualifier', dto.qualifier, s);
    set('Min', 'min', dto.min, s);
    set('Max', 'max', dto.max, s);
    set('Target', 'target', dto.target, s);
    set('Grade', 'grade', dto.grade, s);
    set('Specification', 'specification', dto.specification, s);
    set('Comment', 'comment', dto.comment, s);
    set('OnReceipt', 'onReceipt', dto.onReceipt, s);
    set('OnProduction', 'onProduction', dto.onProduction, s);
    set('OnRetest', 'onRetest', dto.onRetest, s);
    set('Line', 'line', dto.line, s);
    if (!changes.length) return { itemId, testId, unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      await tx.itemTest.update({ where: { id: testId }, data });
      await this.audit.record(
        { action: 'qa.itemTest.update', actorUserId: actor.id, actorLabel: actor.label, program: 'qa.itemTestsEdit', summary: `Test ${row.test ?? testId} on item ${item.itemCode} updated`, changes },
        tx,
      );
      return { itemId, testId };
    });
  }

  /** Remove a test requirement from an item. IDOR-safe; audited. */
  async removeTest(itemId: number, testId: number, actor: Actor) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { id: true, itemCode: true } });
    if (!item) throw new NotFoundException('Item not found');
    const row = await this.prisma.itemTest.findUnique({ where: { id: testId }, select: { id: true, itemId: true, test: true } });
    if (!row || row.itemId !== itemId) throw new NotFoundException(`Test ${testId} is not on item #${itemId}.`);

    return this.prisma.$transaction(async (tx) => {
      await tx.itemTest.delete({ where: { id: testId } });
      await this.audit.record(
        { action: 'qa.itemTest.remove', actorUserId: actor.id, actorLabel: actor.label, program: 'qa.itemTestsEdit', summary: `Test ${row.test ?? testId} removed from item ${item.itemCode}`, changes: [{ tableName: 'ItemTest', recordId: String(testId), fieldName: 'removed', oldValue: row.test, newValue: null }] },
        tx,
      );
      return { itemId, testId, removed: true };
    });
  }
}
