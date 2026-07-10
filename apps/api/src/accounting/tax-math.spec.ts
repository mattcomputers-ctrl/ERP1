import { describe, expect, it } from 'vitest';
import { computeTaxes, resolveRule, type TaxRuleRow } from './tax-math';

const rule = (o: Partial<TaxRuleRow> & { id: number }): TaxRuleRow => ({
  description: null,
  itemTaxGroup: null,
  entityTaxGroup: null,
  rate: null,
  amount: null,
  taxOnTax: null,
  taxNumber: 1,
  ...o,
});

// The live plant's rules: level 1, entity-group driven, blank item group, 10%.
const PLANT_RULES: TaxRuleRow[] = [
  rule({ id: 15, description: 'SALES TAX', entityTaxGroup: 'SALES TAX', rate: 10 }),
  rule({ id: 16, description: 'TAX', entityTaxGroup: 'TAX', rate: 10 }),
  rule({ id: 17, description: 'IL', entityTaxGroup: 'IL', rate: 10 }),
];

describe('resolveRule', () => {
  it('prefers the exact item-group match over the blank rule', () => {
    const rules = [
      rule({ id: 1, entityTaxGroup: 'GST', itemTaxGroup: null, rate: 5 }),
      rule({ id: 2, entityTaxGroup: 'GST', itemTaxGroup: 'A', rate: 8 }),
    ];
    expect(resolveRule(rules, 1, 'GST', 'A')?.id).toBe(2);
    expect(resolveRule(rules, 1, 'GST', 'B')?.id).toBe(1); // fallback to blank
    expect(resolveRule(rules, 1, 'GST', null)?.id).toBe(1);
  });

  it('matches nothing when the customer group has no rules', () => {
    expect(resolveRule(PLANT_RULES, 1, 'NOTAX', null)).toBeNull();
    expect(resolveRule(PLANT_RULES, 1, null, null)).toBeNull();
  });

  it('treats blank and NULL groups as equal, case-insensitively', () => {
    const rules = [rule({ id: 1, entityTaxGroup: 'gst', itemTaxGroup: '', rate: 5 })];
    expect(resolveRule(rules, 1, 'GST', null)?.id).toBe(1);
  });

  it('an exempt item-group rule (rate 0) beats the blank rule', () => {
    const rules = [
      rule({ id: 1, entityTaxGroup: 'FLORIDA', itemTaxGroup: null, rate: 6, taxNumber: 2 }),
      rule({ id: 2, entityTaxGroup: 'FLORIDA', itemTaxGroup: 'EXEMPT', rate: 0, taxNumber: 2 }),
    ];
    expect(resolveRule(rules, 2, 'FLORIDA', 'EXEMPT')?.id).toBe(2);
  });

  it('does not cross tax levels', () => {
    expect(resolveRule(PLANT_RULES, 2, 'SALES TAX', null)).toBeNull();
  });
});

