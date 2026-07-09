import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type FieldChange } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { formatSpec } from '../orders/order-format';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCatalogTestDto, CreateItemTestDto, UpdateCatalogTestDto, UpdateItemTestDto } from './dto/item-test.dto';

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

  /**
   * Test names for the editor's datalist: the master catalog (`Test`, with its
   * description / result type / unit) first, then any ad-hoc names that exist
   * only on ItemTest rows (legacy references the catalog by NAME, no FK — names
   * outside the catalog are valid and must keep appearing). Backward-compatible
   * shape: rows of { test, description, catalog }.
   */
  async testNameOptions(q?: string) {
    const term = q?.trim();
    const nameFilter = term ? { contains: term, mode: 'insensitive' as const } : undefined;
    const [catalog, adhoc] = await Promise.all([
      this.prisma.test.findMany({
        where: nameFilter ? { test: nameFilter } : {},
        orderBy: { test: 'asc' },
        take: 50,
        select: { test: true, description: true, testResultType: true, unit: true },
      }),
      this.prisma.itemTest.findMany({
        where: { test: nameFilter ?? { not: null } },
        distinct: ['test'],
        orderBy: { test: 'asc' },
        take: 50,
        select: { test: true },
      }),
    ]);
    const seen = new Set(catalog.map((c) => c.test.trim().toUpperCase()));
    const rows = [
      ...catalog.map((c) => ({
        test: c.test,
        description: c.description ?? null,
        resultType: c.testResultType ?? null,
        unit: c.unit ?? null,
        catalog: true,
      })),
      ...adhoc
        .map((r) => r.test)
        .filter((t): t is string => !!t)
        .filter((t) => {
          const key = t.trim().toUpperCase();
          if (seen.has(key)) return false; // vs the catalog AND earlier ad-hoc names
          seen.add(key);
          return true;
        })
        .map((t) => ({ test: t, description: null, resultType: null, unit: null, catalog: false })),
    ];
    return { rows: rows.slice(0, 50) };
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

  // --- Test-catalog admin (legacy `Test` master; program qa.testCatalogEdit) --
  // Natural-key table (PK = the 20-char test NAME) — no native-id range applies.
  // Legacy 'Test Update' was this editor (76 uses through 2025-12-23, still adding
  // tests). A native row survives sync (only legacy-touched keys re-pull); a full
  // re-import restores legacy-origin rows deleted here (documented, acceptable).

  /** The full Test catalog (35 rows live) with per-name ItemTest usage counts,
   * plus the TestGroup options for the editor's group picker. */
  async catalog() {
    const [tests, usage, groups] = await Promise.all([
      this.prisma.test.findMany({ orderBy: { test: 'asc' } }),
      this.prisma.itemTest.groupBy({ by: ['test'], where: { test: { not: null } }, _count: { _all: true } }),
      this.prisma.testGroup.findMany({ orderBy: { testGroup: 'asc' }, select: { testGroup: true, description: true } }),
    ]);
    const counts = new Map<string, number>();
    for (const u of usage) {
      const key = (u.test as string).trim().toUpperCase();
      counts.set(key, (counts.get(key) ?? 0) + u._count._all);
    }
    return {
      rows: tests.map((t) => ({
        test: t.test,
        description: t.description,
        testResultType: t.testResultType,
        precision: t.precision,
        testGroup: t.testGroup,
        unit: t.unit,
        prototype: !!t.prototype,
        usedBy: counts.get(t.test.trim().toUpperCase()) ?? 0,
      })),
      groups,
    };
  }

  /** Precision belongs to numeric results only — the live catalog has it on
   * exactly the NUM rows. Returns the normalized precision to store. */
  private assertCatalogShape(resultType: string, precision: number | null | undefined): number | null {
    if (resultType !== 'NUM' && resultType !== 'BOOL') throw new BadRequestException('Result type must be NUM or BOOL.');
    if (precision == null) return null;
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) throw new BadRequestException('Precision must be an integer from 0 to 10.');
    if (resultType === 'BOOL') throw new BadRequestException('Precision applies to numeric (NUM) tests only.');
    return precision;
  }

  /** Add a test to the master catalog. Uniqueness is case-insensitive (ItemTest
   * links by name and the picker dedupes case-insensitively) and checked INSIDE
   * the locked tx, alongside the test-group existence check. */
  async addCatalogTest(dto: CreateCatalogTestDto, actor: Actor) {
    const name = dto.test?.trim();
    if (!name) throw new BadRequestException('A test name is required.');
    const groupName = dto.testGroup?.trim();
    if (!groupName) throw new BadRequestException('A test group is required (every catalog test carries one).');
    const precision = this.assertCatalogShape(dto.testResultType, dto.precision);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const existing = await tx.test.findMany({ select: { test: true } });
      if (existing.some((t) => t.test.trim().toUpperCase() === name.toUpperCase()))
        throw new BadRequestException(`Test '${name}' already exists in the catalog.`);
      const group = await tx.testGroup.findUnique({ where: { testGroup: groupName }, select: { testGroup: true } });
      if (!group) throw new BadRequestException(`Test group '${groupName}' does not exist.`);
      await tx.test.create({
        data: {
          test: name,
          version: 0,
          description: dto.description?.trim() || null,
          testResultType: dto.testResultType,
          precision,
          testGroup: group.testGroup,
          unit: dto.unit?.trim() || null,
          prototype: dto.prototype ?? false,
        },
      });
      await this.audit.record(
        {
          action: 'qa.testCatalog.add',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.testCatalogEdit',
          summary: `Test '${name}' added to the catalog`,
          changes: [{ tableName: 'Test', recordId: name, fieldName: 'Test', oldValue: null, newValue: name }],
        },
        tx,
      );
      return { test: name };
    });
  }

  /** Update a catalog test (partial; the NAME never changes — other tables link
   * by it). Re-asserts the DTO invariants the @IsOptional-null trap skips. The
   * row read, shape validation and diff all run INSIDE the tx under the shared
   * advisory lock — a pre-tx snapshot lets two concurrent PATCHes interleave
   * into a BOOL-with-precision row, and update-vs-remove into a P2025 500. */
  async updateCatalogTest(testName: string, dto: UpdateCatalogTestDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const row = await tx.test.findUnique({ where: { test: testName } });
      if (!row) throw new NotFoundException(`Test '${testName}' is not in the catalog.`);

      const nextType = dto.testResultType === undefined ? (row.testResultType ?? 'NUM') : dto.testResultType;
      if (nextType == null) throw new BadRequestException('The result type cannot be cleared.');
      // Changing to BOOL implicitly clears a stored precision; an explicit
      // precision must satisfy the same shape rule as create.
      const nextPrecision =
        dto.precision === undefined
          ? nextType === 'BOOL'
            ? null
            : (row.precision ?? null)
          : this.assertCatalogShape(nextType, dto.precision);
      if (dto.testResultType !== undefined || dto.precision !== undefined) this.assertCatalogShape(nextType, nextPrecision);

      let groupName: string | null | undefined;
      if (dto.testGroup !== undefined) {
        groupName = dto.testGroup?.trim() || null;
        if (!groupName) throw new BadRequestException('A test group is required (every catalog test carries one).');
        const group = await tx.testGroup.findUnique({ where: { testGroup: groupName }, select: { testGroup: true } });
        if (!group) throw new BadRequestException(`Test group '${groupName}' does not exist.`);
      }

      const data: Record<string, unknown> = {};
      const changes: FieldChange[] = [];
      const s = (v: unknown) => (v == null ? null : String(v));
      const set = (field: string, key: 'description' | 'testResultType' | 'precision' | 'testGroup' | 'unit' | 'prototype', next: unknown) => {
        if (next === undefined) return;
        const norm = typeof next === 'string' ? next.trim() || null : next;
        if (norm === row[key]) return;
        data[key] = norm;
        changes.push({ tableName: 'Test', recordId: testName, fieldName: field, oldValue: s(row[key]), newValue: s(norm) });
      };
      set('Description', 'description', dto.description);
      set('TestResultType', 'testResultType', dto.testResultType);
      set('Precision', 'precision', nextPrecision === (row.precision ?? null) ? undefined : nextPrecision);
      set('TestGroup', 'testGroup', groupName);
      set('Unit', 'unit', dto.unit);
      // Boolean mirror column: explicit false, never NULL — an explicit-null body
      // value reaches here unvalidated (@IsOptional skips validators on null).
      set('Prototype', 'prototype', dto.prototype === null ? false : dto.prototype);
      if (!changes.length) return { test: testName, unchanged: true };

      await tx.test.update({ where: { test: testName }, data });
      await this.audit.record(
        { action: 'qa.testCatalog.update', actorUserId: actor.id, actorLabel: actor.label, program: 'qa.testCatalogEdit', summary: `Catalog test '${testName}' updated`, changes },
        tx,
      );
      return { test: testName };
    });
  }

  /** Remove a catalog test. Refused while any ItemTest requirement references the
   * name (case- AND whitespace-insensitive, matching how the picker/usage counts
   * dedupe) — order/sample snapshots (OrdDetailTest, LocationSampleTest) link by
   * copied name and are intentionally NOT a guard, matching legacy Test Update
   * deletes. Existence + count checked inside the locked tx (a concurrent double
   * delete must 404, not 500). */
  async removeCatalogTest(testName: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const row = await tx.test.findUnique({ where: { test: testName }, select: { test: true } });
      if (!row) throw new NotFoundException(`Test '${testName}' is not in the catalog.`);
      const [{ n: refs }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM "ItemTest"
        WHERE "Test" IS NOT NULL AND UPPER(TRIM("Test")) = UPPER(TRIM(${testName}))`;
      if (refs > 0) throw new BadRequestException(`Refused: ${refs} item test requirement${refs === 1 ? '' : 's'} reference '${testName}'. Remove those first.`);
      await tx.test.delete({ where: { test: testName } });
      await this.audit.record(
        {
          action: 'qa.testCatalog.remove',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'qa.testCatalogEdit',
          summary: `Test '${testName}' removed from the catalog`,
          changes: [{ tableName: 'Test', recordId: testName, fieldName: 'removed', oldValue: testName, newValue: null }],
        },
        tx,
      );
      return { test: testName, removed: true };
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
