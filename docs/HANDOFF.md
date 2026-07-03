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
  Run a single suite: `pnpm run test:integration -- <name-fragment>` from apps/api.
- **Generating a migration**: `prisma migrate dev` is interactive-only (fails
  headless). Use: edit schema →
  `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql`
  → `migrate deploy` → verify `migrate diff --exit-code` says no difference →
  `prisma generate`.
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
  Baseline `000000000000_init`; deploy auto-baselines db-push'd installs.
- Domain tables mirror legacy names (@map/@@map); ERP1-only columns on
  mirrored tables use `erp1_*` map names. Native rows get ids ≥ 1_000_000_000
  allocated under `pg_advisory_xact_lock(NATIVE_ID_ALLOC_LOCK)`
  (`apps/api/src/common/locks.ts`) with max-id/uniqueness/state checks
  **inside** the locked tx.
- **Concurrency invariants** (hardened 2026-07-03 across two reviews):
  1. Every multi-parcel Inventory acquisition is ONE global ascending-id
     `SELECT … FOR UPDATE` scan (`ValuationService.depleteSpecificMany` /
     `depleteFifoMany`; order reversal's produced+restored scan). NEVER loop
     per-lot locked reads — two different total orders deadlock (empirically
     reproduced, 40P01).
  2. Lifecycle transitions (release/complete/close/reverse) re-assert their
     precondition under the Ordr row lock INSIDE the tx
     (`lockAndRequireStatus`) — the lifecycle is non-monotonic since reversal
     (CMP→RLS), so pre-tx checks alone are stale reads.
  3. Consumption/shipment writers DEPLETE before writing their lineage/
     shipment record — the parcel locks are what serialize them against a
     reversal's untouched-stock guard.
  4. Anything mutating one order's execution/consumption state takes the Ordr
     row lock first (`OrdersService.lockOrdr`).
- Every mutation: `@RequireProgram` (seeded in `packages/db/prisma/seed.ts`,
  auto-granted to ADMIN) + atomic hash-chained audit
  (`AuditService.record(entry, tx)`) in the same transaction. E-sig actions
  use SecuredItems + `ESignatureService` (recipe publish / order complete /
  order reverse / QA disposition are templates).
- Boolean mirror columns: write explicit `false`, never leave NULL.
- Reversals via reversing ChangeSets; no destructive deletes of posted records.
- **Import-engine invariants** (§0, built 2026-07-03): legacy access ONLY via
  `LegacyDbService` (the seam integration tests fake); watermark =
  `app_settings import.logWatermark` (legacy Log id, digits-only); the sync
  must hold the watermark whenever a change was rejected; native rows are
  never deleted OR overwritten by imports (id range + native-Lot guard);
  LogResult FieldNames must be canonicalized to physical column casing.
- Integration tests (vitest, real Postgres) for every flow —
  `apps/api/test/integration/` with `support.ts` scaffolding; HTTP-layer
  route-table invariants cover auth automatically.
- After each increment: update FEATURE_PARITY.md (+ ASSUMPTIONS/OPEN_QUESTIONS)
  and run a multi-agent review over the staged diff (find → adversarially
  verify → fix confirmed findings) before committing. Scale the review to the
  diff. The two 2026-07-03 reviews each caught a critical data-loss bug the
  tests missed — do not skip this step.

## How the user will play with it

Install on an Ubuntu 24.04 VM (Proxmox):
`curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash`
(validated end-to-end in a container — fresh + upgrade modes; see
docs/DEPLOYMENT.md). Then set `LEGACY_MSSQL_PASSWORD` in `/etc/erp1.env`,
restart, and run **Administration → Legacy Import** (full import, then
schedule **Sync changes** during parallel running). Re-running the install
command upgrades in place.

## Priority queue (toward "shipped")

1. **Verify latest CI is green** (last session ended pushing 0f8641f —
   incremental sync; ab13884 order reversal is confirmed green; check 0f8641f
   completed green, fix first if red).
2. **`ItemPackagedProduct` mirror** (7,136 rows; bulk→packout binding) —
   needed for §5 "specify packouts" and §6 packaging-product lookup. Schema +
   migration + import TableSpec + surface where §6 needs it.
3. **§5/§6 remaining execution**: multi-batch creation, express modes,
   batch-order edit revisions (`OrdrEdit`/`OrdDetailEdit` are 0-row — native
   design), packaging end-lot specifics.
4. **§10 Planning/MRP** (supply/demand, plan trace, create-PO-from-plan),
   then **§13 accounting/QuickBooks export**, **§17 email notifications**,
   **§14 config tabs**, **§18 viewer library** (batch-build on DataGrid),
   **§15 i18n**, **§19 handheld PWA** — in that rough order.
5. Background chip pending: enforce secured-item PERFORM grant on
   order.complete + release.disposition. (The transfer/lot-tracking lock
   alignment shipped in 9ad2322 — which also stopped imports from mirroring
   lot-tracked items' Inventory rows, a resurrection bug found in its
   review.)
6. OPEN_QUESTIONS: native-Lot marker column (`erp1_native`) if parallel
   running shows YYMMDD### collisions on raw-material lots.
7. Before cutover: one real install pass on the actual Proxmox VM; a live
   `POST /import/sync` against the real legacy DB (only tested against the
   seam fake + shape-validated queries so far).

## State of the world (as of 2026-07-03, commit 0f8641f)

- Foundations ✅ (auth/RBAC/audit/e-sig/DataGrid/installer/migrations/CI).
- §4 Recipes ✅; §5/§6 guided execution core ✅ + **order reversal ✅**
  (un-complete CMP→RLS: RVSMFP ChangeSet, produced stock un-minted if
  untouched, consumed lots restored from the consumption edges, lines reset,
  `order.reverse` secured item — see ASSUMPTIONS §Order reversal; an ERP1
  extension, vendor forbade it).
- **§0 import engine ✅**: full import + log-driven incremental sync +
  reconciliation report (see ASSUMPTIONS §Incremental import sync — the
  Log/LogResult mechanics, watermark rules, never-logged-table recopies,
  native-row guards). NOT yet run against the real legacy DB end-to-end.
- Suites: 74 unit + 245 integration green; CI green through ab13884 (0f8641f
  pending at session end — verify).
- Programs added: `orders.reverse` (+ secured item `order.reverse`).
  No schema changes this session — no new migrations (latest remains
  `20260703010000_test_catalog`).
- Known quirks: recipe editor authors at per-100-lb basis (stored per-1-lb);
  `UseFrom` on UB lines undecoded; RMPP exec numbering is a documented
  extension; `Ordr.ActualBatchSize` holds the PLANNED size until completion
  (and reverts to it / to null for MFPP on reversal).
