# Assumptions

Decisions made autonomously where the legacy system was ambiguous or this
install's data diverged from the vendor docs. Each entry records the evidence
and the chosen behavior so the user can review (and reverse) them later.

## Recipe management (§4, built 2026-07)

Evidence base: live-DB sweep + User Guide ch.5 + release notes 7.16–7.22
(discovery reports 2026-07-02).

1. **Versioning = `.NN` suffix on RecipeNumber, single active per product.**
   Every RecipeNumber is unique (19,074 rows, zero duplicates); revisions are
   sibling rows `BASE.01 … BASE.09`; `ParamsRecipeManager` has
   `VersionSeparator='.'`, `VersionLength=2`, `SingleActiveRecipe=True`; zero
   items have two active published batching recipes. ERP1 mirrors this: Clone
   suggests `BASE.(max+1)` (2-digit padded; grows to 3 digits past .99 rather
   than failing), and Publish/Activate atomically deactivates other active
   published recipes producing the same item (same context), rework recipes
   exempt (vendor 7.21 behavior). The legacy `Version` column is kept as an
   internal save counter (incremented per edit), matching observed data.
2. **Editor scope = observed usage, not the full vendor editor.** This install
   uses none of: Add Methods (no dispense-method column populated), purity/
   filler, percent modes (persisted), Use Groups, Adjust steps, Record
   Parameters (2 rows), recipe libraries (1 empty DEFAULT), rich-text comments
   (`RecipeDetail.Comment` NULL on all 177,307 rows), Coatings, Other Items,
   planning tasks, WeighRule/ContinueFrom/MeshSize/TimeToAdd/ScaleTarget/
   Repeat/Adj* (100% NULL). The editor therefore authors: header fields + an
   ordered procedure of **ingredient** (item + qty) and **instruction** (text
   ≤256 chars) lines + one product (PK) line. Vendor features above are
   deferred until the plant needs them.
3. **Batching recipes are stored normalized per 1 lb of product.** 5,650 of
   5,652 active published RMBA recipes have PK QtyReqd = 1.0 and UI quantities
   summing to 1.0 (2 legacy outliers). The editor lets the user author at any
   formula basis (default 100 lb) and normalizes to per-1-lb on save; the
   structural convention `BA.TotalWeight = PK.TotalWeight = 0.45359237` (1 lb
   in kg, the full conversion factor carried by every live BA/PK row) and
   `PK.TotalWeightPercent = 100` is written to match live rows. Re-saving an
   untouched line compares within a relative epsilon (the UI displays at 6
   decimals), so display round-trips don't rewrite values or pollute the audit.
4. **Native recipes carry no UB line.** Legacy UB ("use bulk") lines exist on
   all 11,893 batching recipes with an opaque `UseFrom` pointer whose value has
   no derivable relationship to line numbers/exec order (checked across 6+
   recipes). Nothing in ERP1 consumes UB lines (order copies render as blank
   rows on the batch sheet at most). Native recipes therefore omit them; the
   `UseFrom` column is now mirrored (schema + import) so the batch-execution
   increment can decode and synthesize them later.
5. **Structure written natively**: RMBA = BA root (Phase 'PHASE', ExecOrder 1,
   BatchType '2') → UI/INSTR children in ExecOrder 2..N+1 (UI additionally
   numbered Line 1..k) → PK child of BA — mirrors the live shape exactly.
   RMPP = PK root → UI children (live RMPP recipes contain only PK+UI lines —
   no instructions, no BA). **Deliberate RMPP extension**: native packaging
   procedures number their lines (ExecOrder 1..N, ingredients Line 1..k) and
   may carry INSTR lines, whereas all imported RMPP rows have NULL
   ExecOrder/Line — the numbering gives deterministic ordering and is harmless
   to consumers (order creation copies lines by the same sort). All native
   RecipeDetail rows are written with explicit `Inactive = false` (a NULL
   would be dropped by the `NOT inactive` filters).
6. **Publish runs Verify** (vendor: publish auto-verifies): requires a product
   (PK) line with item + qty > 0, ≥1 active ingredient line, every active
   ingredient priced with a valid item + qty > 0 (zero-qty ingredients are a
   vendor *warning* but block publish here — safer for standard execution),
   and a non-empty recipe comment (vendor: required field, used as the
   revision note). Published recipes are immutable (edit = clone a new
   version); there is no unpublish (vendor-confirmed); unpublished recipes are
   deletable (7.18 parity); only published recipes can be de/re-activated.
