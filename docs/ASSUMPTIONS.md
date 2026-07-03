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
