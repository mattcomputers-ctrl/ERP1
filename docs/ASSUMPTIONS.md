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

## Packouts — specify-what-to-packout + packaging lookup (§5/§6, built 2026-07-03)

Discovery (live DB + UG §6.4/§8.1 + 7.22 release notes):
`ItemPackagedProduct` (7,136 rows) binds bulk item + packaging prototype
(container format: 33 distinct, codes like `50`/`3G`/`41`) → the packaged
product item (`<bulk>-<container>` codes, unique per row) + the RMPP recipe
that packs it. Every live row: `Qty` = 1.0, `Label`/`UPC` null, `Inactive` 0,
and the recipe pointer is the packout's ACTIVE revision (the legacy tool
rewrote bindings on republish). Demand allocation is `OrdDetailCommit`:
all 27,866 live rows are exactly {demand = an MFPP order's bulk UI line,
supply = an MFBA order's PK line, qty = the demand line's full bulk
requirement}. `Ordr.Parent` is never used; MFPK (packout via packaging
recipe without a packaged product) does not occur in this install.

1. **Mirror**: `ItemPackagedProduct` mirrored verbatim + imported (full +
   incremental — it IS a logged table, LogResult keys it by PK). Native rows
   are protected by the standard id-range guard.
2. **Recipe resolution is read-time, not write-time.** ERP1's recipe publish
   does NOT rewrite bindings (legacy's tool did). `packoutOptions` offers the
   bound recipe while it is still active-published; otherwise it resolves the
   active published RMPP revision whose PK line makes the same packaged
   product (single-active makes it unique; ties break to newest). A packout
   with no active recipe is listed but not orderable (with the reason).
3. **Specify packout** (`POST /orders/:id/packouts`, program `orders.create`)
   = create the MFPP order from the resolved recipe at `makeQty` (the shared
   create engine: scaled lines, minted lot, audit) + a native-id
   `OrdDetailCommit` linking its bulk UI line ← this batch's PK line, in ONE
   transaction (batch row lock first, then the id-allocation advisory lock —
   the global order). `suppliedQty` (vendor's editable Supplied Qty) defaults
   to the full bulk requirement and may not exceed it.
4. **Demand is editable until completion** (vendor: "at any time prior to
   marking it complete"): allowed on NST and RLS batches, refused after.
   Works on imported batches too (the commit row is native-id, sync-safe).
5. **Over-allocation warns, never blocks** — the vendor's negative Remaining
   Yield ("you are planning to packout more than you are going to make!").
   Totals use `ActualBatchSize` (planned until completion) as Total Yield.
6. **The packout demand table on the batch** lists OrdDetailCommit rows
   against its PK line (packaging order, status, packout product, allocated
   bulk); the MFPP side shows the inverse supply view. SH-order demand rows
   (vendor Existing Demand includes shipping) don't occur in the live data
   and are deferred with §10 supply/demand.
7. **7.22 product lookup**: the create-order search also surfaces packout
   bindings by bulk/packout item code; picking one orders the resolved
   active packaging recipe (matches the 7.22 fix: only items with an active
   packaging recipe / Packaged Products entry are offered).
8. **Review hardening (multi-agent, 2026-07-03)**: totals + the audited
   over-allocation verdict are computed from IN-TX re-reads under the row
   lock (a concurrent NST order edit rescales ActualBatchSize/PK lines under
   the same lock — pre-tx snapshots would record a wrong verdict in the
   immutable audit chain); an absent order row inside the tx throws (the
   `curStatus(null)`='NST' default would otherwise let a sync-deleted batch
   pass an NST gate — same guard added to `lockAndRequireStatus`);
   specifyPackout enriches ITS binding directly (never through the capped
   option list); a recipe splitting the bulk item across multiple UI lines
   is explicitly non-orderable; a bound recipe that is not an active
   published RMPP recipe (incl. wrong context) falls through to
   active-revision resolution; binding ids are validated to the int4 domain.

## Express execution + multi-batch decision (§5/§6, built 2026-07-03)

1. **Express execution** (`POST /orders/:id/execution/express`) adapts the
   vendor's Batch Execution Express (§6.11) / Package Express Execution
   (§8.5) to ERP1's line model: record every REMAINING unrecorded procedure
   line at standard in one action (materials at planned qty, instructions
   checked off). Matches the plant's real practice — quantities were
   dispensed to plan and written up afterwards. Consumption is FIFO
   oldest-first for EVERY item in ONE locked acquisition (`depleteFifoMany`
   — the lock-order invariant forbids per-line scans in one tx); for
   lot-traced items the FIFO picks ARE the recorded dispensed lots (real
   lineage). The express trade-off (accepted, recorded here): the operator
   forgoes scanning specific lots — if the physical dispense deviated from
   FIFO, use the per-line panel instead. UNTRACED shortfalls warn, never
   block; a LOT-TRACED item short on hand REFUSES express (tx rollback) —
   stamping QtyUsed=standard with lineage edges summing to less would break
   the sum(edges)==QtyUsed recall invariant, and inventing an edge for a
   lot FIFO never dispensed would corrupt recall (found in review; the
   per-line panel is the right path there — the operator asserts the
   physical lots). Lines recorded individually first are left untouched;
   unexecuted lines
   match on ExecStatus NULL **or** ≠ CMP (live NULL shape — a bare Prisma
   NOT filter drops NULLs).
2. **Multi-batch (UG §6.9) is deferred ⏸️**, not built: `Ordr.Parent` is
   NULL on every one of the ~75K live orders — the plant never used it,
   sizing each batch to its demand instead (the OrdDetailCommit data shows
   batches created 1:1 with packout demand). ERP1 covers the underlying
   need (one packaging run fed by several batches) via specify-packouts'
   editable Supplied Qty. The Parent column stays mirrored; revisit only if
   the plant asks for parent/child batches.

## Order-edit revisions (§5/§6, built 2026-07-03)

Vendor UG §7 (Batching Order Edits) / §9 (Packaging Order Edits — "in the same
way as the Batching Order Edit"). The legacy `OrdrEdit` / `OrdDetailEdit` /
`OrdDetailTestEdit` tables are **0 rows** in this install and `Ordr.Revision`
is 0/NULL on all 75K orders — the module was never used at this plant. ERP1
therefore implements the manual's semantics as native design on the mirrored
table names. Decisions:

- **Eligibility = Released (RLS) production orders (MFBA + MFPP).** The vendor
  allows RLS/STD/BAT; ERP1's lifecycle has no STD/BAT (execution happens under
  RLS), so RLS is the whole eligible window. NST orders use edit-before-release
  (rescale); CMP orders must be reversed first.
- **EDT is a real order status** (`Ordr.Status`, UG §6.1 "Order is being
  edited") entered at draft creation and left (back to RLS) at publish/reject.
  Because every execution/lifecycle/packout writer re-asserts RLS under the
  Ordr row lock, EDT blocks them all — and guarantees one open draft per order
  — with no new locking machinery.
- **The draft is the full intended state**: creation snapshots every OrdDetail
  row into `OrdDetailEdit` (ref = source line id) and IPT specs into
  `OrdDetailTestEdit` (ref = source test id); publish makes the order match the
  draft (update changed, delete marked-removed, create ref-less). A copied row
  the user removes is MARKED (`erp1_removed`, restorable), never deleted — the
  draft keeps its full source-id baseline so publish can tell "the user removed
  this line" apart from "this live line appeared after the snapshot" (a
  parallel-running import write), which is REFUSED, never silently deleted.
  Only rows the edit itself added may be hard-deleted (withdrawing the
  addition) while the edit is STD; once CMP or REJ the edit rows are immutable
  history.
- **Revision numbering**: draft gets max(published)+1 at creation; rejected
  numbers are reused (vendor §7.1.7); revision 0 is reserved for the snapshot
  of the pre-edit order taken at first publish (vendor §7.1.8); `Ordr.Revision`
  carries the latest published revision (matches the legacy 0-default).
- **Editability**: UI (qty>0 + comment), INSTR (comment), IPT (comment) lines;
  adds of all three (IPT adds carry tests validated against the `Test`
  catalog, and are MFBA-only — recordIptResults and the execution panel's IPT
  grid refuse packaging orders); removals of unexecuted ones. Locked: executed
  lines (ExecStatus recorded or QtyUsed set — reversal resets to 'NST', so
  both NULL and 'NST' read unexecuted), PK lines (the product; yield is
  completion's business), UB bulk-use lines (`UseFrom` undecoded), IPT steps
  with recorded results. Lines carrying `OrdDetailCommit` allocations cannot
  be REMOVED (orphaned packout linkage) and their quantity cannot drop below
  the summed committed qty (the demand floor) — comment edits and raises stay
  legal (the vendor's demand-editable-until-complete semantics). Item codes on
  existing lines are immutable (vendor rule: delete + add). All guards are
  re-checked at publish in-tx under the row lock (drafts can outlive
  assumptions; parallel-running imports can add allocations or lines).
- **Publish** is e-signed via a new `order.revise` secured item (signature
  required, reason optional by default — the mandatory RevisionComment is the
  narrative; operator-tunable like order.complete). The signature is PINNED to
  the reviewed draft: the DTO carries the `editId` (asserted under the row
  lock, so a concurrent reject+reopen can't swap a different draft under the
  signature; reject carries the same pin) and optionally the draft's
  `erp1_updated_at` token (bumped by every draft mutation), so content edited
  after the signer's review conflicts too. Added lines append to the procedure
  (line/execOrder = live max+1) with fresh native ids and stdQty = the
  published quantity (an addition's standard IS its quantity, like batch
  additions); the published edit's added rows are back-pointed to the lines
  they created.
- **Not rebuilt** (vendor conveniences over the same mechanics, unused here):
  the separate Express Edit program (§7.2 — its semantics: mark failed IPT
  complete, add a Use Group + new IPT, are achievable in the editor),
  Fix-Over-Dispense auto-scaling (§7.1.3 — ERP1 refuses over-recording at
  execution time; quantities can be raised line-by-line), rework-after-packout
  phase choreography (§7.1.6 — needs phase types ERP1's line model doesn't
  carry), yield auto-recalculation on publish (weight-ratio math; the actual
  yield is recorded at completion). Revisit on user ask.
- **Batch-sheet reprint** after publish (vendor suggests it) is just the
  existing `GET /orders/:id/batch-sheet` — it renders live lines, so a
  published revision is reflected automatically.
- **Parallel running caveat**: revising a legacy-IMPORTED order while the
  legacy plant also executes it is inherently conflicted (the import sync
  applies legacy changes to legacy-id rows regardless of ERP1 status) — same
  exposure as executing imported orders natively; publish's live re-validation
  refuses inconsistent drafts (stale line refs, executed-since-drafted lines,
  appeared lines, allocation drift) rather than half-applying them.
- **Review outcomes (2026-07-03 multi-agent review, 13 confirmed findings
  fixed pre-commit)**: the e-sig draft pin + content token, the removed-marker
  baseline (vs silently deleting import-appeared lines), the committed-qty
  floor on quantity edits, MFBA-only IPT additions, stdQty kept equal to the
  corrected quantity on added lines, one shared open-draft resolver (loud on
  multiples), explicit-null quantity rejection (class-validator @IsOptional
  skips null), and web fixes (error+retry state on the panel, editor state
  reseeded at open, confirm on cancel-draft, remove hidden on allocated
  lines).

## Planning / MRP slice 1 — PlanTrace mirror + viewers (§10, built 2026-07-03)

Vendor ch.14. `PlanTrace` has 2,825 live rows (the nightly Recalculate Plan
Trace IS used at this plant); `OrdPlan`/`OrdPlanDetail`/`CapacityPlan` are
0-row (unused). Decisions:

- **The legacy engine stays authoritative during parallel running**: ERP1
  mirrors its output and viewers read the mirror. The native recalculation
  engine (vendor fill order: available stock → quarantined → open MF orders →
  open POs → plan an MF order from the costing recipe, exploding requirements
  → plan a PO) is the next slice; when it ships, native rows use ids ≥ 1e9 and
  the import of PlanTrace should be disabled at cutover.
- **replaceStale import semantics**: the recalc DELETES every PlanTrace row
  and writes fresh ids, and no Log/LogResult rows are ever written for it —
  so PlanTrace is in NEVER_LOGGED_ALWAYS (wholesale re-copy each sync) and
  the new `replaceStale` spec flag prunes mirror rows the snapshot no longer
  contains, LEGACY-RANGE ids only (never native rows).
- **Short Inventory** covers `Short` + `Negative` references (both are the
  to-order signal; Negative is the min-stock refill). Item lead time / min
  stock are NOT on this install's Item table (no such columns), so the viewer
  shows on-hand + dates + preferred supplier (`Item.Supplier`) without them.
- **Expedite flag** computed per the vendor rule: AvailableDate later than
  both today and DateRequired.
- **Review outcomes (2026-07-03, 11 confirmed findings fixed pre-commit)**:
  prune rewritten as app-side set-difference with 5,000-chunk `in` deletes
  (an unbounded `notIn` hits Postgres's 32,767 bind-variable ceiling and
  would wedge every sync once the source grows); an empty snapshot against a
  non-empty mirror SKIPS the prune with a warning (indistinguishable from
  catching the nightly rewrite mid-flight — never silently wipe the plan);
  sync report keeps the re-copy prune count; q trims + intersects with an
  exact itemId (never overwrites) and is uncapped; expedite compares against
  UTC-digit midnight (the plant wall-clock frame); tests use clock-relative
  dates (no time bombs), cover the sync-path prune, the empty-snapshot
  guard, expedite boundaries, and multi-manufacturer short grouping.

## Planning / MRP slice 2 — native Recalculate Plan Trace (§10, built 2026-07-03)

Discovery against the live legacy plan (2,825 rows, snapshot of 2026-07-02)
pinned down the vendor §14.1 algorithm as actually configured at this plant.
Decisions and observed evidence:

- **Planning knobs live on `ItemEntity`, not Item**: ST-context rows (Entity 4
  = the site, the ONLY ST entity) carry MinimumStock (430 set) / LeadTime (81)
  / TestingLeadTime (0); MF-context rows are item×manufacturer approvals.
  ItemEntity IS change-logged (9,205 LogResult rows) → regular import spec.
  The native engine takes the site owner = the single distinct ST entity; if
  several appear, stock-owner classification degrades to "all own" (no
  consignment references) rather than guessing.
- **`ByRequestOnly` is 0 on all 28,801 rows** → the §14.1 by-request-only
  allocation restriction is NOT implemented. Demand-side required-manufacturer
  (OrdDetail.Manufacturer) IS enforced: stock must come from a lot of that
  manufacturer, PO supply from a line pinned to it; MF supply is unrestricted.
- **Open orders** = DateCompleted NULL and status not CMP/CLS (POs have NULL
  status — null-safe OR, not `notIn`). The 45 completed orders present in the
  legacy snapshot were all completed AFTER the overnight run — confirmed not
  a "completed orders still plan" rule. Quotes excluded.
- **Demand** = SH lines (SH orders) + UI ingredient lines (MF orders),
  remaining = QtyReqd − QtyUsed (QtyCommitted does NOT reduce demand — the
  committed stock is still on hand, verified: committed UI lines plan their
  full QtyReqd against AVAIL). Required date = first-of(DateScheduled,
  PlanStartDate, DateRequired), else today.
- **Supply** = MF orders' PK product lines (remaining = QtyReqd − QtyUsed;
  arrival = first-of(DateRequired, DateScheduled, PlanStartDate) — verified
  exact on every live MF# row, NO lead time added) and open PO lines
  (arrival = first-of(line DatePromised, header DateRequired, header
  DateOrdered + item lead) — verified arrival == DatePromised exactly; the
  UG's "lead time plus first date" only applies from DateOrdered down).
  `+` suffix on MF#/PO# = arrival before today (order overdue). PromisedDate
  on PO# rows = earliest line promise of the source order.
- **Stock classification** via latest Release per sublot: Approved+not
  suspended → available; no Release row → available (auto-approve items
  never get one); Hold/suspended → `Hold` (assumed approved, PlanTraceStatus
  `Retest` — ERP1 has no in-progress-testing signal until §15 LIMS, so the
  vendor's `Testing` status is not emitted); Rejected → only consumable by a
  demand pinned to that exact sublot (`Rejected` reference). Expiry =
  Release.ExpiryDate before today or before the demand's required date →
  `Expired`. Stock at a location owned by a non-site entity is consumed
  under that entity's code as the Reference (verified: "PRESS TECH CONSIGN"
  rows = min-stock filled from the consignment location owned by entity
  100877), after own-site available stock.
- **Orders beat min-stock to the stock** (verified on item 108364: orders
  took 130 from stock, min-stock got the 220.1 leftovers and shorted 29.9,
  even though the min-stock rows print first). The native engine runs all
  order demands (waves of explosion) first, then min-stock demands
  (User=MinStock, required=today UTC-midnight) as a second phase.
- **Explosion**: a Short on an item with an ACTIVE costing recipe plans an
  MF order and queues child demands (per-1-lb recipe UI lines × short qty)
  one wave deeper: User=RawMaterial, MfgItem=parent item, root order/line/
  context carried through (verified: RawMaterial rows carry the ROOT SH
  order across 4 levels of explosion). Child required = parent required −
  recipe lead (verified: 2016-07-04 = today − 3650 on lead-less recipes).
  `Item.CostingRecipe` points at a recipe row; the engine re-resolves to the
  ACTIVE published family member (BASE.NN, highest id) since native publishes
  create sibling rows the legacy pointer doesn't know about. Depth capped at
  25 waves (recipe-cycle guard; Short row kept, no further explosion).
- **MFLevel = the item's deepest wave** across the whole plan, constant per
  item (verified: direct MFBA demands on a level-4 ingredient carry level 4,
  not 0) — not the per-row explosion depth.
- **Dates on Short rows**: available = today + lead + testing lead; order-by
  = required − lead − testing lead; lead = recipe lead ?? ItemEntity ST lead
  ?? 3650 (vendor fallback). TestingLeadTime defaults to 0 when unset — the
  legacy engine showed BOTH `today` and `today+3650` availability on
  identical-looking rows (items with tests), so the vendor's fallback is not
  reproducible from one snapshot; 0 is predictable and per-item configurable.
  PriceDetail.LeadTime is 0/15,750 in this install → supplier-price lead
  source skipped.
- **Row id order** is the engine's processing order (item-code order within
  a wave, released-then-date within an item). The legacy writer's global
  ordering (item blocks in neither id nor level order) is a presentation
  artifact of a two-pass engine and is NOT reproduced; per-item row sequence
  (fills in consumption order) matches.
- **Native/legacy coexistence**: the recalc DELETEs native-range rows
  (id ≥ 1e9) and rewrites them in one tx under the native-id advisory lock;
  legacy rows are untouched (the import keeps refreshing them while parallel
  running). The viewers show ONE source: app setting `planning.source`
  (default legacy, flipped to native by a recalc), `?source=` overrides per
  request for side-by-side comparison. At cutover: disable the PlanTrace
  import spec and the setting stays native.
- **Review outcomes (2026-07-04, 2 confirmed findings fixed pre-commit, 4
  refuted)**: (1) MAJOR — stock netting had no Location.Context filter, so
  25K retained-QC-sample parcels (SMP locations, ~280 lb across 4,770 items
  live) would leak in as thousands of sub-lb AVAIL rows and understate
  shorts; the engine now nets only WHS/null-context locations (live stock
  exists only at WHS + SMP; consignment sites are WHS-context; ERP1-native
  flows never create Location rows). (2) `planning.lastRecalcAt` was written
  but never read while the viewer's stamp derived from MAX(dateUpdated) —
  which keeps the ORDER LINE's date on order rows (vendor parity) and can
  predate the recalc; trace() now surfaces the recalc stamp for the native
  source. Refuted as non-defects: advisory-lock breadth during the write tx
  (sub-second at plan scale, same lock all native creates take), no
  single-flight guard (second recalc wastes compute but serializes safely,
  last-writer-wins a complete consistent plan), button visible without the
  program (server-guarded, UX-only), method-level program override
  (getAllAndOverride handler-first is the established short() pattern).

## Create PO from plan (§10 / UG §14.2.1, built 2026-07-04)

- Vendor rules enforced verbatim: selected lines must all be Short/Negative,
  the SAME Item + Required-Manufacturer combination, none may pin a sublot
  (a PO can't produce a specific sublot), and supplier pricing must exist
  for the combination. One PO, one line: quantity = sum of the selected
  lines, DateRequired = the earliest of theirs, Reference "Plan Trace".
- "Pricing for that combination": a supplier's CURRENT effective price
  version must hold a PriceDetail for the item that is either generic
  (Manufacturer NULL) or for the required manufacturer — generic pricing
  covers pinned demands; details on superseded versions don't qualify.
- The vendor's "which pricing to use" prompt is a round-trip: with no
  supplierId and >1 qualifying supplier the endpoint returns
  needsSupplierChoice + ranked options (preferred supplier — Item.Supplier —
  first) and creates NOTHING; the client re-posts with the choice.
- The PO is created by the EXISTING purchasing.create engine (native ids,
  tier price from the effective version, OrdDetailPricing packaging
  snapshot, audit `purchaseorder.create`); the endpoint itself is guarded by
  its own program `planning.createPo` (the vendor puts the button on the
  Plan Tracing viewer) — a planner does not need `purchasing.create`.
- PO lines now carry the required manufacturer (CreatePurchaseOrderLineDto.
  manufacturerId → OrdDetail.Manufacturer, create + add-line paths) so the
  next recalc matches the new supply to the manufacturer-pinned demand.
- Selection works on whichever plan the viewer shows (legacy or native rows
  — both are real requirements during parallel running).
- **Review outcomes (2026-07-04, 5 confirmed findings fixed pre-commit, 4
  refuted)**: (1) CRITICAL — the priced detail could differ from the detail
  that qualified the supplier: `effectivePriceDetail`/`lineSourcing` were
  manufacturer-blind (lowest-id row), so a pinned line could be priced and
  packaged at ANOTHER manufacturer's rate; sourcing now threads the
  required manufacturer (pinned → manufacturer-specific detail else generic;
  unpinned → generic else lowest-id) through options display,
  purchasing.create and add-line — the qualifying detail IS the priced
  detail. (2) supplier candidates now require `Entity.IsSupplier` (sales
  price lists share PriceVersion/PriceDetail and could surface as fake
  suppliers, failing late in purchasing.create). (3) the web supplier
  chooser resets when the selection changes (its tier prices were computed
  for the old summed qty). (4) the selection clears on page/search/filter/
  sort changes (hidden rows must not silently ride into a PO; ids are also
  stale across a recalc). (5) line manufacturerId is now validated
  (exists + IsManufacturer) on both purchasing create paths — unvalidated it
  would mint a dangling FK that never matches pinned demand. Refuted:
  audit-under-purchasing.create program (documented decision), the
  needsSupplierChoice TOCTOU (bounded, non-corrupting — the second POST
  re-validates everything), CSV blank checkbox column (cosmetic, matches
  pre-change exports), test-gap meta-finding (coverage added with the fixes
  anyway).

## Accounting — GL/tax masters, tax engine, invoice generation (§13 slice 1, built 2026-07-04)

Evidence base: UG ch.17–18 + live-DB sweep (GLGroup 8 / GLCode 11 /
AccountCode 27 / GLGroupCode 70 / TaxRule 3 / QuickBooksTransactions 7;
Trans CI 22,083 still minted daily through 2026-07-02).

1. **QuickBooks live bridge replaced by a file export.** The vendor's QB
   interface is a resident agent speaking the QB Desktop COM API both ways
   (export txns; import Actual Cost back; overnight auto-reconciliation).
   This install used it for SEVEN transactions (Dec 2018–Jan 2019, RefNumbers
   matching Trans CI invoice numbers) and abandoned it; invoicing continued
   standalone. ERP1 therefore ships an **IIF + CSV export pack** driven by
   the same GL model instead of a live bridge; QB-side validation/retry,
   cost import-back, and overnight reconciliation are ⏸️ (impossible without
   a live QB session, and demonstrably unused).
2. **Tax rule resolution** (UG §17.4.7, engine in `tax-math.ts`): per level
   1–3 and per line — exact (EntityTaxGroup, ItemTaxGroup) match, else the
   blank-ItemTaxGroup rule for that customer group, else no tax. Blank and
   NULL group values are equivalent (case-insensitive compare); a customer
   with no group at a level gets no tax at that level unless a rule with a
   blank EntityTaxGroup exists. Rate is % of the line value; Amount is a
   fixed charge × unit qty; **TaxOnTax bases the rate on the value inclusive
   of taxes computed at lower-numbered levels** ("higher levels" in the UG =
   more senior = level 1; the classic PST-on-GST case). Freight is taxed via
   an ItemTaxGroup literally named 'Freight' (fallback: the blank rule),
   rate-only (no unit qty). Each level's TOTAL is rounded to cents once (not
   per line). `TaxRule.TaxNumber` is the level selector; `Context` (which
   held '1' on all 3 live rows) is written = String(taxNumber) on native
   rules — undecidable from data which one legacy resolution used, both are
   kept consistent.
3. **Masters are legacy-owned during parallel running.** The five GL/tax
   tables ARE in the legacy change feed (LogResult names them), so they got
   standard log-driven import specs; ERP1 edits to an imported KEY can be
   overwritten by a later legacy-side change (legacy is master until
   cutover), while ERP1-created rows (new varchar keys; native ids ≥1e9 for
   GLGroupCode/TaxRule) are never touched by the import. GLGroupCode gained
   a `@@unique(glGroup, glCode)` — the live 70 rows have no duplicates and
   the legacy editor grid implies the pair is the identity.
4. **Invoice generation bills QtyUsed − already-invoiced.** Legacy invoices
   per shipment event (2,861 orders carry >1 CI invoice; Trans header fields
   equal the Ordr's BillTo/Owner/Salesman/Currency/PoNumber on live rows;
   TransDetail rows carry the ORDER's context 'SH', the shipped qty and the
   line price). ERP1's generate: per SH line, invoiceable = QtyUsed (shipped
   so far) − Σ qty on prior non-reversed CI invoices for that line (a
   reversal PAIR — the reversing invoice and its target — is excluded from
   the sum, restoring the qty as re-billable). Refused when nothing is
   uninvoiced, when the order isn't SH, has no bill-to, or is NST. Zero tax
   amounts are stored as NULL (matching live rows); freight and taxes land
   on the header exactly like `trans-math` reads them back.
5. **`shipLots` now stamps `OrdDetail.QtyUsed`** (atomic COALESCE bump per
   line referenced by a shipped lot) — the legacy shipped-so-far convention.
   Before this, native shipments left QtyUsed NULL, so invoice generation
   and the invoice document's backordered math only worked for imported
   orders. Lots recorded without an `ordDetailId` still ship (traceability
   is lot-level) but don't move QtyUsed — the pick list UI always links
   lines.
6. **Invoice numbering continues the plant's sequence**: `N` + 8-digit
   zero-padded integer (all 22K live documents match `^N[0-9]{8}$`). The max
   is computed with that regex under the shared advisory lock, so malformed
   documents can't poison the sequence; TI documents share it (legacy TI
   rows use the same format). Collision risk during parallel running (both
   systems minting the next N) is recorded in OPEN_QUESTIONS — same shape as
   the lot-number question.
7. **Review round 1 (2026-07-04, 5 lenses → adversarial verify, 51 agents):**
   9 unique findings confirmed and fixed — (1) the new shipLots QtyUsed stamp
   mutated order state WITHOUT the Ordr row lock (hard-convention violation;
   racing the NST line editor could silently strand a shipment unbilled) —
   now locks Ordr first and validates referenced lines IN-tx; (2) shipLots
   accepted an ordDetailId whose item differs from the shipped lot (QtyUsed
   would land on the wrong line and be billed at ITS price) — now rejected;
   (3) invoice-generation tax reads ran on separate pool connections while
   the row+advisory locks were held — TaxService now takes the tx client;
   (4) invoice audit change rows recorded the ORDER line id under
   tableName=TransDetail — now the created detail ids; (5) GL-masters PATCH
   treated an omitted description as "clear to NULL" — now keep-on-omit /
   clear-on-null; (6) explicit `taxOnTax: null` could NULL a boolean mirror
   column — treated as omitted; (7) the web tax preview called non-existent
   /shipping/* routes (actual: /shipping-orders/*) with the failure
   swallowed; (8) MappingGrid state leaked across GL-group switches (keyed
   now) and its account select visibly reverted while a PATCH was in flight
   (optimistic value now); (9) the tax-rule editor couldn't clear a
   description (blank mapped to undefined = keep). Notable refutations: TI
   invoices are NOT invoice-shaped duplicates to exclude; CurrencyRate has
   zero readers; the import sync cannot clobber native QtyUsed (imported
   orders are legacy-mastered, native orders aren't in legacy).

## Accounting export — IIF/CSV journal (§13 slice 2, built 2026-07-04)

1. **Scope = the transaction kinds the legacy QB agent exported** (UG
   §18.1.2) minus master-list sync (customers/suppliers/items are maintained
   in the accounting system directly): sales invoices, purchase receipts (as
   BILLs), misc receipts, inventory adjustments, builds. Master-list IIF
   (CUST/VEND/INVITEM) can be added later if the user wants it.
2. **Double-entry construction**: invoice → AR debit vs per-GL-group Income
   credits + per-level tax credits + freight credit; PO receipt → Asset
   debit vs AP credit at the PO line price; MISC receipt → Asset vs the
   group's MiscReceipt account at the received lot's unit cost; native COUNT
   adjustment → Asset vs the group's COUNT account, delta recovered from the
   atomic audit entry (the ChangeSet and the parcel's qty before/after are
   recorded in the SAME audit row set), valued at the parcel lot's unit
   cost; native build → product Asset debit vs consumed ingredients' Asset
   credits (source='consumption' genealogy edges × each consumed lot's own
   unitCost — the exact figures the valuation engine rolled up). Header-side
   accounts (AR/AP/tax1-3/freight/fallback) are app settings
   (`accounting.*Account`) with QuickBooks-style defaults.
3. **Legacy-imported adjustments and builds are NOT exported** (only native
   id ≥ 1e9): their value lives in legacy InvMovement/OrdrItemCost costing
   ERP1 doesn't re-derive; the plant's accounting for the legacy era already
   happened. Invoices and PO receipts ARE exported for any date range (their
   value = stored document/line figures, valid for both worlds).
4. **Every line is rounded to cents and the header line is forced to balance
   the rounded rest** — float artifacts (400 × 2.03 = 811.9999…) must never
   reach an accounting import; the export refuses to render an unbalanced
   entry (belt-and-braces check).
5. **Unresolvable accounts never drop value**: they book to the
   `accounting.fallbackAccount` ('Uncategorized') and emit a warning listed
   in the preview, the export response, and the run ledger's warning count.
6. Every download is recorded (`accounting_export_run` + audit): range,
   kinds, format, entry/warning counts, actor — the operational answer to
   "what did accounting already get" (the vendor's overnight sync is ⏸️, see
   slice 1 §1).
7. **Day-boundary caveat during parallel running**: the export range filters
   raw stored timestamps; legacy rows are plant wall-clock stored as UTC
   digits while ERP1-native rows are true UTC (see
   [[datetime-timezone-handling]]) — transactions near midnight can fall on
   either side of a day boundary depending on origin until the cutover
   normalization. Whole-month ranges make this immaterial.
8. **Review round 2 (2026-07-04, 3 lenses → adversarial verify, 23 agents):**
   8 unique findings confirmed and fixed — (1) CRITICAL: by-package PO
   receipts were billed at the PACKAGE price per stock unit (live data: up
   to 864× overstated AP) — the journal now divides by
   `OrdDetailPricing.entityQuantity` exactly like receiving costs the lot;
   (2) reversed PO/MISC receipts exported as live bills — in-range reversal
   pairs are now excluded (warned), and an in-range reversal of a
   prior-period receipt emits a negated counter-entry dated at the reversal;
   (3) builds booked null-unitCost consumed lots at 0 where the produced
   lot's roll-up used the purchase-price fallback — same fallback applied;
   (4) the header-rebalance could shift an invoice's AR a cent off the
   stored document total — rounding dust now lands in the largest detail
   line, never the header; (5) CSV formula-injection guard (leading
   =/+/-/@ in text cells); (6) PATCH-with-omitted-description wrote a false
   "cleared" audit newValue; (7) the round-1 optimistic select still
   reverted during the refetch (mutation now stays pending through
   invalidation); (8) the day-boundary caveat above recorded.

## Inventory Supply & Demand viewer (§10 / UG §13.3, built 2026-07-04)

1. **Read-only by design.** The vendor's Allocate Demand form also EDITS
   allocations (Supplied Qty / Allocated Qty = OrdDetailCommit rows). In this
   install the only allocations ever recorded are packaging-order bulk
   commitments (MFPP-UI ← MFBA-PK; see [[packouts-model]]), which ERP1
   already creates/edits through the Packouts panel with the proper
   locking/audit. Stock-to-order commitments were never used (no such
   OrdDetailCommit shape exists in 27.8K live rows), so an allocation editor
   here would write rows nothing else reads. The viewer states this and
   links the workflow.
2. Semantics copied from the native plan engine (same openness rule,
   WHS/null-context nettable stock, latest-release Available/Held
   classification, remaining = QtyReqd − QtyUsed) so the two screens can
   never disagree about what counts as supply.
3. **Review round 3 (2026-07-04, 2 lenses → adversarial verify):** 4 confirmed
   findings fixed — open-demand total now sums remaining (required−used), not
   balance+committed (commits are never decremented, so after partial
   execution the old formula overstated demand); allocation edges and
   committed/allocated sums now count only OPEN-to-OPEN line pairs (a commit
   whose counterpart order closed is settled history — it used to dim every
   row in the linked-table UI and inflate sums); the warehouse-inventory
   source row is inert (its null id was the no-selection sentinel — clicking
   it silently wiped the selection); item-picker errors are surfaced (a user
   without `planning.supplyDemand` saw a silent dead end). Refuted: the
   unbounded per-item query (measured: worst real item ≪ bind-variable
   ceiling), produce-line discarded-filter (zero such rows live).

## Email notifications (§17 / UG ch.22, built 2026-07-05)

1. **Delivery owned by ERP1, not the database.** Legacy queued rendered
   e-mails in `EmailSent` and relied on a SQL Agent job (`exec EmailProcessor`
   every minute) feeding SQL Server Database Mail (profile in
   `ParamsMail.ProfileName`). In this install that leg NEVER worked: all 516
   queued e-mails (one kind — 'MFO Created Notification', Apr–Jul 2022, one
   recipient) sit at 'Not sent' with no error, and the plant abandoned the
   feature. ERP1 keeps the queue-table design (emitters render + queue inside
   the business transaction; audit trail for free) but dispatches itself:
   an in-API 60-second poller (NODE_ENV=test disables) sending over
   nodemailer behind a `MailTransport` seam. Dispatch protocol (rebuilt in
   review round 1 — an SMTP send is a non-transactional side effect and must
   never sit inside a tx whose rollback would erase the record of it):
   per-e-mail CAS claim to a transient 'Sending' status (FOR UPDATE SKIP
   LOCKED; the attempt is counted DURABLY at claim time), the send happens
   OUTSIDE any database transaction (bounded by 10s/10s/30s transport
   timeouts; requireTLS whenever credentials ride a non-implicit-TLS port),
   then the outcome is written. Stale 'Sending' claims (>10 min = a crash
   mid-send) are swept back to the queue on the next run, converging on
   'Failed' via the already-counted attempts (at-least-once delivery). A row
   that fails is not re-claimed within the same run — retries ride
   subsequent polls. `ParamsMail` is NOT mirrored — the Database-Mail profile is
   meaningless here; its `ContextURL` deep-link base is replaced by the
   `notifications.baseUrl` setting (links into ERP1 web routes,
   `?focus=<id>` form). The BullMQ worker was deliberately NOT used for
   dispatch: single-node deployment, and a DB-queue poller has the same
   semantics with no cross-process bootstrap.
2. **Imported legacy EmailSent rows are history, never dispatched** — the
   processor only touches ids ≥ 1e9. Without that guard a fresh install
   with working SMTP would mass-mail 516 four-year-old order notices.
3. **Master switch semantics**: emitters ALWAYS queue (the log doubles as a
   dry-run trail); `notifications.enabled` gates only delivery. Seeded false.
4. **Rule codes are the install's literal strings** (e.g. 'MFO Created
   Notification', not the UG prose 'Manufacturing Order Created
   Notification') — the engine matches rules by exact code and imports keep
   legacy rows working unmodified. The catalog (38 codes) marks which codes
   ERP1 fires natively; unwired codes remain configurable for parity and are
   annotated with the evidence for deferral.
5. **Revision publish fires BOTH 'Order Edit Publish Notification' (the UG
   code) and 'MFO Created Notification'** — the legacy subject reads
   "created / edited" and the Batching Order (edit) program was what
   generated all 516 live e-mails, so a plant that re-enables its old rule
   keeps getting the edits it used to.
6. **Reweigh Outside Threshold maps to inventory adjustment**: ERP1 has no
   container reweigh transaction; the legacy global
   `ParamsInventory.ReweighThreshold` (live value 5.0%) becomes the
   `inventory.reweighThreshold` setting checked in `inventory.adjust`
   (percent of the pre-adjust quantity; 0 disables; not computable against a
   zero base).
7. **Planning notifications fire at the end of a native recalc** (legacy ran
   them as overnight procedures over the nightly plan — same moment in
   ERP1's lifecycle): Short (aggregated per item), Expedite (late `+`
   supply rows), Testing Required (PlanTraceStatus 'Retest'), each a single
   `@Table` summary; Area = the site owner entity.
8. **Recipient resolution**: rule Send To + the FIRST owner up the entity
   parent chain with NotificationDetail rows (UG: Area → Site → Installation
   → CMS) + event-contextual addresses (order placer / receiver / item
   creator = the acting user's e-mail) unless Use Sendto List Only; parsed
   on `;`/`,`, must contain '@', case-insensitive dedupe; empty → not queued
   (UG: "If a Send To cannot be determined then the notification is not
   sent"). SecurityGroup resolution = exact match then '*', like the tax
   engine's exact→blank rule.
9. **smtp.password lives in app_settings** (admin.config-gated) for
   operability; deployments that refuse a DB-stored password set the
   `SMTP_URL` env var, which overrides all smtp.* settings.
10. **ERP1 owns notification-rule config after the first full import.**
   `Notification`/`NotificationDetail` are copied by the FULL import but are
   NOT in the sync re-copy set: they are never change-logged, so the only
   sync mechanism would be wholesale re-copy — which would silently revert
   every rule edit made in ERP1 on every sync (review finding). This
   install's legacy rows are frozen 2022 config, so nothing is lost;
   `EmailSent` (append-only history) does keep re-copying.
11. **Review round 1 (2026-07-05, 5 lenses → 2 adversarial verifiers each,
   both-must-confirm kill):** 15 confirmed findings (9 unique defects), all
   fixed — the batch-transaction dispatcher (a rollback un-marked
   already-delivered mail → duplicate-delivery loop; rebuilt per #1); an
   ABBA advisory-lock inversion in four emitter placements (emit takes the
   native-id lock, audit the audit-chain lock, every allocating path orders
   native-id FIRST — those sites now emit before audit and the engine
   docblock states the order); missing SMTP timeouts (a blackholed relay
   would pin the dispatcher ~10 min); sync reverting rule edits (#10);
   'Tests Completed' re-firing on every post-completion correction (now
   transition-only); planning Expedite/Retest tables showing an arbitrary
   demand slice's qty/date (now aggregated per supply/sublot);
   PATCH-with-explicit-null 500s + a null ownerId guard; the mail-settings
   card silently rendering empty without admin.config; a stale e-mail
   preview after requeue. From the disputed pile, accepted as-is: pre-tx
   item reads in adjust (static reference data, existing decoration
   pattern); hardened anyway: requireTLS with credentials. Fixing the
   dispatcher surfaced one more real bug the re-run caught: the claim loop
   re-claimed a just-failed row and burned all 5 attempts in one tick (now
   excluded per run — retries wait for the next poll).

## Configuration tabs (§14 / UG ch.19, built 2026-07-05)

1. **Params* are not mirrored as tables — configuration is app_settings.**
   Legacy stores plant config in ten `Params*` tables (per-Owner rows with
   NULL-inherits-parent semantics; live: Owner 1 sets nearly everything, the
   two site rows override only a skin color and default locations). ERP1
   keeps its established key/value `app_settings` + a typed REGISTRY
   (settings-registry.ts) grouped to mirror the legacy tab layout. Only LIVE
   keys are registered — every entry is read by some code path, so the
   Configuration page never shows dead knobs. Live legacy values were
   surveyed (2026-07-05) and became the seeded defaults where a counterpart
   exists.
2. **Load-bearing legacy values stay hardcoded, deliberately**: lot-code
   format yyMMdd + 3 digits (ParamsInventory.LotCodePrefix/Length), recipe
   version separator '.' + length 2 + SingleActiveRecipe
   (ParamsRecipeManager), container prefixes. These are verified plant
   conventions the parallel-running import depends on; a runtime knob would
   invite corruption. If a second install ever needs different values,
   promote them then.
3. **New live wires** (each returns real behavior, tested):
   security.passwordMinLength / lockoutCount / lockoutDurationMinutes drive
   AuthService (lockoutCount 0 = disabled, matching legacy unset; floors keep
   bad values from disabling controls); receiving.manfLotRequired gates the
   manufacturer-lot requirement in purchase receiving (legacy ran False —
   ERP1 defaults TRUE because the manufacturer lot is the recall key; lots
   received without one are recall-findable by supplier only);
   batchExecution.yieldTolerancePercent returns a completion warning when
   actual yield deviates from planned beyond the tolerance (legacy live 5%) —
   advisory, never blocking, like the legacy execution flag.
4. **AuthService reads security.* via Prisma directly**, not SettingsService —
   SettingsModule's controller imports auth guards, so the reverse dependency
   would be a module cycle.
5. ParamsHost (QuickBooks COM bridge config) and ParamsPrint (label XML) map
   to nothing in ERP1 (§13 replaced the bridge; labels not built) — not
   mirrored, values recorded in the discovery notes. ParamsCMS oddities
   (skin styles, ClickOnce paths, Softek license) are desktop-client
   artifacts.
6. **Review round (2026-07-05, 4 lenses → 2 adversarial verifiers each,
   both-must-confirm):** 13 confirmed findings (6 unique defects), all
   fixed — the big one: number-typed setting writes accepted ''/whitespace/
   negatives (Number('') === 0), so CLEARING the lockout field in the new
   Configuration page would have silently disabled the brute-force lockout;
   fixed at BOTH layers (PUT rejects blank/negative for number keys;
   AuthService.securityPolicy treats blank/negative as unset → default,
   never as the explicit-0 disable sentinel). Also: ChangePasswordDto/
   CreateUserDto @MinLength(12) pre-empted a configured minimum below 12
   (DTOs now carry only the floor 6; AuthService.assertPasswordPolicy is
   the single enforcement point, applied to admin-created initial passwords
   too); the web receiving form hard-required a manufacturer lot regardless
   of policy (the PO detail response now carries manfLotRequired — the
   receiving user can't read admin settings); genealogy classified
   null-supLot received lots as 'other' instead of 'raw' (supplierId is now
   an equal raw marker); the Configuration save loop reported total failure
   on partial success (per-key saves — successes leave the edit buffer,
   failures stay with their message).

## Viewer library — declarative set-viewer platform (§18 / UG ch.23, built 2026-07-08)

1. **No config tables exist in legacy** — set viewers are client-defined grids
   over vendor SQL views. ERP1's parity shape is a DECLARATIVE registry
   (`apps/api/src/viewers/viewer-registry.ts`): per-viewer columns/params/query
   fragments served by one generic endpoint + one generic web grid with
   full-set CSV export. SQL fragments are code constants (Prisma.raw); only
   values are bound; sort keys resolve through the column whitelist.
2. **Scope = usage-ranked working set** from the legacy `Log` (update-side
   counts, reads don't log — relative signal only): Shipment Detail 396,
   Open Shipping Order Detail 290, Inventory Movement 153, Open MF Order
   Detail 153, Purchase History 61, Batching Order 44, Where Used 21,
   Inventory 21(+Global 17, at-date), Inventory Cost 15, Complete MF Orders
   14. Everything at ≤20 uses that maps onto an existing ERP1 browser is
   mapped, the ~35 never-used viewers are ⏸️ with this evidence (query:
   `SELECT Program, COUNT(*) FROM Log WHERE Program LIKE '%Viewer%' GROUP BY
   Program`).
3. **InvMovement/InvMovementDtl mirrored lean** (609K + 972K rows). Columns
   dropped with live 0-use evidence: header Scale/GLCode/Comment/QtyEntered/
   TareEntered/GrossQtyEntered, detail Division/StandardValue(0 everywhere)/
   WeighAndAdd; detail ReplacementValue and InventoryCost (532K refs) dropped
   because nothing mirrored consumes them — the InventoryCost table stays
   unmirrored (its only consumers are the dead cost viewer and a Receipts
   view column; Receipts Set Viewer has zero usage).
4. **Sync strategy: append-only top-up.** LogResult NEVER names
   InvMovement/InvMovementDtl (verified live; only ChangeSet + InventoryCost
   from that family are logged). Movement history is insert-only, so sync
   pulls rows past the mirror's max legacy-range id with a 1,000-id re-walk
   lag (allocation order ≠ commit order), same idempotent-upsert guarantees.
   A Comment edit on an old header would be missed — accepted (column not
   mirrored; movements are immutable history in practice).
5. **Encrypted vendor functions reconstructed and validated live**:
   - `GetInventoryAtDate(date)` = Σ Qty/Value of NON-WIP legs (dtl context
     MK/MKCA/US/USCA/ADJ/SCRAP; B-suffixed legs are commingle WIP) over
     movements with ChangeDate < date+1d — reproduces Qty AND ActualValue
     exactly (validated on CTA1184: 6240.1376003872 / 8562.86).
     StandardValue is 0 on every row in this install; ReplacementValue needs
     the vendor's current-cost lookup (qty × replacement cost ≠ any movement
     sum) — both columns dropped.
   - `GetQtyMade` costing = Σ Value of MK/MKCA/MKB/MKBCA legs of the order's
     ChangeSets — validated 12/12 EXACT against CompleteManufacturingOrders.
     ActualCost (bulk orders post their cost as a CA/MKBCA leg; packouts as
     PCKAGE MK/MKCA legs).
   - `GetUncommittedQty` = (QtyReqd − QtyUsed) − committed, floored at 0,
     where committed = QtyCommitted + positive OrdDetailCommit edges (the
     formula the open-detail views inline for [Committed]).
   - `GetInventoryCosts` returns ZERO rows for every item in this install
     (tried null and real item ids incl. items with stock) — the Inventory
     Cost Set Viewer renders empty in legacy; ⏸️ with at-date value coverage.
6. **Column trims verified against live data** (all zero rows): ItemCustom
   .Type, OrdrCustom.BatchNbr, YieldOutsideToleranceMemo, Ordr.OpsPlanner/
   Requester/ManfLot/SalesPerson/ExecutionHold/PrepaidAmount/FirstPeriodDate,
   OrdDetail.WeighRule/MustPreweigh/Manufacturer/pinned Sublot/DateFollowUp/
   PromisedBy, Item.BillTo, Location.TransferCan, InvMovementDtl.Division.
   Single-currency install → AltCurrencyToBaseCurrency factor = 1, dropped.
   DatePromised (7,329) and UserHold (1,873) are live — kept.
7. **Deviations from the vendor views** (deliberate): OpenShippingOrderDetail
   pkg count divides by the line's own OrdDetailPricing.QtyPerEntityQty
   (legacy used ItemUnit.BaseQty — ItemUnit unmirrored, per-line packaging is
   the better truth); ChangeSetShipment joins LEFT (legacy INNER would hide a
   SH movement whose changeset lacks the shipment row); LogDate column
   dropped (legacy Log table not mirrored — ChangeDate is the business date);
   where-used hides rd.Inactive lines (ERP1 revisions mark-don't-delete, so
   removed baseline lines exist that legacy never had).
8. **Server applies param defaults** ('today' resolves at request time, UTC
   digits = plant wall-clock) so a bare API call behaves like the grid's
   initial view; required-with-default params therefore never 400 in
   practice.
9. **Entity display names** resolve through the Main-address lateral
   (AddressReference → Address.Name) — legacy keeps no name on Entity. These
   laterals live in `selectOnlyFrom` so COUNT queries skip them.
10. The shared CSV builder (`apps/api/src/common/csv.ts`) carries the
    formula-injection guard; `journal-format.ts` now imports it (behavior
    unchanged).
11. **Review round (2026-07-08, 6 lenses → dedup → 2 adversarial verifiers
    each, both-must-confirm): 12 of 13 findings confirmed, all fixed.** The
    two majors: (a) the append-only sync anchored on the MIRROR's max id, so
    a batch where higher ids upserted but lower ids rejected would advance
    past the rejected rows and lose them once beyond the re-walk lag — the
    anchor is now a PERSISTED per-table watermark
    (`import.appendWatermark.<Table>`) advanced only on zero-reject batches
    (and seeded by a clean full import); (b) the original trim list wrongly
    dropped `Ordr.Salesman` (the int FK, set on 98% of shipping orders —
    distinct from the always-empty `SalesPerson` varchar this section's item
    6 refers to) — salesman code/name columns restored on Shipment Detail +
    Open Shipping Order Detail. Also fixed: quiet-log syncs skipped the
    append top-up entirely (now they run it; the log walk + never-logged
    re-copies still skip); `Ordr.EarliestStartDate` mirrored + shown on Open
    MF Order Detail (populated on 98% of that viewer's rows — no 0-use
    evidence covered it); calendar-impossible/9999+ dates now 400 instead of
    a Postgres cast 500; extreme `page` values 400 instead of an int64
    OFFSET overflow 500; duplicated query params (Express array parsing)
    read as absent instead of crashing `.trim()`; ILIKE search and the
    where-used ingredient filter escape `% _ \` (literal matching); the CSV
    formula-injection guard's numeric exemption now covers e-notation
    (negative float-noise qtys were getting a corrupting apostrophe); the
    web grid remounts per viewer id (state no longer leaks across viewers),
    refuses to export while required filters are unset (it would silently
    export the server-default window), and surfaces network failures during
    export. Killed finding: UTF-8-BOM-for-Excel (no contract; deliberate).

## Multi-language (§15 / UG ch.20, closed by evidence 2026-07-08)

The legacy `Vocabulary` table holds 4,305 rows — EVERY one with LANGUAGE
1033 (en-US). It is the desktop client's own string cache (UI labels, log
messages, SDS section headings cached by hash), not operator translations;
`LanguageCodes` lists 34 codes but no `Entity.Language` is set anywhere.
This install never ran a second language, so ERP1 ships single-language:
no Vocabulary mirror, no translation UI. `Item.AltDescription` (7,379 rows)
and per-line Description overrides — the "translatable user data" — are
already mirrored and displayed. If a second language is ever needed, i18n
starts from the web app's own string catalog, not from Vocabulary.

## Handheld functions (§19, closed by evidence 2026-07-08)

The legacy `Program` catalog has a `Folder = 'Handheld Functions'` group of
exactly 49 programs (`actPlm*` / `GeneralPlm*` / `Plm*` — Palm-era barcode
flows: consume, move container, container info, verify location, reweigh,
packout express/with-weighing, transfer cans, sanitization, ship container,
label-printer scans). Four independent evidence lines say this plant NEVER
used any of them:

1. All 49 programs: **zero** `Log` rows in the 15 years of retained history
   (exact `Program` name match — the same join that ranks fine for
   `PrintContainerLabel` 25,434 / `QuickBooksImportVendors` 454).
2. Handheld window titles all carry a "(Palm)" suffix; **no** `Log.Program`
   value has ever contained "Palm" (title-style logging is the norm for
   desktop programs, so this closes the naming-mismatch loophole).
3. `Log.Application` only ever holds 'Chemical Management System' / 'None' —
   no handheld client application ever logged in.
4. Every `Log.Workstation` is a named desktop/laptop (CS-PC, ROD-LAPTOP, …);
   no scanner/handheld device names. The UG's only handheld content is a
   Remote-Desktop display-glitch note (§24.4.1) — legacy handhelds were RDP
   thin clients into the same desktop app, so their usage WOULD have logged.

The plant runs receiving (9,134 Purchase Receipt uses), inventory counts
(3,129), and shipping (70,738 Waybill) from desktops. ERP1's web UI already
loads in any mobile browser and the inventory adjust/move/receipt APIs +
§18 viewers back every warehouse flow, so §19 ships ⏸️: no dedicated PWA,
no barcode screens. If barcode-first operation is ever wanted, it is a NEW
feature over the existing APIs (camera/wedge scanning into the existing
lot/location lookups), not legacy parity.
