import { describe, expect, it } from 'vitest';
import { toCsv, toIif, unbalancedEntries, type JournalEntry } from './journal-format';

const invoice: JournalEntry = {
  type: 'INVOICE',
  source: 'invoice',
  date: new Date('2026-07-02T16:48:53Z'),
  refNumber: 'N00132725',
  name: 'CUST1',
  memo: null,
  lines: [
    { account: 'Accounts Receivable', amount: 132 },
    { account: '35200 - FG Revenue', amount: -100 },
    { account: 'Freight Income', amount: -20, memo: 'Freight' },
    { account: 'Sales Tax Payable', amount: -12, memo: 'Tax 1' },
  ],
};

describe('toIif', () => {
  it('renders the header block and one TRNS/SPL/ENDTRNS group per entry', () => {
    const iif = toIif([invoice]);
    const lines = iif.trim().split('\r\n');
    expect(lines[0]).toBe('!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO');
    expect(lines[1]).toMatch(/^!SPL\t/);
    expect(lines[2]).toBe('!ENDTRNS');
    expect(lines[3]).toBe('TRNS\tINVOICE\t7/2/2026\tAccounts Receivable\tCUST1\t132.00\tN00132725\t');
    expect(lines[4]).toBe('SPL\tINVOICE\t7/2/2026\t35200 - FG Revenue\tCUST1\t-100.00\tN00132725\t');
    expect(lines[5]).toContain('Freight');
    expect(lines[6]).toContain('Sales Tax Payable\tCUST1\t-12.00');
    expect(lines[7]).toBe('ENDTRNS');
  });

  it('sanitizes tabs and newlines out of text fields', () => {
    const iif = toIif([{ ...invoice, name: 'BAD\tNAME\nX', memo: 'a\tb' }]);
    expect(iif).toContain('BAD NAME X');
    expect(iif).not.toMatch(/BAD\tNAME/);
  });

  it('a bill leads with the negative AP side', () => {
    const bill: JournalEntry = {
      type: 'BILL', source: 'receipt', date: new Date('2026-01-15T00:00:00Z'), refNumber: '3475',
      name: 'SUP1', memo: 'Receipt RM1 x 400',
      lines: [
        { account: 'Accounts Payable', amount: -812 },
        { account: '12100 - RM Inventory Asset', amount: 812 },
      ],
    };
    const lines = toIif([bill]).trim().split('\r\n');
    expect(lines[3]).toBe('TRNS\tBILL\t1/15/2026\tAccounts Payable\tSUP1\t-812.00\t3475\tReceipt RM1 x 400');
  });
});

describe('toCsv', () => {
  it('emits one row per line with debit/credit split and quoted fields', () => {
    const csv = toCsv([{ ...invoice, name: 'A, "B"' }]);
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('type,source,date,refNumber,name,account,debit,credit,memo');
    expect(rows[1]).toBe('INVOICE,invoice,2026-07-02,N00132725,"A, ""B""",Accounts Receivable,132.00,,');
    expect(rows[2]).toContain(',,100.00,'); // credit column
    expect(rows).toHaveLength(5);
  });
});

describe('unbalancedEntries', () => {
  it('flags entries whose lines do not sum to zero', () => {
    expect(unbalancedEntries([invoice])).toHaveLength(0);
    const bad = { ...invoice, lines: [{ account: 'A', amount: 10 }, { account: 'B', amount: -9.98 }] };
    expect(unbalancedEntries([bad])).toHaveLength(1);
    // A rounding hair under half a cent balances.
    const hair = { ...invoice, lines: [{ account: 'A', amount: 10.004 }, { account: 'B', amount: -10 }] };
    expect(unbalancedEntries([hair])).toHaveLength(0);
  });
});
