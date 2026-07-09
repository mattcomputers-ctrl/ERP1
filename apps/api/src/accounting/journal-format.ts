// Pure formatters for the accounting export (no dependencies, unit-testable):
// journal entries -> QuickBooks Desktop IIF, or a generic CSV journal.
//
// IIF is QuickBooks Desktop's tab-separated import format: an !TRNS/!SPL/
// !ENDTRNS header block, then one TRNS row + SPL rows + ENDTRNS per
// transaction. Amount signs follow QB's convention: the TRNS row carries the
// header account's signed amount (debit positive), each SPL row the opposite
// side; every transaction must sum to zero.

import { csvCell } from '../common/csv';

export type JournalEntryType = 'INVOICE' | 'BILL' | 'GENERAL JOURNAL';

export interface JournalLine {
  account: string;
  /** Positive = debit, negative = credit. */
  amount: number;
  memo?: string | null;
}

export interface JournalEntry {
  type: JournalEntryType;
  /** ERP1 source kind (invoice / receipt / adjustment / build / misc receipt). */
  source: string;
  date: Date;
  /** Document number (invoice #, PO #, change set / order id). */
  refNumber: string;
  /** Customer / supplier name, when the type carries one. */
  name?: string | null;
  memo?: string | null;
  /** First line = the header (TRNS) side; the rest become SPL rows. */
  lines: JournalLine[];
}

export const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** IIF field sanitizer: tabs/newlines would break the format. */
const iifText = (v: string | null | undefined) => (v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

const mdy = (d: Date) => {
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${m}/${day}/${d.getUTCFullYear()}`;
};

/** Verify every entry balances to zero (within a cent); returns the offenders. */
export function unbalancedEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((e) => Math.abs(e.lines.reduce((s, l) => s + l.amount, 0)) >= 0.005);
}

export function toIif(entries: JournalEntry[]): string {
  const out: string[] = [
    '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO',
    '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO',
    '!ENDTRNS',
  ];
  for (const e of entries) {
    const [head, ...spl] = e.lines;
    if (!head) continue;
    const row = (tag: 'TRNS' | 'SPL', l: JournalLine) =>
      [
        tag,
        e.type,
        mdy(e.date),
        iifText(l.account),
        iifText(e.name),
        round2(l.amount).toFixed(2),
        iifText(e.refNumber),
        iifText(l.memo ?? e.memo),
      ].join('\t');
    out.push(row('TRNS', head));
    for (const l of spl) out.push(row('SPL', l));
    out.push('ENDTRNS');
  }
  return out.join('\r\n') + '\r\n';
}

/** Generic journal CSV: one row per line, debit/credit split into columns. */
export function toCsv(entries: JournalEntry[]): string {
  const rows = ['type,source,date,refNumber,name,account,debit,credit,memo'];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push(
        [
          e.type,
          e.source,
          e.date.toISOString().slice(0, 10),
          e.refNumber,
          e.name ?? '',
          l.account,
          l.amount > 0 ? round2(l.amount).toFixed(2) : '',
          l.amount < 0 ? round2(-l.amount).toFixed(2) : '',
          l.memo ?? e.memo ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}
