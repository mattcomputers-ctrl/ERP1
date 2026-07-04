import { Injectable } from '@nestjs/common';
import { NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { num } from '../sales/trans-math';
import { round2, type JournalEntry } from './journal-format';

// The transaction kinds the legacy QuickBooks agent exported (UG §18.1.2),
// minus master-list sync (customers/suppliers/items are set up in the
// accounting system directly — see ASSUMPTIONS §13).
export const EXPORT_KINDS = ['invoices', 'receipts', 'miscReceipts', 'adjustments', 'builds'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface JournalBuild {
  entries: JournalEntry[];
  warnings: string[];
}

/**
 * Builds double-entry journal entries from ERP1 transactions for a date
 * range, resolving accounts through the legacy GL model:
 * Item.GLGroup -> GLGroupCode(GLCode) -> AccountCode. Header-side accounts
 * (AR / AP / tax / freight) come from app settings with QuickBooks-style
 * defaults. Anything unresolvable lands on the fallback account WITH a
 * warning — the export must never silently drop value.
 */
@Injectable()
export class AccountingJournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async build(from: Date, to: Date, kinds: Set<ExportKind>): Promise<JournalBuild> {
    const warnings: string[] = [];
    const entries: JournalEntry[] = [];

    const [ar, ap, tax1, tax2, tax3, freightAcct, fallback] = await Promise.all([
      this.settings.get('accounting.arAccount', 'Accounts Receivable'),
      this.settings.get('accounting.apAccount', 'Accounts Payable'),
      this.settings.get('accounting.taxAccount1', 'Sales Tax Payable'),
      this.settings.get('accounting.taxAccount2', 'Sales Tax Payable'),
      this.settings.get('accounting.taxAccount3', 'Sales Tax Payable'),
      this.settings.get('accounting.freightAccount', 'Freight Income'),
      this.settings.get('accounting.fallbackAccount', 'Uncategorized'),
    ]);
    const cfg = { ar, ap, tax: [tax1, tax2, tax3], freightAcct, fallback };

    // (GLGroup, GLCode) -> AccountCode, one query — the grid is tiny.
    const grid = await this.prisma.gLGroupCode.findMany();
    const account = (glGroup: string | null | undefined, glCode: string, what: string): string => {
      const hit = glGroup ? grid.find((g) => g.glGroup === glGroup && g.glCode === glCode) : undefined;
      if (hit?.accountCode) return hit.accountCode;
      warnings.push(
        `${what}: no ${glCode} account mapped for GL group '${glGroup ?? '(none)'}' — used '${cfg.fallback}'.`,
      );
      return cfg.fallback;
    };

    if (kinds.has('invoices')) entries.push(...(await this.invoices(from, to, cfg, account, warnings)));
    if (kinds.has('receipts')) entries.push(...(await this.receipts(from, to, 'PO', cfg, account, warnings)));
    if (kinds.has('miscReceipts')) entries.push(...(await this.receipts(from, to, 'MISC', cfg, account, warnings)));
    if (kinds.has('adjustments')) entries.push(...(await this.adjustments(from, to, account, warnings)));
    if (kinds.has('builds')) entries.push(...(await this.builds(from, to, account, warnings)));

    // Money hygiene: round every line to cents and reconcile any residual
    // rounding dust into the LARGEST detail line — the header must stay at
    // the rounded DOCUMENT total (an invoice's AR debit has to equal what
    // the customer was billed; sub-cent per-line rounding must never leak
    // into it), and float artifacts (400 x 2.03 = 811.9999...) must never
    // reach the accounting system.
    for (const e of entries) {
      if (e.lines.length < 2) continue;
      for (const l of e.lines) l.amount = round2(l.amount);
      const residual = round2(e.lines.reduce((s, l) => s + l.amount, 0));
      if (residual !== 0) {
        let biggest = 1;
        for (let i = 2; i < e.lines.length; i++) {
          if (Math.abs(e.lines[i].amount) > Math.abs(e.lines[biggest].amount)) biggest = i;
        }
        e.lines[biggest].amount = round2(e.lines[biggest].amount - residual);
      }
    }

    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    return { entries, warnings };
  }

  // --- invoices (Trans CI): AR debit; Income per item GL group; tax; freight --

  private async invoices(
    from: Date,
    to: Date,
    cfg: { ar: string; tax: string[]; freightAcct: string },
    account: (g: string | null | undefined, c: string, what: string) => string,
    warnings: string[],
  ): Promise<JournalEntry[]> {
    const invoices = await this.prisma.trans.findMany({
      where: { context: 'CI', documentDate: { gte: from, lte: to } },
      orderBy: { id: 'asc' },
      select: {
        id: true, transDocument: true, documentDate: true, billToId: true,
        freightCharge: true, tax1Amount: true, tax2Amount: true, tax3Amount: true,
        reversedTransId: true,
      },
    });
    if (!invoices.length) return [];

    const details = await this.prisma.transDetail.findMany({
      where: { transId: { in: invoices.map((i) => i.id) } },
      select: { transId: true, itemId: true, qty: true, price: true },
    });
    const itemIds = [...new Set(details.map((d) => d.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, glGroup: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const names = await this.partyNames(invoices.map((i) => i.billToId));

    const byTrans = new Map<number, typeof details>();
    for (const d of details) {
      if (d.transId == null) continue;
      const list = byTrans.get(d.transId) ?? [];
      list.push(d);
      byTrans.set(d.transId, list);
    }

    return invoices.map((inv) => {
      const ref = inv.transDocument ?? `CI-${inv.id}`;
      const what = `Invoice ${ref}`;
      // Income credit per GL group (grouped so one invoice = few lines).
      const incomeByAccount = new Map<string, number>();
      let subtotal = 0;
      for (const d of byTrans.get(inv.id) ?? []) {
        const item = d.itemId != null ? itemById.get(d.itemId) : undefined;
        const amount = num(d.qty) * num(d.price);
        subtotal += amount;
        const acct = account(item?.glGroup, 'Income', what);
        incomeByAccount.set(acct, (incomeByAccount.get(acct) ?? 0) + amount);
      }
      const freight = num(inv.freightCharge);
      const taxes = [num(inv.tax1Amount), num(inv.tax2Amount), num(inv.tax3Amount)];
      const total = subtotal + freight + taxes[0] + taxes[1] + taxes[2];
      const lines = [
        { account: cfg.ar, amount: total, memo: null },
        ...[...incomeByAccount.entries()].map(([acct, amt]) => ({ account: acct, amount: -amt, memo: null })),
        ...(freight ? [{ account: cfg.freightAcct, amount: -freight, memo: 'Freight' }] : []),
        ...taxes.flatMap((t, i) => (t ? [{ account: cfg.tax[i], amount: -t, memo: `Tax ${i + 1}` }] : [])),
      ];
      if (inv.reversedTransId != null) warnings.push(`${what} reverses invoice ${inv.reversedTransId} — amounts included as recorded.`);
      return {
        type: 'INVOICE' as const,
        source: 'invoice',
        date: inv.documentDate ?? from,
        refNumber: ref,
        name: inv.billToId != null ? names.get(inv.billToId) ?? null : null,
        memo: null,
        lines,
      };
    });
  }

  // --- receipts (ChangeSet PO/MISC + ChangeSetReceipt) -----------------------
  //
  // PO receipt = a supplier bill: debit the item's Asset, credit AP, valued at
  // the PO line price. MISC receipt = a journal entry: debit Asset, credit the
  // GL group's MiscReceipt account, valued at the received lot's unit cost
  // (native receipts link the sublot; fallback: the item's purchase price).

  private async receipts(
    from: Date,
    to: Date,
    context: 'PO' | 'MISC',
    cfg: { ap: string },
    account: (g: string | null | undefined, c: string, what: string) => string,
    warnings: string[],
  ): Promise<JournalEntry[]> {
    const inRange = await this.prisma.changeSet.findMany({
      where: { context, changeDate: { gte: from, lte: to } },
      orderBy: { id: 'asc' },
      select: { id: true, ordrId: true, changeDate: true, poNumber: true },
    });

    // Reversals (Context 'RVS'+context, back-pointer reverseChangeSetId; the
    // original ChangeSet/receipt stay in place — see inventory reverseReceipt):
    //  - a reversal dated <= 'to' cancels an in-range receipt -> skip it (net
    //    zero within the exported ledger) with a warning;
    //  - a reversal dated IN range whose original predates 'from' must emit a
    //    negated counter-entry (the original was exported in a prior period).
    const rvsContext = `RVS${context}`;
    const reversals = await this.prisma.changeSet.findMany({
      where: {
        context: rvsContext,
        reverseChangeSetId: { not: null },
        OR: [
          { reverseChangeSetId: { in: inRange.map((c) => c.id) } },
          { changeDate: { gte: from, lte: to } },
        ],
      },
      select: { id: true, reverseChangeSetId: true, changeDate: true },
    });
    const reversalByOriginal = new Map(reversals.map((r) => [r.reverseChangeSetId as number, r]));

    const inRangeIds = new Set(inRange.map((c) => c.id));
    const priorOriginalIds = reversals
      .map((r) => r.reverseChangeSetId as number)
      .filter((id) => !inRangeIds.has(id));
    const priorOriginals = priorOriginalIds.length
      ? await this.prisma.changeSet.findMany({
          where: { id: { in: priorOriginalIds }, context },
          select: { id: true, ordrId: true, changeDate: true, poNumber: true },
        })
      : [];

    const changeSets = [...inRange, ...priorOriginals];
    if (!changeSets.length) return [];
    const receipts = await this.prisma.changeSetReceipt.findMany({
      where: { changeSetId: { in: changeSets.map((c) => c.id) } },
      select: { changeSetId: true, ordDetailId: true, itemId: true, sublotId: true, psQty: true },
    });
    if (!receipts.length) return [];
    const csById = new Map(changeSets.map((c) => [c.id, c]));

    const lineIds = [...new Set(receipts.map((r) => r.ordDetailId).filter((v): v is number => v != null))];
    const lines = lineIds.length
      ? await this.prisma.ordDetail.findMany({ where: { id: { in: lineIds } }, select: { id: true, price: true } })
      : [];
    const priceByLine = new Map(lines.map((l) => [l.id, num(l.price)]));
    // By-package lines carry the PACKAGE price on OrdDetail.price — the
    // per-stock-unit cost divides by the package quantity (exactly how
    // receiving costs the minted lot; the priced row IS the qualifying row).
    const pricings = lineIds.length
      ? await this.prisma.ordDetailPricing.findMany({
          where: { ordDetailId: { in: lineIds } },
          select: { ordDetailId: true, priceByPackage: true, entityQuantity: true },
        })
      : [];
    const pricingByLine = new Map(pricings.map((p) => [p.ordDetailId, p]));
    const unitPriceForLine = (lineId: number): number => {
      const price = priceByLine.get(lineId) ?? 0;
      const pricing = pricingByLine.get(lineId);
      if (pricing?.priceByPackage && num(pricing.entityQuantity) > 0) return price / num(pricing.entityQuantity);
      return price;
    };

    const itemIds = [...new Set(receipts.map((r) => r.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, itemCode: true, glGroup: true, purchasePrice: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Lot unit costs for MISC valuation (sublot -> lot.unitCost).
    const sublotIds = [...new Set(receipts.map((r) => r.sublotId).filter((v): v is number => v != null))];
    const sublots = sublotIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: sublotIds } }, select: { id: true, lot: true } })
      : [];
    const lotCodes = [...new Set(sublots.map((s) => s.lot).filter((v): v is string => v != null))];
    const lots = lotCodes.length
      ? await this.prisma.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, unitCost: true } })
      : [];
    const costByLot = new Map(lots.map((l) => [l.lot, l.unitCost]));
    const lotBySublot = new Map(sublots.map((s) => [s.id, s.lot]));

    // Supplier names via the PO's entity.
    const orders = await this.prisma.ordr.findMany({
      where: { id: { in: [...new Set(changeSets.map((c) => c.ordrId).filter((v): v is number => v != null))] } },
      select: { id: true, entityId: true },
    });
    const supplierByOrder = new Map(orders.map((o) => [o.id, o.entityId]));
    const names = await this.partyNames(orders.map((o) => o.entityId));

    const out: JournalEntry[] = [];
    for (const r of receipts) {
      const cs = csById.get(r.changeSetId);
      if (!cs) continue;
      const item = r.itemId != null ? itemById.get(r.itemId) : undefined;
      const qty = num(r.psQty);
      const what = `${context === 'PO' ? 'Receipt' : 'Misc receipt'} CS ${r.changeSetId}${item?.itemCode ? ` (${item.itemCode})` : ''}`;

      // Reversal disposition (see the header comment).
      const reversal = reversalByOriginal.get(r.changeSetId);
      const originalInRange = inRangeIds.has(r.changeSetId);
      let sign = 1;
      let date = cs.changeDate ?? from;
      let refPrefix = '';
      if (originalInRange && reversal && reversal.changeDate != null && reversal.changeDate <= to) {
        warnings.push(`${what}: reversed on ${reversal.changeDate.toISOString().slice(0, 10)} — excluded (nets to zero within this export).`);
        continue;
      }
      if (!originalInRange) {
        // Only here because an in-range reversal points at it: emit the
        // negated counter-entry dated at the reversal.
        if (!reversal || reversal.changeDate == null) continue;
        sign = -1;
        date = reversal.changeDate;
        refPrefix = 'RVS ';
        warnings.push(`${what}: reversal of a prior-period receipt — negated counter-entry emitted.`);
      }

      let unitCost: number;
      if (context === 'PO') {
        unitCost = r.ordDetailId != null ? unitPriceForLine(r.ordDetailId) : 0;
        if (!unitCost) warnings.push(`${what}: PO line has no price — booked at 0.`);
      } else {
        const lot = r.sublotId != null ? lotBySublot.get(r.sublotId) : undefined;
        const lotCost = lot != null ? costByLot.get(lot) : undefined;
        unitCost = lotCost != null ? Number(lotCost) : num(item?.purchasePrice);
        if (lotCost == null && item?.purchasePrice == null) warnings.push(`${what}: no lot cost or purchase price — booked at 0.`);
      }
      const value = sign * qty * unitCost;
      const supplierId = cs.ordrId != null ? supplierByOrder.get(cs.ordrId) : null;
      const assetAcct = account(item?.glGroup, 'Asset', what);
      out.push(
        context === 'PO'
          ? {
              type: 'BILL',
              source: 'receipt',
              date,
              refNumber: refPrefix + (cs.poNumber ?? String(cs.ordrId ?? r.changeSetId)),
              name: supplierId != null ? names.get(supplierId) ?? null : null,
              memo: `${refPrefix}Receipt ${item?.itemCode ?? ''} x ${qty}`.trim(),
              lines: [
                { account: cfg.ap, amount: -value, memo: null },
                { account: assetAcct, amount: value, memo: null },
              ],
            }
          : {
              type: 'GENERAL JOURNAL',
              source: 'miscReceipt',
              date,
              refNumber: `${refPrefix}CS${r.changeSetId}`,
              name: null,
              memo: `${refPrefix}Misc receipt ${item?.itemCode ?? ''} x ${qty}`.trim(),
              lines: [
                { account: assetAcct, amount: value, memo: null },
                { account: account(item?.glGroup, 'MiscReceipt', what), amount: -value, memo: null },
              ],
            },
      );
    }
    return out;
  }

  // --- adjustments (native COUNT change sets, delta from the audit trail) ----

  private async adjustments(
    from: Date,
    to: Date,
    account: (g: string | null | undefined, c: string, what: string) => string,
    warnings: string[],
  ): Promise<JournalEntry[]> {
    // ERP1-native adjustments only (id >= 1e9): the atomic audit entry records
    // both the ChangeSet id and the parcel's qty before/after. Legacy COUNT
    // change sets carry their value in InvMovement, which this install's
    // import mirrors but ERP1 doesn't re-cost — excluded, with a note in
    // ASSUMPTIONS.
    const changeSets = await this.prisma.changeSet.findMany({
      where: { context: 'COUNT', changeDate: { gte: from, lte: to }, id: { gte: NATIVE_ID_BASE } },
      select: { id: true, changeDate: true },
    });
    if (!changeSets.length) return [];

    const csChanges = await this.prisma.auditFieldChange.findMany({
      where: { tableName: 'ChangeSet', recordId: { in: changeSets.map((c) => String(c.id)) } },
      select: { auditLogId: true, recordId: true },
    });
    const qtyChanges = await this.prisma.auditFieldChange.findMany({
      where: { auditLogId: { in: csChanges.map((c) => c.auditLogId) }, tableName: 'Inventory', fieldName: 'qty' },
      select: { auditLogId: true, recordId: true, oldValue: true, newValue: true },
    });
    const qtyByAudit = new Map(qtyChanges.map((c) => [String(c.auditLogId), c]));
    const csDateById = new Map(changeSets.map((c) => [String(c.id), c.changeDate]));

    const parcelIds = [...new Set(qtyChanges.map((c) => Number(c.recordId)).filter((v) => Number.isFinite(v)))];
    const parcels = parcelIds.length
      ? await this.prisma.inventory.findMany({ where: { id: { in: parcelIds } }, select: { id: true, itemId: true, sublotId: true } })
      : [];
    const parcelById = new Map(parcels.map((p) => [p.id, p]));
    const itemIds = [...new Set(parcels.map((p) => p.itemId).filter((v): v is number => v != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemCode: true, glGroup: true, purchasePrice: true } })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const sublotIds = [...new Set(parcels.map((p) => p.sublotId).filter((v): v is number => v != null))];
    const sublots = sublotIds.length
      ? await this.prisma.sublot.findMany({ where: { id: { in: sublotIds } }, select: { id: true, lot: true } })
      : [];
    const lotCodes = [...new Set(sublots.map((s) => s.lot).filter((v): v is string => v != null))];
    const lots = lotCodes.length
      ? await this.prisma.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, unitCost: true } })
      : [];
    const costByLot = new Map(lots.map((l) => [l.lot, l.unitCost]));
    const lotBySublot = new Map(sublots.map((s) => [s.id, s.lot]));

    const out: JournalEntry[] = [];
    for (const c of csChanges) {
      const qc = qtyByAudit.get(String(c.auditLogId));
      const what = `Adjustment CS ${c.recordId}`;
      if (!qc) {
        warnings.push(`${what}: no quantity change found in the audit trail — skipped.`);
        continue;
      }
      const delta = Number(qc.newValue) - Number(qc.oldValue);
      if (!Number.isFinite(delta) || delta === 0) continue;
      const parcel = parcelById.get(Number(qc.recordId));
      const item = parcel?.itemId != null ? itemById.get(parcel.itemId) : undefined;
      const lot = parcel?.sublotId != null ? lotBySublot.get(parcel.sublotId) : undefined;
      const lotCost = lot != null ? costByLot.get(lot) : undefined;
      const unitCost = lotCost != null ? Number(lotCost) : num(item?.purchasePrice);
      if (lotCost == null && item?.purchasePrice == null) warnings.push(`${what}: no cost basis — booked at 0.`);
      const value = delta * unitCost;
      out.push({
        type: 'GENERAL JOURNAL',
        source: 'adjustment',
        date: csDateById.get(c.recordId ?? '') ?? from,
        refNumber: `CS${c.recordId}`,
        name: null,
        memo: `Inventory adjustment ${item?.itemCode ?? ''} ${delta > 0 ? '+' : ''}${delta}`.trim(),
        lines: [
          { account: account(item?.glGroup, 'Asset', what), amount: value, memo: null },
          { account: account(item?.glGroup, 'COUNT', what), amount: -value, memo: null },
        ],
      });
    }
    return out;
  }

  // --- builds (native completed production orders) ----------------------------
  //
  // Credit each consumed ingredient's Asset at its recorded consumption value
  // (the order's source='consumption' genealogy edges x the consumed lot's own
  // unit cost — exactly what the valuation engine rolled into the produced
  // lot), debit the product's Asset with the total. Native orders only —
  // imported completions carry no ERP1-shaped consumption record.

  private async builds(
    from: Date,
    to: Date,
    account: (g: string | null | undefined, c: string, what: string) => string,
    warnings: string[],
  ): Promise<JournalEntry[]> {
    const orders = await this.prisma.ordr.findMany({
      where: {
        id: { gte: NATIVE_ID_BASE },
        context: { in: ['MFBA', 'MFPP'] },
        status: { in: ['CMP', 'CLS'] },
        dateCompleted: { gte: from, lte: to },
      },
      select: { id: true, context: true, dateCompleted: true, manfLot: true },
    });
    if (!orders.length) return [];

    const edges = await this.prisma.lotGenealogy.findMany({
      where: { viaOrdrId: { in: orders.map((o) => o.id) }, source: 'consumption' },
      select: { viaOrdrId: true, parentLot: true, qty: true },
    });
    const lotCodes = [...new Set(edges.map((e) => e.parentLot))];
    const lots = lotCodes.length
      ? await this.prisma.lot.findMany({ where: { lot: { in: lotCodes } }, select: { lot: true, itemId: true, unitCost: true } })
      : [];
    const lotByCode = new Map(lots.map((l) => [l.lot, l]));

    // Product item per order: the PK line.
    const pkLines = await this.prisma.ordDetail.findMany({
      where: { ordrId: { in: orders.map((o) => o.id) }, context: 'PK' },
      select: { ordrId: true, itemId: true },
    });
    const productByOrder = new Map(pkLines.map((l) => [l.ordrId, l.itemId]));

    const itemIds = [
      ...new Set(
        [...lots.map((l) => l.itemId), ...pkLines.map((l) => l.itemId)].filter((v): v is number => v != null),
      ),
    ];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, itemCode: true, glGroup: true, purchasePrice: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    const out: JournalEntry[] = [];
    for (const o of orders) {
      const what = `Build order #${o.id}`;
      const orderEdges = edges.filter((e) => e.viaOrdrId === o.id);
      if (!orderEdges.length) {
        warnings.push(`${what}: completed with no recorded consumption — skipped.`);
        continue;
      }
      // Consumed value grouped by ingredient item's Asset account.
      const creditByAccount = new Map<string, number>();
      let total = 0;
      for (const e of orderEdges) {
        const lot = lotByCode.get(e.parentLot);
        const item = lot?.itemId != null ? itemById.get(lot.itemId) : undefined;
        // Same cost basis the valuation engine rolled into the produced lot:
        // the consumed lot's own unitCost, falling back to the item's
        // purchase price (legacy FIFO lots of not-traced items carry none).
        const unitCost = lot?.unitCost != null ? Number(lot.unitCost) : num(item?.purchasePrice);
        if (lot?.unitCost == null && item?.purchasePrice == null) {
          warnings.push(`${what}: lot ${e.parentLot} has no unit cost or purchase price — its consumption booked at 0.`);
        }
        const value = num(e.qty) * unitCost;
        total += value;
        const acct = account(item?.glGroup, 'Asset', what);
        creditByAccount.set(acct, (creditByAccount.get(acct) ?? 0) + value);
      }
      const productItem = productByOrder.get(o.id) != null ? itemById.get(productByOrder.get(o.id)!) : undefined;
      out.push({
        type: 'GENERAL JOURNAL',
        source: 'build',
        date: o.dateCompleted ?? from,
        refNumber: `MF${o.id}`,
        name: null,
        memo: `Build ${productItem?.itemCode ?? ''} lot ${o.manfLot ?? ''}`.trim(),
        lines: [
          { account: account(productItem?.glGroup, 'Asset', what), amount: total, memo: null },
          ...[...creditByAccount.entries()].map(([acct, amt]) => ({ account: acct, amount: -amt, memo: null })),
        ],
      });
    }
    return out;
  }

  // --- helpers ----------------------------------------------------------------

  /** Entity id -> display name (Address name via the party pattern is overkill here — EntityCode suffices for the export). */
  private async partyNames(ids: Array<number | null | undefined>): Promise<Map<number, string>> {
    const clean = [...new Set(ids.filter((v): v is number => v != null))];
    if (!clean.length) return new Map();
    const rows = await this.prisma.entity.findMany({ where: { id: { in: clean } }, select: { id: true, entityCode: true } });
    return new Map(rows.map((r) => [r.id, r.entityCode ?? String(r.id)]));
  }
}
