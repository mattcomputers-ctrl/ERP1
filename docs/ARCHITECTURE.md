# Architecture Proposal

**Project:** Internal replacement for the legacy Mar-Kov CMS
**Status:** Approved (2026-06-17) and now being implemented. Pairs with the [Schema & Data Report](SCHEMA_REPORT.md).
**Optimised for the brief's six adjectives** — fast, robust, reliable, secure, beautiful, easy to use — plus SQL Server interoperability, long-term hireability, and strong automated-testing support.

> ### Confirmed decisions (2026-06-17)
> These supersede the recommendations below where they differ:
> - **Runtime OS: Ubuntu Server**, deployed as a self-contained Docker stack.
> - **Independent database: PostgreSQL 16** (not SQL Server). Best fit on Ubuntu — license-free, trivially installable unattended, first-class recursive CTEs for genealogy/recall. Structural schema parity with the legacy SQL Server is preserved (same table/column names + types). The legacy import source remains SQL Server, read-only.
> - **Installer:** one-command `curl | sudo bash` that installs all prerequisites unattended, detects an existing install and upgrades it, and bootstraps an admin. See [INSTALL.md](../INSTALL.md).
> - **No legacy user migration.** Users are recreated; the installer seeds a bootstrap admin and prints the credentials.
> - **Delivery:** GitHub `mattcomputers-ctrl/ERP1`; deploy/upgrade by re-running the installer (`git pull` + rebuild).

---

## 1. TL;DR recommendation

A single **TypeScript** codebase, **boring and mainstream** end-to-end so a small internal team can own it for a decade:

| Layer | Recommendation | One-line why |
|---|---|---|
| Language | **TypeScript** (front + back) | One language, huge hiring pool, end-to-end type safety |
| Backend | **NestJS** (Node 22 LTS) | Structured/modular for a 342-table domain; guards & interceptors map perfectly onto the secured-item authz + audit model |
| API | **REST + OpenAPI** (auto-generated), typed client | Documented contract for the future SDS-tool integration (brief §7) |
| ORM / data | **Prisma** for CRUD + migrations; **parameterized raw SQL** for genealogy/recall & set-viewer grids | Type-safe, no string-built SQL (brief non-negotiable); raw SQL where CTEs are needed |
| Independent DB | **SQL Server 2022** | Maximal schema parity & zero dialect friction with the legacy source and the other Claude-built tools |
| Frontend | **React + Vite** | The default, most-hireable UI stack |
| UI system | **shadcn/ui + Tailwind** (Radix primitives) | Beautiful, accessible, *and fully owned* (components live in our repo) |
| Grids | **TanStack Table + TanStack Virtual** | The ~60 "set viewers" are a first-class platform capability: fast, filterable, virtualized, exportable |
| State/data | **TanStack Query** + React Hook Form + **Zod** | Standard, testable; Zod schemas shared client/server |
| Jobs/scheduling | **BullMQ + Redis** | Durable queues for import/sync, overnight reconciliation, notifications, expiry, MRP |
| Auth | Argon2id + **TOTP MFA** + **OIDC SSO (Entra ID)**; server-side sessions | Secure, revocable, "active sessions" visible (brief §5) |
| Hosting | **Docker** (Compose to start), on-prem VM or Azure | Portable; trivial for a small team; scales to Container Apps/k8s later |
| Testing | **Vitest** (unit) · **Testcontainers** (integration) · **Playwright** (E2E) | Covers business logic, authz, audit, and critical flows |
| Repo | **pnpm workspaces + Turborepo** | `api` / `web` / `worker` / shared `types` & `db` packages |

The whole stack is deliberately conventional. Every piece is something we can hire for and that will still be well-supported in ten years. Nothing exotic.

---

## 2. Why these choices (the consequential ones)

### 2.1 Independent database: SQL Server (recommended)
The brief lets me choose, and weighs **schema parity** and **SQL Server interoperability** heavily. Keeping the independent DB on **SQL Server**:
- Makes the import a near-straight copy (same types, same T-SQL, same collation behaviour) — see Schema Report §9.
- Keeps the *other Claude-built tools* and the *SDS tool* — which already speak SQL Server — compatible with our compatibility views.
- Reuses the team's existing SQL Server operational knowledge (backups, Agent jobs, monitoring).
- Is "boring in a good way."

