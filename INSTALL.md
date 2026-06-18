# Installing ERP1 on Ubuntu Server

ERP1 ships as a self-contained Docker stack with an unattended installer. The
**only prerequisite is a stock Ubuntu Server** with internet access — the
installer adds Docker and everything else automatically, with no prompts.

## Requirements
- Ubuntu Server 22.04 or 24.04 (other Debian-based distros likely work)
- `sudo`/root access
- Outbound internet (to pull Docker images and packages)
- A free TCP port (default **80**)

## Install (or upgrade) — one command

```bash
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash
```

Run the **same command again any time to upgrade** — the installer detects the
existing installation, pulls the latest code, rebuilds, and re-applies database
migrations. Your data and your `.env` (secrets) are preserved across upgrades.

### What it does
1. Installs Docker Engine + Compose plugin, `git`, and `openssl` (unattended).
2. Clones the repo to `/opt/erp1` (first run) or pulls the latest (upgrade).
3. On first run, generates strong secrets and a bootstrap **admin** password.
4. Builds the images and starts: PostgreSQL, Redis, the API, the worker, and the
   web server (Caddy). Applies DB migrations and seeds the admin user.
5. Prints the URL and, on first install, the admin credentials.

### Admin account & password
On a fresh install the admin email defaults to `mcartwright@precisioninkcorp.com`
(override with `ERP1_ADMIN_EMAIL`). The password is chosen as, first match wins:

1. **`ERP1_ADMIN_PASSWORD`** env var (min 12 chars) — for scripted/unattended installs;
2. otherwise an **interactive prompt** during install (hidden input, with confirmation;
   press Enter to auto-generate);
3. otherwise **auto-generated** (when no terminal is available).

A password you set is used as-is. An auto-generated password is printed at the end
and **must be changed at first login**. Either way the credentials are saved to:

```
/opt/erp1/secrets/admin-credentials.txt   (root-only)
```

## Configuration overrides
Pass environment variables before the pipe:

```bash
# Listen on port 8080 instead of 80
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo ERP1_HTTP_PORT=8080 bash
```

| Variable | Default | Purpose |
|---|---|---|
| `ERP1_DIR` | `/opt/erp1` | Install directory |
| `ERP1_BRANCH` | `main` | Git branch to deploy |
| `ERP1_HTTP_PORT` | `80` | Host port for the web UI |
| `ERP1_ADMIN_EMAIL` | `mcartwright@precisioninkcorp.com` | Bootstrap admin email (first install only) |
| `ERP1_ADMIN_PASSWORD` | _(prompt/generate)_ | Set the admin password non-interactively (min 12 chars) |
| `ERP1_NONINTERACTIVE` | _(unset)_ | Set to skip the password prompt and auto-generate |
| `ERP1_LEGACY_MSSQL_HOST` | _(empty)_ | Legacy CMS SQL Server host/IP — enables the read-only import |
| `ERP1_LEGACY_MSSQL_PASSWORD` | _(empty)_ | Password for the read-only legacy login |
| `ERP1_LEGACY_MSSQL_USER` / `_DB` / `_PORT` | `sds_readonly` / `CMS` / `1433` | Legacy connection (defaults shown) |

The legacy credentials are written only to the server's git-ignored `/opt/erp1/.env` — never committed. Example — configure the import at install time:

```bash
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh \
  | sudo ERP1_LEGACY_MSSQL_HOST=<your-sql-server-ip> ERP1_LEGACY_MSSQL_PASSWORD='your-readonly-password' bash
```

Example — set the admin password without a prompt:

```bash
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo ERP1_ADMIN_PASSWORD='choose-a-strong-one' bash
```

After first install, edit `/opt/erp1/.env` and re-run the installer (or
`docker compose up -d`) to apply changes.

## Day-to-day management
All commands run from `/opt/erp1`:

```bash
cd /opt/erp1
docker compose ps                 # status
docker compose logs -f            # tail logs (all services)
docker compose logs -f api        # tail one service
docker compose restart            # restart everything
docker compose down               # stop (data preserved in volumes)
docker compose up -d              # start
```

### Backups
The database lives in the `erp1_pgdata` Docker volume. A simple logical backup:

```bash
cd /opt/erp1
docker compose exec -T db pg_dump -U erp1 erp1 | gzip > erp1-$(date +%F).sql.gz
```

Restore (into a running, empty DB):

```bash
gunzip -c erp1-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U erp1 -d erp1
```

> A scheduled backup job + tested restore runbook is part of a later increment.

## Uninstall
```bash
cd /opt/erp1 && docker compose down -v   # -v also removes data volumes
sudo rm -rf /opt/erp1
```

## Troubleshooting
- **Health check didn't pass:** `docker compose logs -f` — the first build can
  take several minutes; the API waits for migrations to finish.
- **Port already in use:** re-run with `ERP1_HTTP_PORT=<free port>`.
- **Reset everything (DESTRUCTIVE):** `docker compose down -v` then re-run the
  installer for a clean database + new admin credentials.
