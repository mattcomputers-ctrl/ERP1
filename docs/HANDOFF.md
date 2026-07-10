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
  `docker run -d --name erp1-itest-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=erp1_test -p 54332:5432 postgres:16`
  (usually already exists — `docker start erp1-itest-pg`), then
  `pnpm --filter @erp1/db migrate:deploy` and
  `pnpm --filter @erp1/api test:integration` with
  `DATABASE_URL=postgresql://postgres:postgres@localhost:54332/erp1_test?schema=public`.
  Run one suite: `pnpm exec vitest run --config vitest.integration.config.ts test/integration/<file>` from apps/api.
  If the container won't start with "ports are not available … access
  permissions", Windows reserved the port after a reboot — check
  `netsh int ipv4 show excludedportrange protocol=tcp`, recreate the
  container on a port outside every range, and use that port in
  DATABASE_URL (this bit 55432 on 2026-07-05; the recipe moved to 54332).
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
  1b. **Advisory-lock ORDER: NATIVE_ID_ALLOC_LOCK before AUDIT_CHAIN_LOCK.**
     Every allocating path takes the native-id lock at tx start and audits
     later; `NotificationEngineService.emit` allocates (native-id lock), so
     in a tx that hasn't already taken the native-id lock, emit BEFORE
     `audit.record` — the reverse is an ABBA deadlock (2026-07-05 review
     confirmed it in four emitter placements).
  1c. **NATIVE_ID_ALLOC_LOCK before any parcel `FOR UPDATE` scan.** Movement
     emission (2026-07-08) made every consume/ship/record-line/express path
     an allocator; adjust/transfer lock advisory-then-parcels, so
     parcels-then-advisory is an ABBA deadlock. Order paths: Ordr row lock →
     advisory lock → parcel scan (reverse() was the precedent).
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
  snapshot against a non-empty mirror skips the prune (mid-rewrite guard);
  `appendOnlySync` specs (InvMovement family, insert-only + never logged)
  top up past a PERSISTED per-table anchor (`import.appendWatermark.<T>`)
  advanced ONLY on zero-reject batches — anchoring on the mirror's max id
  loses rejected lower-id rows (2026-07-08 review); the top-up runs even on
  quiet-log syncs.
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

1. ~~APPLY THE PARITY SWEEP~~ **DONE** (ccc4f27). ~~QA module group~~
   **DONE** (9d212cd + dac1af0). ~~SH staging (L113)~~ **DONE 2026-07-09**
   (4723eed, ASSUMPTIONS §22). ~~Warehouse transfers + returns/credits
   (L115)~~ **DONE 2026-07-09** (ASSUMPTIONS §23). **12 rows open, all
   queued builds.**
2. **Build the remaining gaps** (details + sizes in the sweep doc) — NEXT
   UP: (a) MFA/TOTP + OIDC SSO (L19 — committed greenfield security
   requirement, not legacy parity); (b) smaller: supervisor in-place
   elevation (L22), item/entity edit-form gaps (L31/L33/L34), supplier
   price-version editor (L37/L48), shipment reversal (L60 — RVSSH restores
   INTO the ASM assembly per §22 discovery; the reversal must also unwind
   QtyUsed/shipment_lot and respect reversal-pair invoice math), count
   sheets (L62), label printing incl. sample labels (L64 — the assembly
   label doc is the print template precedent), recipe expected-cost
   sub-recipe rollup (L75 — CostingRecipe already imported, pure rollup
   extension), doc logo upload (L153).
3. Background chip pending: enforce secured-item PERFORM grant on
   order.complete + release.disposition (+ order.revise now).
4. OPEN_QUESTIONS: native-Lot marker column if parallel running shows
   YYMMDD### collisions; N-sequence invoice numbers can collide during
   parallel running (reserve an E-prefix or cut invoicing over in one go);
   Ordr.ReserveAmount on SH orders (45 rows) — surface on documents?;
   items.create uses plain autoincrement, not the native-id range (new,
   2026-07-05).
