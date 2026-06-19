import { describe, expect, it } from 'vitest';
import { fgLotPrefix, formatSpec } from './order-format';

describe('fgLotPrefix (YYMMDD lot-number day prefix, UTC)', () => {
  it('formats year/month/day as YYMMDD', () => {
    expect(fgLotPrefix(new Date(Date.UTC(2026, 5, 19)))).toBe('260619'); // month is 0-based: 5 = June
  });

  it('zero-pads single-digit month and day', () => {
    expect(fgLotPrefix(new Date(Date.UTC(2026, 0, 5)))).toBe('260105');
  });

  it('takes the last two digits of the year', () => {
    expect(fgLotPrefix(new Date(Date.UTC(2000, 11, 31)))).toBe('001231');
    expect(fgLotPrefix(new Date(Date.UTC(2099, 8, 1)))).toBe('990901');
  });

  it('uses UTC components, not local time (near-midnight UTC keeps the UTC day)', () => {
    expect(fgLotPrefix(new Date('2026-06-19T23:59:59Z'))).toBe('260619');
    expect(fgLotPrefix(new Date('2026-06-19T00:00:00Z'))).toBe('260619');
  });
});

describe('formatSpec (batch-ticket spec rendering)', () => {
  it('prefers explicit specification text (trimmed) over a range', () => {
    expect(formatSpec(1, 2, 'visual / report')).toBe('visual / report');
    expect(formatSpec(null, null, '  pass  ')).toBe('pass');
  });

  it('renders a min/max range', () => {
    expect(formatSpec(13.5, 14.5, null)).toBe('13.5 - 14.5');
  });

  it('renders an upper-only bound', () => {
    expect(formatSpec(null, 2, null)).toBe('- 2');
  });

  it('renders a lower-only bound', () => {
    expect(formatSpec(825, null, null)).toBe('825 -');
  });

  it('is empty when nothing is specified', () => {
    expect(formatSpec(null, null, null)).toBe('');
  });

  it('falls through a blank specification to the numeric range', () => {
    expect(formatSpec(1, 2, '   ')).toBe('1 - 2');
  });
});
