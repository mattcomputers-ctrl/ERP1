// Pure tax computation (UG §17.4.7), dependency-free so it is unit-testable.
//
// CMS has three independent tax levels (1=federal, 2=state/provincial,
// 3=municipal/other). For each level the rule is resolved per taxed line:
//   1. exact match on (customer's entity tax group, line item's item tax group)
//   2. else the rule for (customer group, BLANK item group)
//   3. else no tax at that level for that line.
// Blank ('' and NULL) are equivalent group values.
//
// A rule charges Rate % of the taxed value plus a fixed Amount per unit
// quantity. TaxOnTax applies the rate to the value INCLUSIVE of the tax
// already computed at higher (lower-numbered) levels for that line — levels
// are therefore computed in order 1 -> 2 -> 3.
//
// Freight (UG §17.4.7.2) is taxed using the item tax group named 'Freight',
// falling back to the blank-item-group rule. Only Rate applies to freight
// (there is no unit quantity for a fixed per-unit Amount to multiply).

export interface TaxRuleRow {
  id: number;
  description: string | null;
  itemTaxGroup: string | null;
  entityTaxGroup: string | null;
  rate: number | null;
  amount: unknown; // Prisma Decimal | number | null
  taxOnTax: boolean | null;
  taxNumber: number | null;
}

export interface TaxLine {
  /** Line value being taxed (qty x price), in document currency. */
  amount: number;
  /** Unit quantity, for fixed per-unit tax amounts. */
  qty: number;
  /** The item's tax group per level (Item.Tax1Group/Tax2Group/Tax3Group). */
  itemTaxGroups: [string | null, string | null, string | null];
}

export interface TaxResult {
  /** Tax totals per level (index 0 = level 1), rounded to cents. */
  taxes: [number, number, number];
  /** The rule applied per level (first one that fired), for document print. */
  appliedRules: [TaxRuleRow | null, TaxRuleRow | null, TaxRuleRow | null];
}

const FREIGHT_GROUP = 'freight';

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
const asNum = (v: unknown) => (v == null ? 0 : Number(v));
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Resolve the rule for one (level, entity group, item group) — UG order. */
export function resolveRule(
  rules: TaxRuleRow[],
  level: 1 | 2 | 3,
  entityGroup: string | null,
  itemGroup: string | null,
): TaxRuleRow | null {
  const forLevel = rules.filter(
    (r) => (r.taxNumber ?? 0) === level && norm(r.entityTaxGroup) === norm(entityGroup),
  );
  const exact = forLevel.find((r) => norm(r.itemTaxGroup) === norm(itemGroup));
  if (exact) return exact;
  if (norm(itemGroup) !== '') {
    const blank = forLevel.find((r) => norm(r.itemTaxGroup) === '');
    if (blank) return blank;
  }
  return null;
}

/**
 * Compute the three tax buckets for a document.
 *
 * @param rules        all TaxRule rows
 * @param entityGroups the customer's tax groups per level (Entity.Tax1Group..3)
 * @param lines        taxed lines (amount, qty, per-level item groups)
 * @param freight      freight charge (taxed via the 'Freight' item group)
 */
export function computeTaxes(
  rules: TaxRuleRow[],
  entityGroups: [string | null, string | null, string | null],
  lines: TaxLine[],
  freight = 0,
): TaxResult {
  const taxes: [number, number, number] = [0, 0, 0];
  const appliedRules: [TaxRuleRow | null, TaxRuleRow | null, TaxRuleRow | null] = [null, null, null];

  // Per-line running tax so TaxOnTax at level n can include levels < n.
  const lineTax = lines.map(() => 0);
  let freightTax = 0;

  for (const level of [1, 2, 3] as const) {
    const entityGroup = entityGroups[level - 1];
    let levelTotal = 0;

    lines.forEach((line, i) => {
      const rule = resolveRule(rules, level, entityGroup, line.itemTaxGroups[level - 1]);
      if (!rule) return;
      const base = rule.taxOnTax ? line.amount + lineTax[i] : line.amount;
      const t = (asNum(rule.rate) / 100) * base + asNum(rule.amount) * line.qty;
      lineTax[i] += t;
      levelTotal += t;
      if (!appliedRules[level - 1]) appliedRules[level - 1] = rule;
    });

    if (freight !== 0) {
      // resolveRule already falls back to the blank-item-group rule when no
      // explicit 'Freight' rule exists (UG §17.4.7.2).
      const rule = resolveRule(rules, level, entityGroup, FREIGHT_GROUP);
      if (rule) {
        const base = rule.taxOnTax ? freight + freightTax : freight;
        const t = (asNum(rule.rate) / 100) * base;
        freightTax += t;
        levelTotal += t;
        if (!appliedRules[level - 1]) appliedRules[level - 1] = rule;
      }
    }

    taxes[level - 1] = round2(levelTotal);
  }

  return { taxes, appliedRules };
}
