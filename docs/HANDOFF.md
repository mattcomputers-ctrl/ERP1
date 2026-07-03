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
  If `migrate deploy` errors "type UserStatus already exists", the migration
  ledger predates the resetDb fix — `prisma migrate resolve --applied <name>`
  for each already-applied migration (or drop/recreate the erp1_test DB).
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
  mirrored tables use `erp1_*` map names (e.g. OrdDetailTest results). Native
  rows get ids ≥ 1_000_000_000 allocated under
  `pg_advisory_xact_lock(NATIVE_ID_ALLOC_LOCK)` (`apps/api/src/common/locks.ts`)
  with max-id/uniqueness/state checks **inside** the locked tx.
- **Concurrency invariants** (added 2026-07-03 after review): anything that
  depletes Inventory goes through `ValuationService.depleteSpecific/depleteFifo`,
  which read parcels `SELECT … FOR UPDATE` in ascending-id order; anything
  mutating one order's execution/consumption state takes the Ordr row lock
  first (`OrdersService.lockOrdr` / `lockAndRequireReleased`) and re-asserts
  state inside the tx; dispensed lots are consumed in sorted order.
- Every mutation: `@RequireProgram` (seeded in `packages/db/prisma/seed.ts`,
  auto-granted to ADMIN) + atomic hash-chained audit
  (`AuditService.record(entry, tx)`) in the same transaction. E-sig actions
  use SecuredItems + `ESignatureService` (recipe publish / order complete /
  QA disposition are templates). Enforce the PERFORM (`allowed`) grant.
- Boolean mirror columns: write explicit `false`, never leave NULL.
- Reversals via reversing ChangeSets; no destructive deletes of posted records.
- Integration tests (vitest, real Postgres) for every flow —
  `apps/api/test/integration/` with `support.ts` scaffolding; HTTP-layer
  route-table invariants cover auth automatically.
- After each increment: update FEATURE_PARITY.md (+ ASSUMPTIONS/OPEN_QUESTIONS)
  and run a multi-agent review over the staged diff (find → adversarially
  verify → fix confirmed findings) before committing. Scale the review to the
  diff (full Workflow for substantive increments; a single adversarial agent
  for small mechanical ones).

## How the user will play with it

Install on an Ubuntu 24.04 VM (Proxmox):
`curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash`
(validated end-to-end in a container — fresh + upgrade modes; see
docs/DEPLOYMENT.md). Then set `LEGACY_MSSQL_PASSWORD` in `/etc/erp1.env`,
restart, and run **Administration → Legacy Import** to pull the plant's data.
Re-running the install command upgrades in place.

## Priority queue (toward "shipped")

1. **Verify latest CI is green** (last session ended pushing the §11 Test
   catalog commit — check it completed green; the prior guided-execution
   commit 69d3dc6 is confirmed green).
2. **§5/§6 remaining execution features** — guided execution core is DONE
   (per-line actuals, batch additions, IPT results, variance — see
   FEATURE_PARITY §5). Next: **order reversal** (reverse a completed batch:
   un-mint produced on-hand if untouched, restore consumed lots, reversing
   ChangeSets — mirror the receipt-reversal pattern in
   `apps/api/src/inventory`), then multi-batch, express modes, batch-order
   edit revisions (`OrdrEdit`/`OrdDetailEdit` are 0-row — native design).
3. **§0 Import engine hardening** — log-driven incremental sync (`Log` +
   per-row `Version`, Schema Report §9) + reconciliation report. Needed for
   the cutover story.
4. **`ItemPackagedProduct` mirror** (7,136 rows; bulk→packout binding) — needed
   for §5 "specify packouts" and §6 packaging-product lookup.
5. **§10 Planning/MRP**, **§13 accounting/QuickBooks export**, **§17 email
   notifications**, **§14 config tabs**, **§18 viewer library** (batch-build on
   DataGrid), **§15 i18n**, **§19 handheld PWA** — in that rough order.
6. Background chip already spawned: enforce the secured-item PERFORM grant on
   order.complete + release.disposition (recipe publish is the template).
7. Before cutover: one real install pass on the actual Proxmox VM.

## State of the world (as of 2026-07-03, commit 69d3dc6 + §11 catalog commit)

- Foundations ✅ (auth/RBAC/audit/e-sig/DataGrid/installer/migrations/CI).
- §4 Recipes ✅ (lifecycle/publish/pricing/mass-replacement); §5/§6 **guided
  batch execution core now live** (per-line record-actuals with lot dispense,
  batch additions, IPT results as `erp1_*` extension columns on OrdDetailTest,
  material variance + yield, PK STD stamp + cost re-roll at completion, all
  concurrency-hardened after a 23-agent review — see ASSUMPTIONS §Guided
  batch execution). §11 Test/TestGroup catalog mirrored + imported; the Item
  Tests name picker is catalog-backed.
- Suites: 74 unit + 216 integration tests green; CI green through 69d3dc6.
- Programs added this session: `orders.execute`, `orders.variance`.
- Migrations: `20260702120000_orddetailtest_ipt_results`,
  `20260703010000_test_catalog` (both deployed; drift clean).
- Known quirks: recipe editor authors at per-100-lb basis (stored per-1-lb);
  `UseFrom` on UB lines undecoded; RMPP exec numbering is a documented
  extension; `Ordr.ActualBatchSize` holds the PLANNED size until completion.