**Trade-off / alternative — PostgreSQL:** technically excellent and license-free. But against a 342-table SQL-Server-shaped schema and an existing SQL-Server tool ecosystem, it adds dialect/type translation and would fork the other tools. **Recommendation: SQL Server now**, with the data layer kept portable (Prisma + isolated raw-SQL modules) so a future move to Postgres is feasible if licensing ever dominates. *Decision needed — see §11.*

### 2.2 Backend: NestJS
A regulated ERP this size lives or dies by **consistent, server-side authorization and audit**. NestJS gives us:
- **Guards** to enforce the secured-item permission check on *every* route (brief's "server-side authorization on every request" non-negotiable) — one mechanism, impossible to forget.
- **Interceptors** to capture the audit trail and bind it to the transaction — every mutation audited by construction, not by discipline.
- **Modules** to mirror the legacy module map (Inventory, Manufacturing, LIMS, Shipping, Security, …) so the codebase is navigable.
- First-class **OpenAPI** generation and **DI** for testability.

*Trade-off:* more ceremony than a bare Fastify app, but the structure is exactly what pays off across a large, long-lived, regulated domain.

### 2.3 Authorization that reproduces the legacy model, cleanly
We reimplement Users → Roles → Secured Items → Response Levels → Approvals (Schema Report §7) as a central **PolicyService**:
- Input: `(user, securedItemKey, context, recordSecurityGroup)`.
- Output: `allow | deny`, and if allowed-but-gated, the **required response level** (`reason` / `signature` / `signature+witness` / `witness`).
- Enforced in a guard before the handler runs; **row-level `SecurityGroup` scoping** enforced in the data layer so users only see permitted rows.
- **Supervisor override / approve-on-behalf (brief §5):** a dedicated elevation flow — when a user is blocked, the UI opens an in-place dialog; a privileged user authenticates *there* (credentials + e-signature/witness if the secured item demands it), the server verifies they hold the item, writes the full override to the e-signature ledger, and executes the original action in one transaction. The blocked user never logs out. Also supports the asynchronous `Approval`/`Workflow` chain path.

### 2.4 Audit & electronic signatures that are tamper-evident
We keep the legacy `Log` + field-level `LogResult` + `LogSecuredItem` concepts (Schema Report §3.5/§7.3) and harden them:
- A Prisma **extension/interceptor** captures before/after for every create/update/delete and writes the audit + field diffs **in the same DB transaction** as the change — no gaps.
- Audit and e-signature rows are **append-only** (enforced by DB permissions: the app's runtime DB principal has no UPDATE/DELETE on audit tables) and **hash-chained** (each row stores `hash(prev_hash ‖ canonical(row))`) so any tampering is detectable. A periodic verifier job re-walks the chain.
- **Electronic signature = re-authentication** (password and/or MFA) at the point of action, cryptographically bound to the specific record + signing meaning + timestamp (21 CFR Part 11 §11.50/§11.70). Witness = a second, distinct authenticated principal.

### 2.5 Grids/set viewers as a platform primitive
The legacy system has ~60 "set viewers" (Schema Report §4; User Guide §23) and they're heavily used. Rather than build 60 screens, we build **one** great data-grid platform component (TanStack Table + Virtual): server-side pagination/sort/filter, column chooser, saved views, CSV/Excel export, and a "Lock Set Viewer"-style optimistic-lock affordance. Each set viewer becomes config + a query, not a bespoke page. This is where "fast" and "easy to use" are won.

### 2.6 Jobs & scheduling
Durable, observable background processing for: import/sync, overnight QuickBooks reconciliation, automatic sublot expiry, MRP/plan-trace recalculation, and notifications. **BullMQ + Redis** is the standard durable choice (retries, scheduling, dead-letter, a dashboard). *Trade-off:* Redis is one extra service. If you'd rather avoid it, a SQL-Server-backed job table + worker is a viable lower-infra fallback; I recommend BullMQ for reliability. *Decision flagged in §11.*

### 2.7 Hosting
Containerized (Docker). Start with **Docker Compose** on a VM you control (`api`, `web`, `worker`, `redis`, reverse proxy for TLS), pointing at a SQL Server instance (existing or containerized). This is trivial for a small team and fully portable to **Azure Container Apps** or k8s when HA/scale is wanted. The independent DB gets standard SQL Server **full+diff+log backups with a documented, tested restore runbook** (brief §8 reliability). *On-prem vs Azure decision in §11.*

---

## 3. System shape

```
                       ┌─────────────────────────── Browser / Android handheld (PWA) ───────────────────────────┐
                       │  React + Vite + shadcn/ui   ·   TanStack Query/Table/Virtual   ·   barcode-first flows   │
                       └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                                          HTTPS (REST + OpenAPI)
                                                                    │
                       ┌────────────────────────────────────────────▼───────────────────────────────────────────┐
                       │  NestJS API   ·   Guards (PolicyService → secured items) · Audit interceptor · Zod DTOs   │
                       │  Domain modules: master-data · inventory · manufacturing · lims · shipping · planning ·   │
                       │                  resources · accounting · security/admin · viewers                        │
                       └───────────┬───────────────────────────────┬───────────────────────────────┬─────────────┘
                                   │ Prisma + raw SQL              │ enqueue                        │ session
                       ┌───────────▼───────────┐       ┌───────────▼──────────┐         ┌───────────▼───────────┐
                       │  SQL Server 2022      │       │  BullMQ workers       │         │  Redis (sessions +     │
                       │  (independent DB:     │       │  import/sync,         │         │   job queue)           │
                       │  legacy-parity schema │       │  reconciliation,      │         └────────────────────────┘
                       │  + lookups/constraints│       │  expiry, MRP, notify  │
                       │  + hardened audit)    │       └───────────┬──────────┘
                       └───────────────────────┘                   │ READ-ONLY (sds_readonly)
                                                        ┌──────────▼───────────┐
                                                        │  Legacy CMS SQL Server │  ← never written to
                                                        └────────────────────────┘
```

Monorepo packages: `web` (React), `api` (NestJS), `worker` (BullMQ processors), `db` (Prisma schema + migrations + compatibility views), `shared` (Zod schemas, types, permission keys), `importer` (legacy sync engine).

---

## 4. How the quality bar (brief §8) is met concretely

- **Fast** — server-side paginated/virtualized grids; indexed queries; Redis caching for hot lookups; heavy work (recall, MRP, reconciliation) pushed to workers; sub-second target for common screens.
- **Robust** — Zod validation at the edge; DB CHECK/FK constraints; **transactions around every multi-step operation**; reversals modeled as reversing `ChangeSet`s (never destructive); optimistic concurrency via the existing `Version` columns; record locking for "Lock Set Viewer" semantics.
- **Reliable** — Vitest + Testcontainers + Playwright; health/readiness probes; SQL Server backups with a *tested* restore; idempotent, resumable import with reconciliation reports.
- **Secure** — see §2.3/§2.4; OWASP ASVS baseline; least-privilege runtime DB principal (no DELETE on audit); secrets in a vault / env (never in source); dependency scanning (Dependabot + `npm audit` in CI); TLS everywhere.
- **Beautiful** — one coherent shadcn/Tailwind design system; calm, uncluttered, consistent; dark/light; not a 2018 enterprise app.
- **Easy to use** — keyboard-first data entry, barcode-first warehouse flows, sensible defaults & prototypes (the legacy "Prototypes" concept), inline help, minimal clicks for receiving/dispensing/execution/testing/shipping.

---

## 5. Accessibility & handheld

- WCAG-minded: keyboard navigation, focus management, labels, contrast — Radix primitives give us accessible behavior by default; `axe` checks in CI.
- Warehouse handheld ops (adjust, consume, move, container info, dispose/reverse, verify location, remeasure, packaging reservation, change area) ship as a **responsive PWA** (installable on Android), large touch targets, and **keyboard-wedge barcode** support (the legacy scanners are wedge-style — User Guide §24.5), with camera scanning as an option.

---

## 6. Integrations (designed-for, per brief §7)

- **Legacy SQL Server** — read-only import source only; the importer uses the `sds_readonly` principal; a test asserts the importer connection cannot write.
- **SDS authoring tool** — clean, stable item/material identifiers (`ItemCode`) and a documented REST API now, so the future link is easy. We don't build it yet.
- **QuickBooks** — export interface + overnight reconciliation, mirroring the legacy behavior (User Guide §18).
- **Barcode/label printing & scales** — label rendering + printer integration; scale capture for batch execution where feasible (the model already has `WorkstationScale`/`Resource`-as-scale).

---

## 7. Testing strategy (brief non-negotiable: "everything tested")

| Level | Tool | Focus |
|---|---|---|
| Unit | Vitest | Business logic, costing math, **PolicyService** permission decisions, hash-chain |
| Integration | Testcontainers (SQL Server + Redis) | Authz on every endpoint, **audit completeness** (every mutation audited), e-signature enforcement, inventory/genealogy state transitions, **import idempotency & reconciliation** |
| E2E | Playwright | Receiving, dispensing, full + express batch execution, testing/disposition, shipping, **recall report**, supervisor override |
| Safety | CI assertion | The importer's DB connection is read-only (cannot write to legacy) |
| Quality gates | CI | lint, typecheck, unit+integration+E2E, build, dependency scan, a11y (axe) |

---

## 8. Build sequence (after approval)

Per brief §4, full parity delivered in reviewable, always-runnable increments. Each ships with tests, docs, and an updated [FEATURE_PARITY.md](../FEATURE_PARITY.md).

0. **Scaffold** — monorepo, Docker Compose, CI, `db` package with the parity schema + migrations + compatibility views, seed/demo data, `.env.example`, README.
1. **Foundation** — auth (Argon2id+MFA+OIDC, sessions), Users/Roles/Groups/Secured-Items/Response-Levels admin, the audit trail + e-signature ledger (hash-chained), the reusable grid/set-viewer platform, and the **import/sync engine** with reconciliation. *(brief §4.1)*
2. **Master data & inventory** — Entities, Items (+satellites), warehouses/bins/zones/units, Lot/Sublot/Location/Inventory, receiving, adjustments, moves, counts, **genealogy/trace + recall**.
3. **Manufacturing & packaging** — recipes & libraries, batch order processing & execution (full + express), order edits, packaging orders.
4. **QA/LIMS, resources & maintenance.**
5. **Sales, shipping, supply/demand, MRP, capacity planning.**
6. **Accounting, QuickBooks export, notifications, multi-language, configuration, the full viewer/set-viewer library.**

---

## 9. Environments & ops

- **Local:** `docker compose up` → app + SQL Server + Redis + seed data; `pnpm dev` for hot reload. `.env.example` documents every setting.
- **CI:** GitHub Actions (or equivalent) — typecheck, lint, test (with Testcontainers), build images.
- **Staging/Prod:** Docker images; migrations run as a gated deploy step; backups + restore runbook; structured logging + metrics (OpenTelemetry) and error tracking.

---

## 10. What I am *not* proposing (deliberately)

- No microservices — a modular monolith is right for this team size and domain coupling.
- No GraphQL — REST+OpenAPI is simpler to document, cache, and integrate.
- No bespoke UI framework — shadcn/Tailwind is owned, modern, and accessible without lock-in.
- No exotic DB — SQL Server keeps parity and reuses existing skills.

---

## 11. Decisions I need from you

1. **Approve this stack?** (Or tell me what to change.)
2. **Independent DB engine** — SQL Server (recommended) or PostgreSQL?
3. **Hosting target** — on-prem/VM (recommended to start) or Azure?
4. **Background jobs** — BullMQ + Redis (recommended) or a SQL-Server-backed job table (no Redis)?
5. **Password migration** (from Schema Report §10) — force-reset all users at cutover (safest) or verify-once-then-rehash the legacy SHA-1?

Plus the open data questions in [Schema Report §10](SCHEMA_REPORT.md#10-risks-ambiguities--open-questions) (cutover model, audit-history retention depth, multi-site scope). None block scaffolding once 1–4 are answered; I can proceed with the recommended defaults if you'd prefer.
