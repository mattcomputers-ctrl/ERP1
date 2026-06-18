# ERP1 — Internal Manufacturing/ERP System

A new, web-based MES/ERP that will replace the legacy **Mar-Kov CMS** (chemical & pharmaceutical batch manufacturing). Built and owned in-house so we control our own destiny, and built to be **fast, robust, reliable, secure, beautiful, and easy to use.**

Runs on **Ubuntu Server** as a self-contained **Docker** stack (PostgreSQL + Redis + NestJS API + React/Vite web + background worker), with a one-command unattended installer that also handles upgrades.

> **Status: Foundation increment built** — auth, sessions, hash-chained audit trail, the security/role model, and the installable Ubuntu/Docker platform. Domain modules (inventory, manufacturing, LIMS, shipping, …) follow per [FEATURE_PARITY.md](FEATURE_PARITY.md).

## Quick start (Ubuntu Server)

```bash
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash
```

Re-run the same command any time to **upgrade** (it auto-detects an existing install). On first install it prints the bootstrap admin credentials and saves them to `/opt/erp1/secrets/admin-credentials.txt`. Full details: [INSTALL.md](INSTALL.md).

## Start here (review documents)
1. **[docs/SCHEMA_REPORT.md](docs/SCHEMA_REPORT.md)** — Phase 0 discovery of the live legacy database: the 6 core patterns, genealogy & security models, proposed new schema, and the import/sync design.
2. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — proposed technology stack and key technical decisions (with trade-offs and a short list of decisions needed from you).
3. **[FEATURE_PARITY.md](FEATURE_PARITY.md)** — living tracker mapping every legacy feature to its build status.

## Key facts established in Phase 0
- Legacy DB: SQL Server 2016, database `CMS`, **342 tables**, ~34M rows, live (used daily).
- Our access to it is **read-only and structurally enforced** (`sds_readonly`, no write permission). The legacy DB is a data *source*, never a runtime dependency, and is never written to.
- The schema rests on a few strong patterns: a universal **party** (`Entity`), a universal **order** (`Ordr`/`OrdDetail`), a **transaction-envelope + command-log audit** model, and a **sublot-genealogy** graph — which makes faithful schema parity realistic.
- A mature 21 CFR Part 11 **security / electronic-signature** model already exists and maps closely onto the brief's requirements.

## Reference material
`reference/` holds the vendor docs (2018 User Guide + release notes 7.16–7.22). The User Guide's table of contents is extracted to [`docs/discovery/user-guide-toc.txt`](docs/discovery/user-guide-toc.txt). Authority order when sources conflict: **live DB → release notes → User Guide → brief summary**.

## Repo layout
```
apps/
  api/           NestJS backend (REST + OpenAPI); also hosts the worker entrypoint
  web/           React + Vite frontend (served in prod by Caddy)
packages/
  db/            Prisma schema, generated client, migrations, seed
ops/             Caddyfile (static serving + /api reverse proxy)
scripts/         migrate.sh and other ops helpers
docs/            design & discovery documents (SCHEMA_REPORT, ARCHITECTURE)
reference/       vendor PDFs (read-only reference)
docker-compose.yml   the full stack
install.sh           unattended Ubuntu installer / upgrader
```

## Local development
Requires Node 22 + pnpm (or just use Docker). With Docker: `cp .env.example .env` then `docker compose up --build`. The app is then on `http://localhost`.