7. **Publish is e-sign capable, not approval-routed.** Legacy gates publish
   via the Approval/Workflow tables, which are 0-row in this install. ERP1
   gates publish with the `recipe.publish` secured item — the actor's group
   must hold its PERFORM (allow) grant, a contemporaneous reason is required
   when `requireReason` is on (the stored recipe comment does NOT satisfy it),
   and signature/witness are operator-enableable — not the blocking-approval
   engine. Routing publish through ApprovalRequest is a possible follow-up
   (OPEN_QUESTIONS). All recipe mutations (publish/activate/edit/delete)
   serialize on the shared native-id advisory lock with state re-read inside
   the transaction, so the single-active rule and published-immutability hold
   under concurrency. The recipe pricing endpoint exposes supplier purchase
   pricing and is therefore gated by `purchasing.priceDetails` (not just
   recipe browsing); recipes born `Shared = false` (matches all live rows).
8. **Expected cost = vendor §5.3.1 algorithm, purchased ingredients only.**
   Per ingredient: for each supplier's effective price version, evaluate every
   quantity-break tier (order max(needed, tierMin) at tier price), take the
   cheapest total; across suppliers take the lowest; report excess qty/cost
   when the chosen tier's minimum exceeds the need. Falls back to
   `Item.standardCost` when no supplier prices the item. Sub-recipe recursion
   (legacy `Item.CostingRecipe`, not mirrored yet) is deferred.
9. **Order creation now requires published + active recipes** (vendor rule;
   previously unenforced in ERP1 because imported data made it moot — the
   moment the editor creates drafts/revisions this becomes load-bearing).
10. **RMPR recipes (36 rows) and the RMBAL library row are view-only** — not
    editable, not orderable, unexplained context; left as imported.

## Guided batch execution (§5/§6, built 2026-07)

Evidence base: live-DB sweep of executed MFBA orders (`OrdDetail` quantities /
`ExecStatus`, order 189170 walked line-by-line, 27.6K completed orders
aggregated), 2026-07-02.

1. **Actuals live on the legacy columns.** On executed batches each material
   (UI) line stores the planned quantity in `QtyReqd` and the operator's
   actual in `QtyUsed` (they genuinely differ — e.g. 16 planned / 20 actual),
   with per-line `ExecStatus` NST → CMP; `QtyEntered` is just a display string
   ("16 lb"). ERP1's record-line endpoint writes exactly these columns. The
   product (PK) line is stamped `ExecStatus='STD'` at completion and the
   actual yield lives on `Ordr.ActualBatchSize` (PK `QtyUsed` is usually NULL
   in legacy), which ERP1 mirrors.
2. **The executed lifecycle ends at CMP.** 27,591 of 27,745 MFBA orders sit at
   Status `CMP`; the 83 `CLS` orders have *all* lines NST — Closed was an
   administrative cancel of never-executed orders, not a post-completion
   state. ERP1 keeps its NST→RLS→CMP→CLS lifecycle but treats per-line
   execution as an RLS-only activity. The one-row `BAT` status (mid-execution)
   is not adopted — a released order is simply executable.
3. **Batch additions are appended at actuals.** Legacy added extra UI lines to
   released orders with `QtyReqd = QtyUsed = StdQty =` the actual quantity
   added, at the end of the procedure. ERP1's batch-addition endpoint mirrors
   that shape (native id ≥ 1e9, next Line/ExecOrder), born already-executed.
4. **In-process test RESULTS are an ERP1 extension.** `OrdDetailTest` has no
   result column anywhere in the legacy schema — IPT results were handwritten
   on the paper ticket (electronic results exist only at release level via
   LIMS `LocationSampleTest`). ERP1 adds native `erp1_result/erp1_passed/
   erp1_result_by/erp1_result_at` columns; pass/fail is computed against the
   line's own Min/Max (same semantics as LIMS result entry); recording is
   allowed while Released or Completed (QC writes up results after close-out);
   the batch sheet prints recorded results and stays blank for hand-writing
   otherwise. Recall/CofA continue to read the release-level LIMS results.
5. **Per-line lot capture is the forward-lineage extension.** Legacy never
   recorded WHICH raw lots a batch consumed (OrdDetailCommit is packaging-only
   in this install). Recording a lot-traced line requires the specific lots
   (summing to the actual); they deplete on-hand, write consumption genealogy
   edges, and re-roll the produced lot's real cost — the same engine as the
   order-level consume-lots, now per line. Not-traced items deplete FIFO.
