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

### First-login credentials
On a fresh install the admin credentials are printed at the end and saved to:

```
/opt/erp1/secrets/admin-credentials.txt   (root-only)
```

You must change the password on first login.

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
| `ERP1_ADMIN_EMAIL` | `admin@erp1.local` | Bootstrap admin email (first install only) |

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
