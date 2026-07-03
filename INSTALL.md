# Installing ERP1 on Ubuntu Server

ERP1 installs **natively** (no Docker) with a single unattended command. The
only prerequisite is a stock **Ubuntu Server 24.04** with internet access —
the installer adds PostgreSQL 16, Redis, Node 22, Caddy, and everything else
automatically, with no prompts.

## Requirements
- Ubuntu Server 24.04 (22.04 also works)
- `sudo`/root access
- Outbound internet (apt repositories + GitHub)
- A free TCP port (default **80**)

## Install (or upgrade) — one command

```bash
curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash
```

Run the **same command again any time to upgrade** — the installer detects the
existing installation, pulls the latest code, rebuilds, applies database
migrations, and restarts the services. Your data and `/etc/erp1.env` (secrets)
are preserved across upgrades.

### What it does
1. Installs PostgreSQL 16 (PGDG), Redis, Node 22 (NodeSource), Caddy, git,
   build tooling (unattended).
2. Clones the repo to `/opt/erp1` under a dedicated `erp1` system user
   (first run) or pulls the latest (upgrade).
3. On first run, provisions the database and generates strong secrets and a
   bootstrap **admin** password into root-only `/etc/erp1.env`.
4. Builds the API + web app, applies versioned Prisma migrations, seeds
   baseline data, installs systemd services (`erp1-api`, `erp1-worker`), and
   configures Caddy to serve the web app with `/api` proxied to the API.
5. Prints the URL and, on first install, the admin credentials.

### Admin account & password
On a fresh install the admin email defaults to `admin@erp1.local` (override
with `ERP1_ADMIN_EMAIL`). The password is chosen as, first match wins:

1. **`ERP1_ADMIN_PASSWORD`** env var (min 12 chars) — for scripted installs;
2. otherwise an **interactive prompt** during install (hidden input; press
   Enter to auto-generate);
3. otherwise **auto-generated** (when no terminal is available).

A password you set is used as-is. An auto-generated password is printed at the
end of the install, stored in `/etc/erp1.env` (root-only), and **must be
changed at first login**.

### Options (env vars after `sudo`)

```bash
curl -fsSL <url> | sudo ERP1_DOMAIN=erp.example.com bash     # automatic HTTPS
curl -fsSL <url> | sudo ERP1_HTTP_PORT=8080 bash             # non-80 HTTP port
curl -fsSL <url> | sudo ERP1_ADMIN_EMAIL=you@company.com ERP1_ADMIN_PASSWORD='...' bash
curl -fsSL <url> | sudo ERP1_LEGACY_MSSQL_PASSWORD='...' bash  # enable legacy import
```

### After installing

- Open `http://<server-ip>/` and log in with the admin credentials.
- To import data from the legacy Mar-Kov CMS, set `LEGACY_MSSQL_PASSWORD` in
  `/etc/erp1.env`, run `systemctl restart erp1-api`, then use
  **Administration → Legacy Import** in the web app.
- Service management, logs, backups: see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Local development

Developers use Docker Compose (`docker-compose.yml`) for a one-command dev
stack; production never touches Docker. See the repo README.