6. **Tolerances warn, never block.** `PercentUnder/PercentOver` are unset on
   the live recipe lines; where present ERP1 computes the bounds and returns a
   warning with the recorded actual (the plant records what actually
   happened). Re-recording a recorded line is refused — corrections go through
   the audited inventory adjust, preserving the as-executed record.
7. **Material variance = QtyUsed vs QtyReqd, costed at real consumed cost.**
   The variance report prices each line at the weighted unit cost of what the
   order actually consumed (its consumption genealogy edges), falling back to
   `Item.PurchasePrice`; yield = ActualBatchSize vs PK QtyReqd, reported only
   once the order is Completed/Closed (ActualBatchSize is seeded with the
   PLANNED size at creation, so before completion there is no actual). The
   report exposes unit costs, so it is gated by its own `orders.variance`
   program rather than the browse program. Legacy's InventoryUsed/
   InventoryCost graph is a costing artifact, not mirrored — ERP1's valuation
   engine owns costing.
8. **Concurrent stock movement serializes on locked parcel reads.** The
   valuation depleters read Inventory parcels `SELECT … FOR UPDATE` in
   ascending-id order (multi-agent review finding: the prior plain reads were
   a lost-update race once two operators could dispense the same lot from two
   orders at once), dispensed lots are consumed in sorted order (no lock-order
   deadlocks), the order-level consume endpoints take the same Ordr row lock
   as the per-line writers (cost roll-ups never race on partial edge sets),
   and completion re-rolls each produced lot's per-unit cost at the ACTUAL
   yield (during execution the divisor is necessarily the planned size).
   Proven by a concurrent-dispense integration test (conservation of stock).

## Order reversal — un-complete a batch (§5, built 2026-07-03)

1. **Reversing a COMPLETED order is an ERP1 extension.** The vendor forbade it
   ("completed MF Receipts and Packaging transactions cannot be reversed", UG
   §6.11.10) and offered only transaction-level reversal while the order was
   still open (Reverse Receipt in Express Execution, Unpackage/RVSMFP, Reverse
   Dispense). The plant asked for a completed-batch reversal; ERP1 models it
   on legacy's observed data shape: the ONE fully-reversed order in the live
   DB (189797) went back to `RLS` with `QtyUsed` cleared to NULL, UI lines
   back to `NST`, produced on-hand removed, and Lot/Sublot identity rows kept.
2. **One reversing `RVSMFP` ChangeSet covers the whole un-complete.** RVSMFP
   is the only manufacturing reversal context in the live data (389 rows, on
   both MFBA and MFPP orders; there is no RVSMF — consumption corrections were
   counter-receipt pairs inside the same MF changeset). ERP1 execution writes
   no forward ChangeSet, so the reversing set carries no `ReverseChangeSet`
   back-pointer; the `Ordr` link identifies the reversed completion and the
   CMP re-assert under the order row lock is the double-reversal guard. Like
   legacy, the reversal is effective-dated to the posting it reverses
   (`ChangeDate` = the order's `DateCompleted`).
3. **The vendor's 7.17 unpackage guard is the precondition.** Release Notes
   7.17: "Unpackage will now give an error if there have been any inventory
   transactions against the container being reversed." ERP1 applies it per
   produced (PK) lot: reversal is refused unless the produced stock is exactly
   the one parcel completion minted at the full produced quantity (or no
   parcel, when completion had no location to mint into), plus explicit
   refusals when a produced lot appears as a genealogy parent (consumed by
   another batch — even a shortfall consumption that depleted nothing) or in
   `shipment_lot` (shipped).
4. **Only ERP1-completed (native-id) orders are reversible.** An imported
   legacy completion's footprint (InvMovement double-entry ledger, restored
   commitments, residual packout parcels) is not ERP1-shaped — "reversing" it
   would corrupt rather than restore. Historical corrections on imported
   orders are audited inventory adjusts.
5. **Consumed materials are restored from the consumption edge set.** Every
   consumption path (per-line record, batch additions, order-level consume
   endpoints) writes `lot_genealogy source='consumption'` edges keyed
   `via_ordr`, so restoring those quantities is the exact inverse: each lot's
   restored qty is credited to its lowest-id parcel (the one consumption drew
   from first), or a parcel is minted at the receiving location when none is
   left to credit. The FULL recorded quantity is restored — a shortfall at
   consumption time meant on-hand already lagged the recorded actual (flagged
   then, in the execution audit). The edges are then deleted (recall must not
   trace a reversed batch; the audit trail keeps both moves) and the produced
   lot's rolled-up `unitCost` is cleared with its basis.
