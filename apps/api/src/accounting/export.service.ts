import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { ExportAccountingDto } from './dto/export.dto';
import { toCsv, toIif, unbalancedEntries } from './journal-format';
import { AccountingJournalService, EXPORT_KINDS, type ExportKind } from './journal.service';

/**
 * The accounting export (replaces the legacy live QuickBooks agent — see
 * ASSUMPTIONS §13): builds the journal for a date range and renders it as a
 * QuickBooks Desktop IIF file or a generic CSV journal. Every produced file
 * is recorded in the `accounting_export_run` ledger + the audit trail, so
 * "what was handed to accounting, when" is answerable — the operational
 * replacement for the vendor's overnight sync.
 */
@Injectable()
export class AccountingExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: AccountingJournalService,
    private readonly audit: AuditService,
  ) {}

  private parseRange(dto: { from: string; to: string; kinds?: string[] }) {
    const from = new Date(dto.from);
    const to = new Date(`${dto.to}T23:59:59.999Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Invalid date range.');
    if (from > to) throw new BadRequestException('"from" must not be after "to".');
    const kinds = new Set<ExportKind>(
      (dto.kinds?.length ? dto.kinds : [...EXPORT_KINDS]).filter((k): k is ExportKind =>
        (EXPORT_KINDS as readonly string[]).includes(k),
      ),
    );
    if (!kinds.size) throw new BadRequestException('No valid export kinds selected.');
    return { from, to, kinds };
  }

  /** Dry run: entry/warning counts + totals, no file, no ledger row. */
  async preview(dto: ExportAccountingDto) {
    const { from, to, kinds } = this.parseRange(dto);
    const { entries, warnings } = await this.journal.build(from, to, kinds);
    const byKind = new Map<string, { count: number; debit: number }>();
    for (const e of entries) {
      const agg = byKind.get(e.source) ?? { count: 0, debit: 0 };
      agg.count += 1;
      agg.debit += e.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
      byKind.set(e.source, agg);
    }
    return {
      from: from.toISOString(), to: to.toISOString(),
      entryCount: entries.length,
      byKind: [...byKind.entries()].map(([source, v]) => ({ source, ...v, debit: Math.round(v.debit * 100) / 100 })),
      unbalanced: unbalancedEntries(entries).map((e) => e.refNumber),
      warnings,
    };
  }

  /** Build the file, record the run + audit, and return the content. */
  async export(dto: ExportAccountingDto, actor: Actor) {
    const { from, to, kinds } = this.parseRange(dto);
    const format = dto.format ?? 'iif';
    const { entries, warnings } = await this.journal.build(from, to, kinds);
    const bad = unbalancedEntries(entries);
    if (bad.length) {
      // Should be impossible by construction — refuse rather than hand
      // accounting an out-of-balance file.
      throw new BadRequestException(`Internal: ${bad.length} journal entr(ies) do not balance (${bad.map((b) => b.refNumber).slice(0, 5).join(', ')}).`);
    }
    const content = format === 'csv' ? toCsv(entries) : toIif(entries);
    const fileName = `erp1-accounting_${dto.from}_${dto.to}.${format}`;

    const run = await this.prisma.$transaction(async (tx) => {
      const row = await tx.accountingExportRun.create({
        data: {
          fromDate: from, toDate: to,
          kinds: [...kinds].sort().join(','),
          format,
          entryCount: entries.length,
          warningCount: warnings.length,
          actorUserId: actor.id,
        },
      });
      await this.audit.record(
        {
          action: 'accounting.export',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'accounting.export',
          summary: `Accounting export #${row.id}: ${entries.length} entries (${[...kinds].sort().join(', ')}) ${dto.from} → ${dto.to} as ${format.toUpperCase()}${warnings.length ? `, ${warnings.length} warning(s)` : ''}`,
          changes: [{ tableName: 'accounting_export_run', recordId: String(row.id), fieldName: '*', oldValue: null, newValue: `${entries.length} entries` }],
        },
        tx,
      );
      return row;
    });

    return { runId: run.id, fileName, format, entryCount: entries.length, warnings, content };
  }

  async runs() {
    const rows = await this.prisma.accountingExportRun.findMany({ orderBy: { id: 'desc' }, take: 50 });
    const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((v): v is string => v != null))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));
    return {
      rows: rows.map((r) => ({
        id: r.id, at: r.at, from: r.fromDate, to: r.toDate, kinds: r.kinds, format: r.format,
        entryCount: r.entryCount, warningCount: r.warningCount,
        actor: r.actorUserId ? nameById.get(r.actorUserId) ?? r.actorUserId : null,
      })),
    };
  }
}
