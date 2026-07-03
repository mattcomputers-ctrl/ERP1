# ERP1 deployment (native Ubuntu, no Docker)

ERP1 deploys **natively** onto Ubuntu Server 24.04 (a Proxmox VM in
production). One script installs or upgrades everything:

```sh
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash
```

Overrides (env vars after `sudo`): `ERP1_DOMAIN` (enables HTTPS via Caddy),
`ERP1_HTTP_PORT` (default 80), `ERP1_ADMIN_EMAIL`, `ERP1_ADMIN_PASSWORD`
(≥12 chars; otherwise prompted, or auto-generated when unattended),
`ERP1_LEGACY_MSSQL_PASSWORD` (enables the legacy import),
`ERP1_LEGACY_MSSQL_HOST`, `ERP1_REPO`, `ERP1_BRANCH`, `ERP1_API_PORT`.

## What the installer sets up

| Piece | Detail |
|---|---|
| PostgreSQL 16 | PGDG apt repo; role `erp1` + database `erp1` (localhost only) |
| Redis | distro `redis-server` (localhost only; sessions + BullMQ) |
| Node 22 | NodeSource; `corepack` activates the repo-pinned pnpm |
| App | cloned to `/opt/erp1`, owned by the system user `erp1` (nologin) |
| Config | `/etc/erp1.env`, root-only (0600) — all secrets live here |
| Schema | `prisma migrate deploy` (versioned migrations; a pre-migrations db-push database is auto-baselined via the P3005 → `migrate resolve --applied 000000000000_init` path) + idempotent seed |
| Services | systemd `erp1-api` + `erp1-worker` |
| Web | Caddy serves `/opt/erp1/apps/web/dist` (SPA fallback) and reverse-proxies `/api/*` to the API |

**Upgrade** = re-run the same command. An existing `/opt/erp1/.git` switches
the script to upgrade mode: `git reset --hard origin/main` → build →
`migrate deploy` → restart. `/etc/erp1.env` is never regenerated.

## /etc/erp1.env

```ini
NODE_ENV=production
API_PORT=3000
DATABASE_URL=postgresql://erp1:<generated>@127.0.0.1:5432/erp1?schema=public
REDIS_URL=redis://127.0.0.1:6379
SESSION_SECRET=<generated>
PUBLIC_URL=            # https://<domain> when ERP1_DOMAIN is set (secure cookies)
ADMIN_EMAIL=admin@erp1.local
ADMIN_INITIAL_PASSWORD=<generated or provided>   # consumed by the seed on first install
ADMIN_MUST_CHANGE_PASSWORD=true
LEGACY_MSSQL_HOST=10.10.10.11
LEGACY_MSSQL_PORT=1433
LEGACY_MSSQL_DB=CMS
LEGACY_MSSQL_USER=sds_readonly
LEGACY_MSSQL_PASSWORD=          # set to enable the legacy import
```

## systemd units (exact files the installer writes)

`/etc/systemd/system/erp1-api.service`:

```ini
[Unit]
Description=ERP1 API (NestJS)
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=erp1
WorkingDirectory=/opt/erp1/apps/api
EnvironmentFile=/etc/erp1.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/erp1-worker.service` — identical except
`Description=ERP1 background worker (BullMQ)` and
`ExecStart=/usr/bin/node dist/worker.js`.

## Caddyfile (`/etc/caddy/Caddyfile`)

```caddy
:80 {                       # or the ERP1_DOMAIN for automatic HTTPS
	encode gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:3000
	}

	handle {
		root * /opt/erp1/apps/web/dist
		try_files {path} /index.html
		file_server
	}
}
```

The API serves everything under the `/api` global prefix (Swagger at
`/api/docs`, health at `/api/health`), so the proxy passes paths through
unmodified.

## Operations

```sh
systemctl status erp1-api erp1-worker caddy   # service state
journalctl -u erp1-api -f                     # live API logs
sudo -u postgres pg_dump erp1 > backup.sql    # database backup
```

- **Restart after config change**: edit `/etc/erp1.env`, then
  `systemctl restart erp1-api erp1-worker`.
- **Legacy import**: set `LEGACY_MSSQL_PASSWORD` in `/etc/erp1.env`, restart,
  then run imports from the web UI (Administration → Legacy Import).
- **Recovering the admin password**: `grep ADMIN /etc/erp1.env` (only valid
  until first login if it was auto-generated and changed).

## Local development

Docker Compose remains the *development* convenience
(`docker-compose.yml`: Postgres + Redis + API + web + one-shot migrate) and
CI mirror (`docker-compose.itest.yml`). Production installs never use Docker.