6. **Lines reset, nothing deleted.** Executed UI/INSTR lines go back to
   `ExecStatus NST` with `QtyUsed` NULL (the legacy 189797 shape); batch-
   addition lines are kept and reset the same way (they remain on the
   procedure as the record of the addition, re-recordable or skippable on
   re-execution); the PK completion stamp is un-stamped `STD -> NST` (ERP1
   symmetry with complete(); legacy's lone example left STD — documented
   deviation). Recorded IPT results are kept — the tests were physically
   performed on the batch. `ActualBatchSize` returns to the planned size (the
   PK line's required qty) since the actual-yield recording is reversed.
7. **Reversal is signed like the completion it undoes.** A new `order.reverse`
   secured item (seeded reason + signature, witness optional, operator-
   tunable) gates it with the same fail-safe resolution as `order.complete`;
   the e-signature commits atomically with the reversal. Program:
   `orders.reverse`. Closed orders are not reversible (CLS is final).
8. **Reversal concurrency design (multi-agent review findings, fixed).** The
   lifecycle is no longer monotonic (CMP can go back to RLS), so EVERY
   lifecycle transition (release/complete/close) now re-asserts its
   precondition under the Ordr row lock inside its transaction — without
   that, a close queued behind an in-flight reversal would stamp the terminal
   CLS onto a just-reversed order (unrecoverable), and a completion stalled in
   its signature verify could re-mint against an empty consumption record.
   Every consumption/shipment writer (per-line record, order-level consumes,
   ship-lots) now DEPLETES before writing its lineage/shipment record: the
   depletion serializes on the parcel row locks, so a reversal either sees the
   committed depletion (untouched check refuses) or commits first (the record
   lands sequentially after, as a plain shortfall — the legal consume-after-
   reversal shape). And EVERY multi-parcel acquisition in the system — the
   reversal's produced+restored scan, multi-lot specific depletion
   (`ValuationService.depleteSpecificMany`), and multi-item FIFO depletion
   (`depleteFifoMany`) — locks its parcels in ONE global ascending-id
   FOR UPDATE scan. One statement, one total order: no pair of concurrent
   acquirers can invert. (An adversarial verifier empirically reproduced a
   40P01 deadlock between the reversal's single scan and the previous
   per-lot lexical-order depletion loops — two different total orders — so
   the loops were replaced with the single-scan batch forms; the lock order
   and the FIFO draw order are independent concerns.) The two residual
   spots that predated the convention are now aligned too (2026-07-03):
   `InventoryService.transfer` locks its source + merge-destination parcels
   in one ascending scan — which also fixed its unlocked read-modify-write,
   where a concurrent depletion could be silently overwritten (depleters
   don't take the advisory lock that serializes transfers) — and
   lot-tracking enablement locks the parcels it wipes in one ascending scan
   before its DELETE (a bare DELETE acquires row locks in plan order). Both
   are pinned by race integration tests.

## Incremental import sync (§0, built 2026-07-03)

1. **The watermark is the legacy `Log` id, not `Version`.** Schema Report §9
   assumed per-row `Version` could drive incremental sync — live discovery
   disproved it: `Version` is a small per-row optimistic-concurrency counter
   (max Item.Version = 24; the app XML shows CheckVersion/UpdateVersion
   steps), useless as a change marker, and absent from ~19 mirrored tables
   (TransDetail, Release, Inventory, RecipeDetail, OrdDetailCommit, ...).
   `Log` (one row per user operation, identity PK, monotonic — one clock-skew
   inversion in 666K rows; identity-cache gaps of ~1000 are normal) +
   `LogResult` (one row per AFFECTED ROW: TableName, key column, key value;
   24.2M rows, indexed on (TableName, FieldName, FieldValue, Log) and
   (Log, Step)) are the change feed. Failed operations roll back and leave no
   LogResult rows.
2. **Sync = re-pull touched keys since the watermark.** `SELECT DISTINCT
   TableName, FieldName, FieldValue FROM LogResult WHERE Log > W AND Log <=
   W2`, keys grouped per key-column signature and re-pulled parameterized +
   chunked (column names validated against INFORMATION_SCHEMA — LogResult
   text is never interpolated). Key quirks handled: bulk Item ops key by
   `ItemCode` (one op can touch 18K items — DISTINCT dedupe is mandatory),
   some OrdDetail touches key by `Item`, the `AddressRef` VIEW fronts
   AddressReference with comma-joined composite keys, `SubLot` cases
   differently. An unresolvable key column falls back to a wholesale re-copy
   of that table. Unmirrored TableNames are counted and reported, not synced.
   Int columns match varchar parameters via SQL Server implicit conversion
   (verified live).
3. **Deletes propagate conservatively.** Legacy keeps no tombstones; a
   touched key that re-pulls empty was deleted (verified live on a deleted
   OrdDetail/OrdDetailPricing pair). Sync enacts a delete ONLY when the touch
   was keyed by the table's own id column and the id is below
   NATIVE_ID_BASE — ERP1-native rows are never deleted, and natural-key /
   composite-key tables (Lot, Test, AddressReference, ChangeSet satellites,
   ...) never delete via sync (a secondary-key re-pull can't distinguish
   deleted from re-keyed). Children delete before parents (reverse registry
   order). Residue surfaces in the reconciliation counts.
4. **The watermark is captured BEFORE the full copy starts** and advanced
   only when a run succeeds — overlap is re-processed (idempotent upserts),
   a gap is impossible; a failed sync leaves the watermark unmoved. A
   partial (?only=) import never moves it. Log history was purged pre-2014
   in this install: the log walk is a top-up, never the baseline — sync
   refuses to run before a full import has recorded a watermark. Stored as
   `app_settings import.logWatermark` (operator-visible; lowering it
   re-walks recent changes harmlessly).
5. **Reconciliation = counts with the native range broken out.** Per table:
   legacy COUNT_BIG vs mirror count, native (id >= 1e9) rows subtracted
   before the delta; natural-key tables whose native rows have no numeric
   range are reported comparable=false (totals only — native lots inflate
   the Lot mirror count by design). Version-sum drift checks were considered
   and dropped (Version is nullable, semantics weak; counts + the log walk
   cover the cutover story).
6. **Review-hardened invariants (multi-agent review 2026-07-03, fixed).**
   (a) LogResult FieldNames are canonicalized to the PHYSICAL column casing
   before any recordset property read — live data logs `SubLot` for column
   `Sublot`, and a verbatim-cased read would have condemned every touched
   sublot as deleted. (b) A sync with ANY rejected change fails and holds the
   watermark (a rejected change would otherwise be lost forever — e.g. a
   unique-code swap needs a second pass; reconcile counts can't see a stale
   UPDATE). (c) Each sync re-walks 1,000 Log ids below the watermark:
   MAX(Log) is the highest COMMITTED id but identity allocation order is not
   commit order, so a straggler transaction could land below the mark;
   re-processing the overlap is harmless. (d) Seven mirrored tables NEVER
   appear in the change feed (verified live: Inventory, Address,
   LotIngredient, SublotParent, Currency, TestGroup, ReleaseCofA — trigger-
   maintained); sync re-copies them wholesale: tiny ones every run, Inventory
   / ReleaseCofA / LotIngredient when a proxy (InvMovement/ChangeSet, Release,
   Lot) was touched. (e) The upsert path enforces the native-row guard both
   ways: source rows whose numeric key lands in the native range are dropped,
   and a Lot whose mirror row belongs to a native production order
   (ordDetailId >= 1e9) is never overwritten — the plant's YYMMDD### lot
   numbering is shared, so same-day collisions are real during parallel
   running (residual risk for native RAW-material lots, which carry no
   marker, is noted in OPEN_QUESTIONS). (f) run() and sync() are mutually
   exclusive in-process (single-node deployment) — a full import racing a
   scheduled sync could resurrect legacy-deleted rows from its stale
   snapshot.
7. **Imports never mirror Inventory rows of a lot-TRACKED item.** Enabling
   lot tracking wipes the item's legacy on-hand and makes ERP1 the on-hand
   of record — a full import or the sync's Inventory re-copy would otherwise
   resurrect the wiped legacy parcels on the next run (found by adversarial
   review of the parcel lock-order alignment). Consequence for the
   reconciliation report: once items are enabled, the Inventory row shows an
   expected legacy-vs-mirror deficit (their legacy rows are deliberately not
   mirrored) — read Inventory drift with that in mind during parallel
   running.