describe('computeTaxes', () => {
  it('computes the plant 10% level-1 tax on the subtotal', () => {
    const r = computeTaxes(PLANT_RULES, ['SALES TAX', null, null], [
      { amount: 100, qty: 2, itemTaxGroups: [null, null, null] },
      { amount: 50.55, qty: 1, itemTaxGroups: [null, null, null] },
    ]);
    expect(r.taxes).toEqual([15.06, 0, 0]); // 10% of 150.55, rounded
    expect(r.appliedRules[0]?.description).toBe('SALES TAX');
  });

  it('a credit exactly negates its sale, including half-cent rounding ties', () => {
    // 10% of 33.55 = 3.355 — a half-cent tie. Round-half-up would give 3.36
    // for the sale but -3.35 for the credit; half-away-from-zero keeps the
    // pair symmetric (a reversal must net to exactly zero — L115 review).
    const sale = computeTaxes(PLANT_RULES, ['SALES TAX', null, null], [
      { amount: 33.55, qty: 1, itemTaxGroups: [null, null, null] },
    ]);
    const credit = computeTaxes(PLANT_RULES, ['SALES TAX', null, null], [
      { amount: -33.55, qty: -1, itemTaxGroups: [null, null, null] },
    ]);
    expect(credit.taxes[0]).toBe(-sale.taxes[0]);
    expect(sale.taxes[0] + credit.taxes[0]).toBe(0);
  });

  it('charges no tax for an unmatched customer group', () => {
    const r = computeTaxes(PLANT_RULES, [null, null, null], [
      { amount: 100, qty: 1, itemTaxGroups: [null, null, null] },
    ]);
    expect(r.taxes).toEqual([0, 0, 0]);
    expect(r.appliedRules).toEqual([null, null, null]);
  });

  it('applies per-line item-group overrides independently', () => {
    const rules = [
      rule({ id: 1, entityTaxGroup: 'GST', itemTaxGroup: null, rate: 5 }),
      rule({ id: 2, entityTaxGroup: 'GST', itemTaxGroup: 'A', rate: 8 }),
    ];
    const r = computeTaxes(rules, ['GST', null, null], [
      { amount: 100, qty: 1, itemTaxGroups: [null, null, null] }, // 5% = 5.00
      { amount: 100, qty: 1, itemTaxGroups: ['A', null, null] }, // 8% = 8.00
    ]);
    expect(r.taxes[0]).toBe(13);
  });

  it('adds fixed per-unit amounts (eco-fee style rules)', () => {
    const rules = [rule({ id: 1, entityTaxGroup: 'ECO', taxNumber: 3, rate: 0, amount: 0.25 })];
    const r = computeTaxes(rules, [null, null, 'ECO'], [
      { amount: 100, qty: 4, itemTaxGroups: [null, null, null] },
    ]);
    expect(r.taxes).toEqual([0, 0, 1]); // 4 x 0.25
  });

  it('TaxOnTax compounds on the lower-level tax (PST on GST)', () => {
    const rules = [
      rule({ id: 1, entityTaxGroup: 'CAN', taxNumber: 1, rate: 5 }),
      rule({ id: 2, entityTaxGroup: 'QC', taxNumber: 2, rate: 10, taxOnTax: true }),
    ];
    const r = computeTaxes(rules, ['CAN', 'QC', null], [
      { amount: 100, qty: 1, itemTaxGroups: [null, null, null] },
    ]);
    expect(r.taxes[0]).toBe(5); // 5% of 100
    expect(r.taxes[1]).toBe(10.5); // 10% of (100 + 5)
  });

  it('without TaxOnTax the levels are independent', () => {
    const rules = [
      rule({ id: 1, entityTaxGroup: 'CAN', taxNumber: 1, rate: 5 }),
      rule({ id: 2, entityTaxGroup: 'ON', taxNumber: 2, rate: 8 }),
    ];
    const r = computeTaxes(rules, ['CAN', 'ON', null], [
      { amount: 100, qty: 1, itemTaxGroups: [null, null, null] },
    ]);
    expect(r.taxes).toEqual([5, 8, 0]);
  });

  it('taxes freight via the Freight item group, else the blank rule', () => {
    const withFreightRule = [
      rule({ id: 1, entityTaxGroup: 'GST', itemTaxGroup: null, rate: 5 }),
      rule({ id: 2, entityTaxGroup: 'GST', itemTaxGroup: 'Freight', rate: 2 }),
    ];
    const r1 = computeTaxes(withFreightRule, ['GST', null, null], [], 100);
    expect(r1.taxes[0]).toBe(2); // explicit Freight rule

    const blankOnly = [rule({ id: 1, entityTaxGroup: 'GST', itemTaxGroup: null, rate: 5 })];
    const r2 = computeTaxes(blankOnly, ['GST', null, null], [], 100);
    expect(r2.taxes[0]).toBe(5); // falls back to the blank rule
  });

  it('freight ignores fixed per-unit amounts (no quantity)', () => {
    const rules = [rule({ id: 1, entityTaxGroup: 'GST', itemTaxGroup: 'Freight', rate: 0, amount: 5 })];
    const r = computeTaxes(rules, ['GST', null, null], [], 100);
    expect(r.taxes).toEqual([0, 0, 0]);
  });

  it('rounds each level to cents once, at the total', () => {
    const rules = [rule({ id: 1, entityTaxGroup: 'T', rate: 7.5 })];
    const r = computeTaxes(rules, ['T', null, null], [
      { amount: 0.07, qty: 1, itemTaxGroups: [null, null, null] }, // 0.00525
      { amount: 0.07, qty: 1, itemTaxGroups: [null, null, null] }, // 0.00525
    ]);
    expect(r.taxes[0]).toBe(0.01); // 0.0105 -> 0.01 (not 2 x round(0.00525)=0.02)
  });
});