5. Before cutover: one real install pass on the actual Proxmox VM; a live
   `POST /import/sync` against the real legacy DB (seam-fake tested only —
   NOTE: the first sync after upgrading now also pulls the full 609K+972K
   InvMovement family if the full import predates the mirror); a FULL
   re-import (or re-run) after the numeric(19,4) migration restores the 4dp
   leg values the old money column cent-rounded (ASSUMPTIONS §20.12);
   disable the PlanTrace import spec (the native plan takes over — setting
   `planning.source` already flips on first recalc).

## State of the world (as of 2026-07-09 latest, SH staging + L115)

- **SH staging ✅** (4723eed, ASSUMPTIONS §22): the legacy Shipping Assembly
  flow reconstructed from data and built natively — single-use ASM `Location`
  assemblies ('EA'+5 native namespace, one order each via
  `Location.Reference`, parent BRECEIVE, DEL when emptied by shipment),
  stage/unstage = parcel split/merge + `Inventory.OrdDetail` reservation +
  legacy-exact valueless PICK legs (US at source first, MK at assembly
  carrying the line; unpick mirrored), per-event native PICK ChangeSets.
  **Depleter eligibility rule**: reserved parcels + SMP/ASM(/consigned, §23)
  locations are untouchable everywhere; ONE carve-out
  (`allowReservedToLineIds`) lets the owning order's shipLots draw its
  reservations FIRST. shipLotOptions returns per-line `reserved` (web
  pre-fill, emerald chips); emptied assemblies DEL'd at ship; printable
  assembly label at `/assemblies/:id/label`; program `shipping.stage`.
  Guards: transfer/adjust refuse reserved+SMP/ASM parcels, NST line-remove
  and lot-enable refuse while reserved, unstage refuses IMPORTED (sync-owned)
  reservations — staging/unstaging is lot-traced-items-only, which is what
  makes reservations sync-safe. Review: 16 unique findings, dual-verified
  (opus fallback when Fable verifiers hit usage limits — the standing
  recipe), 10 confirmed + fixed (§22.10).
