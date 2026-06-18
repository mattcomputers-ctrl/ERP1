import { Injectable, NotFoundException } from '@nestjs/common';
import { buildList, type ListQuery } from '../common/list';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

// Normalise a test name for matching: trim, upper-case, and collapse internal
// whitespace so "VISC #3  ZAHN" and "VISC #3 ZAHN" join.
const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

@Injectable()
export class CofaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async list(query: ListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: ['releaseId', 'productCode', 'manfLot'],
      defaultSort: { releaseId: 'desc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { productCode: { contains: q, mode: 'insensitive' } },
        { manfLot: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.releaseCofA.findMany({
        where, skip, take, orderBy,
        select: { releaseId: true, productCode: true, description: true, manfLot: true, pkgLot: true, manfDate: true, expiryDate: true },
      }),
      this.prisma.releaseCofA.count({ where }),
    ]);

    // Decorate with the QA disposition (grade/status/date) from the Release.
    const releases = await this.prisma.release.findMany({
      where: { id: { in: rows.map((r) => r.releaseId) } },
      select: { id: true, status: true, grade: true, releaseDate: true },
    });
    const relById = new Map(releases.map((r) => [r.id, r]));

    return {
      rows: rows.map((r) => ({
        ...r,
        status: relById.get(r.releaseId)?.status ?? null,
        grade: relById.get(r.releaseId)?.grade ?? null,
        releaseDate: relById.get(r.releaseId)?.releaseDate ?? null,
      })),
      total, page, pageSize,
    };
  }

  /**
   * Assemble the printable Certificate of Analysis for a released lot: the
   * ReleaseCofA header (product/lot/dates), the QA disposition from the Release,
   * and the recorded test results (LocationSampleTest via Release.SampleSet) lined
   * up against the product's specs (ItemTest, matched by test name).
   */
  async get(releaseId: number) {
    const cofa = await this.prisma.releaseCofA.findUnique({ where: { releaseId } });
    if (!cofa) throw new NotFoundException('Certificate of Analysis not found');

    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { status: true, grade: true, purity: true, expiryDate: true, releaseDate: true, releasedBy: true, sampleSetId: true },
    });
    // A CofA is keyed 1:1 to a Release; a missing one means broken data, not a
    // certificate to render half-blank. (Holds for all 54K rows today.)
    if (!release) throw new NotFoundException('Release not found for this certificate');

    const results = release?.sampleSetId != null
      ? await this.prisma.locationSampleTest.findMany({
          where: { sampleSetId: release.sampleSetId },
          orderBy: { id: 'asc' },
          select: { test: true, result: true, passed: true, testedBy: true, testedTime: true },
        })
      : [];

    // Specs come from the product item's ItemTest (matched by test name).
    // itemCode is unique, so findUnique is exact (no ambiguity).
    const item = cofa.productCode
      ? await this.prisma.item.findUnique({ where: { itemCode: cofa.productCode }, select: { id: true, description: true } })
      : null;
    const specs = item
      ? await this.prisma.itemTest.findMany({
          where: { itemId: item.id },
          orderBy: [{ line: 'asc' }, { id: 'asc' }],
          select: { test: true, min: true, max: true, target: true, specification: true, line: true },
        })
      : [];
    const specByTest = new Map(specs.map((s) => [norm(s.test), s]));

    const tests = results
      .map((r) => {
        const spec = specByTest.get(norm(r.test));
        return {
          test: r.test,
          specification: formatSpec(spec?.min ?? null, spec?.max ?? null, spec?.specification ?? null),
          result: r.result,
          passed: r.passed,
          testedBy: r.testedBy,
          testedTime: r.testedTime,
          // Sort key only — present results in the product's spec order.
          sortKey: spec?.line ?? 9999,
        };
      })
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((t) => ({
        test: t.test,
        specification: t.specification,
        result: t.result,
        passed: t.passed,
        testedBy: t.testedBy,
        testedTime: t.testedTime,
      }));

    const companyName = await this.settings.get('company.name', 'Precision Ink Corporation');

    return {
      header: {
        releaseId,
        companyName,
        productCode: cofa.productCode,
        description: cofa.description ?? item?.description ?? null,
        manfLot: cofa.manfLot,
        pkgLot: cofa.pkgLot,
        manfDate: cofa.manfDate,
        expiryDate: cofa.expiryDate ?? release?.expiryDate ?? null,
        grade: release?.grade ?? null,
        status: release?.status ?? null,
        purity: release?.purity ?? null,
        releaseDate: release?.releaseDate ?? null,
        releasedBy: release?.releasedBy ?? null,
      },
      tests,
    };
  }
}

// Format a spec the way a CofA reads: explicit Specification text wins; otherwise
// a min/max range ("28 - 33", "90 -" for min-only, "- 2" for max-only).
function formatSpec(min: number | null, max: number | null, spec: string | null): string {
  if (spec && spec.trim()) return spec.trim();
  if (min != null && max != null) return `${min} - ${max}`;
  if (min != null) return `${min} -`;
  if (max != null) return `- ${max}`;
  return '';
}
