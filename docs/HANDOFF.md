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
  PowerShell `$env:PATH = "$env:USERPROFILE\tools\node22;$env:PATH"`.
- **Integration tests**: need Docker Desktop running (if the Linux engine
  won't start, disable Docker AI — see memory). Disposable Postgres:
  `docker run -d --name erp1-itest-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=erp1_test -p 55432:5432 postgres:16`
  then `pnpm --filter @erp1/db migrate:deploy` and
  `pnpm --filter @erp1/api test:integration` with
  `DATABASE_URL=postgresql://postgres:postgres@localhost:55432/erp1_test?schema=public`.
  (The container may already exist from a prior session — reuse or recreate.)
- **Legacy DB** (ground truth): READ-ONLY via the `mssql` MCP tool (SQL Server
  10.10.10.11, db CMS). Never write. Verify schema/data by querying — never
  guess. Vendor PDFs in `reference/` (extract with
  `"C:\Program Files\Git\mingw64\bin\pdftotext.exe"`; some chapters already
  extracted in prior sessions' scratchpads are gone — re-extract as needed).
- **Git push** works via the credential manager (`git push origin main`).
  CI = GitHub Actions; check via
  `https://api.github.com/repos/mattcomputers-ctrl/ERP1/actions/runs?per_page=1`
  and fix promptly if red.

## Hard conventions (violations get caught in review — save the round-trip)

- **Every schema.prisma change requires a Prisma migration** in
  `packages/db/prisma/migrations/` (CI has a drift check that fails otherwise).
  Baseline is `000000000000_init`; deploy auto-baselines db-push'd installs.
- Domain tables mirror legacy names (@map/@@map); native rows get ids
  ≥ 1_000_000_000 allocated under `pg_advisory_xact_lock(NATIVE_ID_ALLOC_LOCK)`
  (`apps/api/src/common/locks.ts`) with the max-id/uniqueness/state checks
  **inside** the locked transaction (pre-tx reads are fast-fail UX only).
- Every mutation: `@RequireProgram` (program seeded in
  `packages/db/prisma/seed.ts`, auto-granted to ADMIN) + atomic hash-chained
  audit (`AuditService.record(entry, tx)`) in the same transaction. E-sig
  actions use SecuredItems + `ESignatureService` (see recipe publish /
  order complete / QA disposition as templates). Enforce the secured item's
  PERFORM (`allowed`) grant on new actions.
- Boolean mirror columns: write explicit `false`, never leave NULL
  (`NOT { inactive: true }` filters drop NULLs).
- Reversals via reversing ChangeSets; no destructive deletes of posted records.
- Integration tests (vitest, real Postgres) for every flow —
  `apps/api/test/integration/` with `support.ts` scaffolding; HTTP-layer
  route-table invariants cover auth automatically.
- After each increment: update FEATURE_PARITY.md (+ ASSUMPTIONS/OPEN_QUESTIONS)
  and run a multi-agent review workflow over the staged diff
  (find → adversarially verify → fix confirmed findings) before committing.

## How the user will play with it

Install on an Ubuntu 24.04 VM (Proxmox):
`curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash`
(validated end-to-end in a container — fresh + upgrade modes; see
docs/DEPLOYMENT.md). Then set `LEGACY_MSSQL_PASSWORD` in `/etc/erp1.env`,
restart, and run **Administration → Legacy Import** to pull the plant's data.
Re-running the install command upgrades in place.

## Priority queue (toward "shipped")

1. **Verify latest CI is green** (last session ended at commit `af181fc`).
2. **§5/§6 Batch & Packaging execution** — the biggest parity block. Order
   lifecycle, batch sheets, consume-lots, valuation, e-sig complete already
   exist; missing: guided execution (dispense/weigh per line, record actuals,
   IPT results during execution), material variance, multi-batch, express
   modes, order reversal. Discover against `OrdDetail`/`InventoryUsed`/
   `ChangeSet` live data first.
3. **§0 Import engine hardening** — bulk import exists (admin UI); build the
   log-driven incremental sync (`Log` + per-row `Version`, Schema Report §9)
   + a reconciliation report. Needed for the cutover story.
4. **§11 Test/TestGroup catalog** (35+4 rows) — mirror + import + name picker
   on Item Tests (small win).
5. **`ItemPackagedProduct` mirror** (7,136 rows; bulk→packout binding) — needed
   for §5 "specify packouts" and §6 packaging-product lookup.
6. **§10 Planning/MRP**, **§13 accounting/QuickBooks export**, **§17 email
   notifications**, **§14 config tabs**, **§18 viewer library** (batch-build on
   DataGrid), **§15 i18n**, **§19 handheld PWA** — in that rough order.
7. Background chip already spawned: enforce the secured-item PERFORM grant on
   order.complete + release.disposition (recipe publish is the template).
8. Before cutover: one real install pass on the actual Proxmox VM.

## State of the world (as of 2026-07-02, commit af181fc)

- Foundations ✅ (auth/RBAC/audit/e-sig/DataGrid/installer/migrations/CI).
- §4 Recipes: lifecycle management, versioning, publish, preview, pricing,
  mass-replacement — all live and reviewed; libraries/advanced vendor features
  deferred (unused in this install — evidence in ASSUMPTIONS.md).
- Suites: 74 unit + 203 integration tests green; CI green.
- Known quirks: recipe editor authors at per-100-lb basis (stored per-1-lb);
  `UseFrom` on UB lines undecoded (native recipes omit UB); RMPP exec
  numbering is a documented extension.