- **Warehouse transfers + returns/credits ✅** (ASSUMPTIONS §23): TI
  invoices (T-sequence, price-0 lines, freight refused) minted by
  `POST /invoices` for IsWarehouse ship-tos; shipLots RELOCATES the shipment
  into the warehouse's consigned WHS location (auto-created native; valued
  TRNSFR MK legs, **leg owner = the warehouse entity** — verified ledger
  owner-change) under an order-linked TRNSFR ChangeSet. Returns: SH lines +
  ship entries accept negative quantities (sign must match the linked
  line's; zero refused; warehouse orders refuse returns); negative entries
  mint returned stock at the receiving location (lot's LATEST sublot) with
  the legacy return shape (positive line-stamped valued US leg under the SH
  cs), QtyUsed negative, negative shipment_lot; return lines bill their
  negative remainder = credit. `POST /invoices/:id/reverse` = the legacy
  credit pattern (same TransDocument, ReversedTrans link, negated
  details/taxes/freight; pairs net in billed-qty math so re-billing works);
  reverse control on the Invoices browser; credit doc prints a CREDIT banner
  + negated freight/tax rows. **CRITICAL review catch (§23.6): consigned
  locations joined SMP/ASM as protected stock in BOTH depleters** (owner →
  IsWarehouse join) + all three pickers; tax round2 is half-away-from-zero
  (credits negate sales exactly). Planning still nets consigned WHS stock
  (validated-exact engine — change only with fresh evidence).
- Suites: 114 unit + 442 integration green; CI runs #121 (4723eed, SH
  staging) and #122 (2b76092, L115) both green.

## State of the world (as of 2026-07-09 later, QA module group)

- **Native QA sampling ✅** (dac1af0, ASSUMPTIONS §21): discovery REFUTED the
  sweep's receipt-seam plan — legacy receipts never created sample sets OR
  sublots (ChangeSetReceipt.Sublot NULL on all 9,074+424 rows); all 25,416
  sets come from ONE seam (batch IPT execution); OnReceipt/OnProduction are
  both=1 on all 13,524 ItemTest rows (the gate is "item HAS tests"); legacy
  Release is append-only history; sets move REAL stock (0.005 kg vessel→SMP).
  ERP1: **every native sublot gets a Release at birth** — Approved/GMP/dated
  at receive/misc/lot-enable (receiving never quarantined here), and at
  completion tested products get Hold/HOLD + native SampleSet (mirrored +
  imported, log-driven; IptOrdDetail = the order's IPT line) + retained-sample
  split (kg→lb ×2.2046226218487757) into a native SMP location
  ('E'+5-digit namespace — NOT legacy's live sequence) + ONE valueless SAMPLE
  movement (context added to MovementRecorder; releaseId stamped) +
  pre-created LocationSampleTest rows + 'New Sample set' (rule #10, last
  configured QA code). The approving disposition mints the native ReleaseCofA
  header. reverse() unwinds it all; refuses via a BORN-SHAPE guard once any
  disposition/result exists; auto-rejects stale PENDING disposition requests.
  **New conventions from the review round (8/8 unique findings dual-confirmed,
  fixed — §21.9)**: QA writers (enterResults / applyDispositionToRelease) take
  NATIVE_ID_ALLOC_LOCK at tx start + re-read their target rows IN-TX
  (serializes vs the reversal unwind; ABBA-safe); SMP-context parcels are
  EXCLUDED from both valuation depletion scans (retained samples are never
  consumable); lot-enable REFUSES while the item has an undispositioned
  native sample. SamplingService lives in qa/ but is PROVIDED by
  InventoryModule (QaModule↔InventoryModule would be circular).
- **Test-catalog admin ✅** (9d212cd, ASSUMPTIONS Test-catalog section): CRUD
  on the natural-key `Test` master (name ≤20 PK, case-insensitive-unique
  in-tx under the alloc lock, NO rename — ItemTest/OrdDetailTest/LST link by
  name), NUM|BOOL + NUM-only precision, group must exist, delete guarded by
  ItemTest refs (case+whitespace-insensitive raw-SQL count), program
  qa.testCatalogEdit; Catalog section on the Item Tests page. Review round
  fixed 5 defects incl. prototype:null→NULL and a stale pre-tx read.
- Suites: 113 unit + 413 integration green. FEATURE_PARITY: 60+4 ✅ / 28 ⏸️ /
  14 open.

## State of the world (as of 2026-07-09, native movement emission)

- **Native InvMovement emission ✅** (ASSUMPTIONS §20): every ERP1 inventory
  writer posts InvMovement/InvMovementDtl legs IN THE SAME TX via
  `MovementRecorderService` (apps/api/src/inventory/movement-recorder.service.ts)
  — the §18 movement/at-date/shipment-detail/order-cost viewers keep gaining
  data after cutover. On-hand truth only (one non-B leg per Inventory qty
  change; no WIP B-legs; shortfall-only consumes emit nothing);
  per-parcel-draw grain (depleters return `takes`); header contexts stay in
  the legacy whitelist; reversals keep forward contexts under the reversing
  change set and NEGATE THE STORED forward legs (never re-derive from
  current cost); per-EVENT native MF/MFP change sets date the at-date axis;
  shipLots mints a native SH change set = PACKING SLIP (returned as
  `packingSlipId`) and apportions US legs per (parcel draw × line);
  lot-enable rebases the ledger (negates the per-owner at-date sums, posts
  opening MK legs) and the accounting adjustments export now books that
  rebase from the legs (audit-less native COUNT css). Leg Owner is
  data-driven (modal legacy leg owner → modal Ordr owner → min Entity).
  **NEW HARD RULE 1c**: alloc lock BEFORE parcel FOR UPDATE scans —
  consume/ship/record-line/express now allocate. `InvMovementDtl.Value`
  migrated money→numeric(19,4) (Postgres money cent-rounds; 43% of legacy
  legs are sub-cent — full re-import restores them). §19 handheld CLOSED
  (zero use in 15 years, four evidence lines). Review round: 6 lenses →
  8/8 findings dual-confirmed, all fixed (ASSUMPTIONS §20.13) — majors: the
  GL-invisible lot-enable rebase; undocumented zero-precedent context
  mappings.
- Suites: 113 unit + 391 integration green.

## State of the world (as of 2026-07-08, §18 viewer library)

- **§18 Viewer library ✅**: legacy set viewers have no config tables (client
  grids over vendor SQL views), so ERP1 ships a DECLARATIVE platform —
  per-viewer defs (`apps/api/src/viewers/viewer-registry.ts`: SQL fragment
  constants + typed columns + param builders; values bound, sort via column
  whitelist) behind ONE generic endpoint (`GET /viewers/:id/rows`, full-set
  CSV `GET /viewers/:id/export` with formula-injection guard incl.
  e-notation) and ONE generic web grid (`/viewers/:id`, remounts per id).
  Program-per-viewer (`viewers.*`) checked IN-SERVICE (dynamic :id — the
  http-layer 403 invariant excludes these four routes via
  DYNAMIC_PROGRAM_ROUTES; viewers.http.spec.ts pins the behavior instead).
  Nine viewers = the plant's usage-ranked working set (Shipment Detail 396,
  Open Shipping Order Detail 290, Inventory Movement 153, Open MF Order
  Detail 153, Purchase History 61, Batching Order 44, Where Used 21,
  Inventory At Date, Complete MF Orders 14); ~35 never-used viewers ⏸️ with
  Log evidence; Inventory Cost ⏸️ (GetInventoryCosts returns ZERO rows
  install-wide, verified). Encrypted vendor functions reconstructed +
  validated LIVE: at-date = Σ non-B movement legs < asOf+1d (exact);
  order actual cost = Σ MK/MKCA/MKB/MKBCA leg values (12/12 exact — bulk
  orders post cost as CA/MKBCA); uncommitted = balance − committed
  (committed = QtyCommitted + positive commit edges). `InvMovement` +
  `InvMovementDtl` mirrored lean (dead columns dropped with live evidence;
  `Ordr.EarliestStartDate` + Salesman columns added after review caught the
  over-trim). Sync = append-only top-up (see import invariants). Review
  round: 6 lenses → 12/13 confirmed by dual adversarial verifiers, all
  fixed (details ASSUMPTIONS §18.11 — the major: persisted append
  watermark).
- Suites: 113 unit + 372 integration green.

## State of the world (as of 2026-07-05 later, §14 configuration)

- **§14 Configuration tabs ✅**: typed settings REGISTRY
  (apps/api/src/settings/settings-registry.ts — only LIVE keys, grouped like
  the legacy Configuration Update tabs) + `GET /settings/registry` + typed
  PUT validation (blank/negative REFUSED for number keys — a cleared field
  must never silently zero the lockout) + `/configuration` tabbed page
  (admin.config). Live wires: `security.*` → AuthService (lockout count/
  duration + password min length; blank/negative stored values fall back to
  defaults, only an explicit 0 disables lockout;
  `AuthService.assertPasswordPolicy` is the single enforcement point — DTOs
  carry only the floor 6 — and applies to admin-created initial passwords);
  `receiving.manfLotRequired` → purchase receiving (legacy ran False, ERP1
  defaults true; PO detail response carries the policy for the client form;
  null-supLot lots classify 'raw' via supplierId in genealogy);
  `batchExecution.yieldTolerancePercent` → complete() warnings[] (advisory,
  surfaced in the web completion flow). Params* NOT mirrored as tables —
  live values seeded as defaults; load-bearing conventions (lot-code
  yyMMdd+3, recipe version .NN) stay deliberately hardcoded (ASSUMPTIONS
  §14). Workstation/agent/bins/zones/location-groups/storage-rules ⏸️ with
  row-count evidence; legacy Job table note in OPEN_QUESTIONS.
- **Environment note**: Windows reserved port 55432 after a reboot
  (excluded-port ranges) — the itest Postgres recipe moved to **54332**.
- Suites: 113 unit + 351 integration green.

## State of the world (as of 2026-07-05, §17 notifications)

- **§17 Email notifications ✅**: `Notification`/`NotificationDetail`/
  `EmailSent` mirrored (full import copies all three; sync re-copies ONLY
  EmailSent — rule config is ERP1-owned after first import, see
  ASSUMPTIONS §17.10). Rule engine (`NotificationEngineService.emit`, runs
  INSIDE the business tx): exact security-group → '*' fallback; recipients =
  rule SendTo + first-owner-up-the-entity-chain NotificationDetail rows +
  contextual actor e-mail unless UseSendtoListOnly; `@Field`/`@Table`
  queue-time HTML render with `notifications.baseUrl` deep links; native
  EmailSent ids under the alloc lock. **Emit BEFORE audit.record in any tx
  that didn't already take the native-id lock (convention 1b)**. 15 codes
  wired: MFO Created (create/edit/revision — the only kind this plant ever
  fired: 516 e-mails 2022, ALL stuck 'Not sent', Database Mail never worked),
  MFO Released, Mark Complete, Order Edit Publish, Purchase/Misc receipt +
  reversals, New Item, Reweigh Outside Threshold
  (`inventory.reweighThreshold`, live legacy value 5%), Release Sublot,
  Tests Completed (transition-only), and post-recalc Short/Expedite/Testing
  Required @Table summaries. Dispatcher (`EmailProcessorService`): 60 s
  in-API poller; per-e-mail CAS claim ('Sending', attempts counted at
  claim), SMTP send OUTSIDE any tx (nodemailer behind `MailTransport`;
  10s/10s/30s timeouts; requireTLS when auth'd w/o implicit TLS), stale-claim
  sweep; **ids < 1e9 never dispatched** (imported 2022 queue is history).
  `smtp.*`/`notifications.*` settings seeded (enabled=false); SMTP_URL env
  override; /notifications page (rules editor + e-mail log + mail settings
  card + test send); program `notifications.config`. `EmailNotification`
  table ⏸️ (0 rows). Review round: 15 confirmed findings fixed incl. the
  batch-tx duplicate-delivery dispatcher rebuild + the ABBA lock inversion
  (details in ASSUMPTIONS §17.11).
- Suites: 109 unit + 341 integration green.

## State of the world (as of 2026-07-04 late, commit ac4fcaf)

- **§13 Accounting ✅** (4378ccc): GL/tax masters mirrored + imported
  (`GLGroup`/`GLCode`/`AccountCode`/`GLGroupCode`/`TaxRule` — all ARE in the
  legacy change feed; `Item.Tax2Group/Tax3Group` gap closed) with a full
  CRUD Accounting page (program `accounting.config`); **tax engine** per UG
  §17.4.7 (`tax-math.ts` pure + `TaxService` — pass the tx client when
  already inside a transaction!); **native invoice generation**
  (`POST /invoices`, program `sales.invoice`): bills QtyUsed − prior
  non-reversed CI per line (legacy invoices per shipment event), header
  copies the order, N+8-digit sequence continues the plant's numbering
  (collision note in OPEN_QUESTIONS), Ordr row lock → id-alloc lock;
  `shipLots` now stamps `OrdDetail.QtyUsed` under the Ordr row lock with
  in-tx validation (lot item must BE the line item). **Accounting export**
  (`POST /accounting/export`, program `accounting.export`): date-range
  double-entry journal as QuickBooks IIF or CSV — invoices/PO-receipt
  BILLs/MISC receipts/native adjustments (audit-trail delta)/native builds
  (consumption genealogy); by-package PO prices divide by
  `OrdDetailPricing.entityQuantity` (the 864x lesson); reversed receipts
  netted out or counter-entered across periods; account resolution
  Item.GLGroup → GLGroupCode → AccountCode with `accounting.*Account`
  settings + fallback-with-warning; cents-exact, headers pinned to document
  totals; `accounting_export_run` ledger + audit per download. The legacy
  live QB COM bridge was used for 7 txns in 2018/19 then abandoned —
  reconciliation ⏸️. "Cost categories" row ⏸️ (zero data).
- **§10 Supply & Demand viewer ✅** (ac4fcaf): read-only Allocate Demand
  (UG §13.3) — `GET /planning/supply-demand?itemId=` (program
  `planning.supplyDemand`) + linked-tables tab on Planning; same
  openness/nettable/release semantics as the recalc engine; open demand =
  Σ(required−used); only OPEN-to-OPEN OrdDetailCommit edges count
  (closed-side commits are settled history). Allocation editing
  intentionally omitted (Packouts panel owns it).
- **Review discipline paid again**: 3 rounds this session (5+3+2 lenses →
  2 adversarial verifiers each, strict kill) confirmed 9 + 8 + 4 unique
  findings the tests missed — incl. a CRITICAL by-package AP overstatement,
  a lock-convention violation, and tax reads escaping the locked tx. If
  review agents die on usage limits, re-run with model:'opus'.
- Suites: 93 unit + 322 integration green.

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
