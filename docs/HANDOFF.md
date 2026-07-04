# Session handoff — ERP1 autonomous build

**Read this first in every new session.** It is the standing contract for how
this project is built. The durable state is: this repo (+ GitHub),
[FEATURE_PARITY.md](../FEATURE_PARITY.md) (the tracker), the docs/ folder, and
the assistant auto-memory. Everything else (chat context) is disposable.

## Mission

Rebuild the legacy Mar-Kov CMS (regulated chemical/pharma batch manufacturing
ERP/MES) as ERP1 until **full feature parity**: every FEATURE_PARITY.md row ✅
or ⏸️ (intentionally deferred). Zero user interaction: never ask questions,
never wait for approval; decide, record in docs/ASSUMPTIONS.md /
docs/OPEN_QUESTIONS.md, keep building. Work in vertical increments: discovery
→ build (schema + API + web + tests) → multi-agent review → fix → commit →
push → verify CI green. When context runs low, update this file + memory and
end with a fresh handoff prompt.

## Environment (Windows dev host)

- **Node/pnpm are NOT on PATH.** Portable Node 22 lives at
  `%USERPROFILE%\tools\node22`. Prefix every shell:
  PowerShell `$env:PATH = "$env:USERPROFILE\tools\node22;$env:PATH"`,
  bash `export PATH="$HOME/tools/node22:$PATH"`.
- **Integration tests**: need Docker Desktop running (if the Linux engine
  won't start, disable Docker AI — see memory). Disposable Postgres:
  `docker run -d --name erp1-itest-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=erp1_test -p 55432:5432 postgres:16`
  (usually already exists — `docker start erp1-itest-pg`), then
  `pnpm --filter @erp1/db migrate:deploy` and
  `pnpm --filter @erp1/api test:integration` with
  `DATABASE_URL=postgresql://postgres:postgres@localhost:55432/erp1_test?schema=public`.
  Run one suite: `pnpm exec vitest run --config vitest.integration.config.ts test/integration/<file>` from apps/api.
- **Generating a migration**: `prisma migrate dev` is interactive-only (fails
  headless). Use: edit schema →
  `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql`
  → `migrate deploy` → verify `migrate diff --exit-code` says no difference →
  `prisma generate`. To amend an UNCOMMITTED migration: drop the itest schema
  (`docker exec erp1-itest-pg psql -U postgres -d erp1_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`),
  delete the migration dir, redeploy the rest, regenerate one migration.
- **Legacy DB** (ground truth): READ-ONLY via the `mssql` MCP tool (SQL Server
  10.10.10.11, db CMS). Never write. Verify schema/data by querying — never
  guess. Vendor PDFs in `reference/` (extract with
  `"C:\Program Files\Git\mingw64\bin\pdftotext.exe"`).
- **Git push** works via the credential manager (`git push origin main`).
  CI = GitHub Actions; check via
  `https://api.github.com/repos/mattcomputers-ctrl/ERP1/actions/runs?per_page=1`
  (no `gh` CLI on this host) and fix promptly if red.

## Hard conventions (violations get caught in review — save the round-trip)

- **Every schema.prisma change requires a Prisma migration** in
  `packages/db/prisma/migrations/` (CI drift check fails otherwise).
- Domain tables mirror legacy names (@map/@@map); ERP1-only columns on
  mirrored tables use `erp1_*` map names. Native rows get ids ≥ 1_000_000_000
  allocated under `pg_advisory_xact_lock(NATIVE_ID_ALLOC_LOCK)`
  (`apps/api/src/common/locks.ts`) with max-id/uniqueness/state checks
  **inside** the locked tx.
- **Concurrency invariants**:
  1. Every multi-parcel Inventory acquisition is ONE global ascending-id
     `SELECT … FOR UPDATE` scan. NEVER loop per-lot locked reads (deadlock,
     empirically reproduced 40P01).
  2. Lifecycle transitions re-assert their precondition under the Ordr row
     lock INSIDE the tx (`lockAndRequireStatus`) — lifecycle is non-monotonic
     (reverse: CMP→RLS; revisions: RLS↔EDT).
  3. Consumption/shipment writers DEPLETE before writing lineage/shipment.
  4. Anything mutating one order's state takes the Ordr row lock first.
  5. **E-signed actions must PIN their reviewed target**: credentials verify
     pre-tx (slow Argon2), so the DTO carries the target id (+ an updatedAt
     content token where drafts are editable) asserted under the row lock —
     a signature must never land on content the signer didn't review
     (order-revisions publish/reject is the template).
- Every mutation: `@RequireProgram` (seeded in `packages/db/prisma/seed.ts`,
  auto-granted to ADMIN) + atomic hash-chained audit
  (`AuditService.record(entry, tx)`) in the same transaction. E-sig actions
  use SecuredItems + `ESignatureService` (recipe publish / order complete /
  order reverse / order revise / QA disposition are templates).
- Boolean mirror columns: explicit `false`, never NULL. Prisma `NOT`/`notIn`
  drop NULL rows; `@IsOptional()` skips ALL validators on explicit null —
  services re-assert numeric positivity. A single `notIn` list breaks past
  32,767 bind variables — compute set-differences app-side, delete in
  5,000-id `in` chunks.
- Reversals via reversing ChangeSets; no destructive deletes of posted
  records. Derived/editable working state must keep its FULL BASELINE
  (mark-removed, don't delete) so "user removed X" and "X appeared behind our
  back" are distinguishable — silently deleting drift is a data-loss bug
  (order-revisions publish is the template).
- **Import-engine invariants** (§0): legacy access ONLY via `LegacyDbService`
  (the seam tests fake); watermark = `app_settings import.logWatermark`;
  native rows never deleted/overwritten by imports; LogResult FieldNames
  canonicalized to physical casing; tables absent from the change feed live
  in NEVER_LOGGED_ALWAYS/PROXIED (wholesale re-copy); `replaceStale` specs
  (PlanTrace) additionally prune vanished legacy-range rows — but an EMPTY
  snapshot against a non-empty mirror skips the prune (mid-rewrite guard).
- **Qualification and pricing must use the same row**: when a rule filters
  candidates (e.g. manufacturer-aware supplier pricing), the row that
  QUALIFIES the candidate must be the row that gets USED — a second,
  filter-blind lookup silently picks a different offer
  (`effectivePriceDetail(manufacturerId)` is the template). Inventory is
  only nettable stock at WHS/null-context locations — SMP retain samples /
  VSL / ASM are on-hand but never plannable or consumable supply.
- Integration tests (vitest, real Postgres) for every flow; use
  CLOCK-RELATIVE dates when the code compares against "now" (no time bombs).
- After each increment: update FEATURE_PARITY.md (+ ASSUMPTIONS/
  OPEN_QUESTIONS) and run a multi-agent review over the staged diff (find →
  adversarially verify → fix confirmed) before committing. The 2026-07-03
  reviews confirmed 13 + 11 findings the tests missed — never skip.

## How the user will play with it

Install on an Ubuntu 24.04 VM (Proxmox):
`curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash`
(validated end-to-end in a container — fresh + upgrade modes; see
docs/DEPLOYMENT.md). Then set `LEGACY_MSSQL_PASSWORD` in `/etc/erp1.env`,
restart, and run **Administration → Legacy Import** (full import, then
schedule **Sync changes** during parallel running).

## Priority queue (toward "shipped")

1. **Verify CI green for 43ef59e** (create-PO-from-plan; d84be91 — the native
   recalc engine — is confirmed green. Fix first if red).
2. **§13 accounting/QuickBooks export** (UG ch.18: the QuickBooks bridge —
   invoices/bills/inventory sync; legacy `Trans` CI rows are the invoice
   backbone, see [[sales-docs-mapping]]; decide export format: IIF vs a
   CSV/report pack — discovery first).
3. **§10 leftover — Inventory Supply & Demand tool** (UG §13.3: per-item
   sources / existing orders / all-demand / supply-for-demand tables —
   read-only analysis viewer; the recalc engine's loaders are reusable).
4. **§17 email notifications**, **§14 config tabs**, **§18 viewer library**
   (batch-build on DataGrid), **§15 i18n**, **§19 handheld PWA** — in that
   rough order.
5. Background chip pending: enforce secured-item PERFORM grant on
   order.complete + release.disposition (+ order.revise now).
6. OPEN_QUESTIONS: native-Lot marker column if parallel running shows
   YYMMDD### collisions; Ordr.ReserveAmount on SH orders (sales-side, 45
   rows) — surface on documents?
7. Before cutover: one real install pass on the actual Proxmox VM; a live
   `POST /import/sync` against the real legacy DB (seam-fake tested only);
   disable the PlanTrace import spec (the native plan takes over — setting
   `planning.source` already flips on first recalc).

## State of the world (as of 2026-07-04, commit 43ef59e)

- Foundations ✅; §4 Recipes ✅; §5/§6 execution core + reversal + packouts +
  express execution + order-edit revisions ✅ (MFPP works too = §9 covered).
- **§6 end-lot + reserved-material release ⏸️ with evidence**: MFPP lines
  have NO phases, LocationVessel is 0-row, ReserveAmount is sales-side only.
- **§10 MRP ✅** (d84be91 + 43ef59e, 2026-07-04): the NATIVE Recalculate
  Plan Trace engine (`POST /planning/recalculate`, program
  `planning.recalculate`) — §14.1 fill order over ERP1 data (AVAIL/consigned
  entity code → Hold/Expired assumed-approved → pinned-sublot Rejected →
  MF#n/PO#n with late `+` → Short + active-costing-recipe explosion, root
  order carried through all waves, MFLevel = item's deepest wave); demand =
  open SH + MF UI lines (QtyReqd−QtyUsed), min-stock AFTER orders (orders
  win the stock — verified vs the live legacy plan). Planning knobs live on
  the NEW `ItemEntity` mirror (ST rows; Item has no such columns);
  `Ordr.LeadTime` + `Item.CostingRecipe` mirrored too. ONLY WHS/null-context
  locations are nettable (SMP retain samples are not stock!). Native rows
  id ≥ 1e9 replaced per recalc under the native-id lock; viewers switch via
  `planning.source` setting + `?source=` override. **Create-PO-from-plan**
  (§14.2.1, program `planning.createPo`): selected Short lines (same item +
  required manufacturer, never sublot-pinned) → one PO via purchasing.create;
  supplier must price the combination on its CURRENT version
  (manufacturer-aware sourcing: the qualifying detail IS the priced detail);
  multi-supplier → options round-trip. §10's "Inventory supply & demand"
  row (UG §13.3 tool) is still ⬜.
- **§0 import engine ✅** (not yet run against the real legacy DB end-to-end).
- Suites: 74 unit + 303 integration green; CI green through d84be91
  (43ef59e pending at handoff-write time — verify).
- Multi-batch ⏸️ (Ordr.Parent NULL on all 75K orders).
- Known quirks: recipe editor authors per-100-lb (stored per-1-lb); `UseFrom`
  on UB lines undecoded (UB lines locked in revisions); RMPP exec numbering
  is an ERP1 extension; `Ordr.ActualBatchSize` holds PLANNED size until
  completion; plan dates are plant wall-clock stored as UTC digits — compare
  against UTC-digit midnight (see [[datetime-timezone-handling]]); the
  manufacturer-pinning feature (OrdDetail/RecipeDetail.Manufacturer) is
  0-row in this install but fully implemented in planning + purchasing.
