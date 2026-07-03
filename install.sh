#!/usr/bin/env bash
#
# ERP1 unattended installer / upgrader — NATIVE deployment for Ubuntu Server
# 24.04 (no Docker). Installs PostgreSQL 16 (PGDG), Redis, Node 22
# (NodeSource), and Caddy; builds the app under /opt/erp1; applies versioned
# Prisma migrations; installs systemd units (erp1-api, erp1-worker); and
# serves the web app + /api reverse proxy through Caddy.
#
#   Fresh install or upgrade (auto-detected):
#     curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash
#
#   Optional overrides (env vars after sudo so they survive into the script):
#     curl -fsSL <url> | sudo ERP1_DOMAIN=erp.example.com bash        # HTTPS via Caddy
#     curl -fsSL <url> | sudo ERP1_HTTP_PORT=8080 bash                # plain HTTP port
#     curl -fsSL <url> | sudo ERP1_ADMIN_PASSWORD='your-strong-pw' bash
#     curl -fsSL <url> | sudo ERP1_ADMIN_EMAIL=you@company.com bash
#     curl -fsSL <url> | sudo ERP1_LEGACY_MSSQL_PASSWORD='...' bash   # legacy import
#
# On a fresh install the admin password is chosen as follows (first match wins):
#   1. ERP1_ADMIN_PASSWORD env var (>=12 chars), or
#   2. an interactive hidden prompt (Enter = auto-generate), or
#   3. auto-generated (fully unattended, no terminal).
# A password you set is used as-is; an auto-generated one must be changed at
# first login. Credentials and connection strings live in /etc/erp1.env
# (root-only) and are printed once at the end of a fresh install.
#
# Upgrade mode (an existing /opt/erp1/.git): git pull -> build ->
# prisma migrate deploy -> restart services. /etc/erp1.env is preserved.
#
set -euo pipefail

ERP1_REPO="${ERP1_REPO:-https://github.com/mattcomputers-ctrl/ERP1.git}"
ERP1_DIR="${ERP1_DIR:-/opt/erp1}"
ERP1_BRANCH="${ERP1_BRANCH:-main}"
ERP1_HTTP_PORT="${ERP1_HTTP_PORT:-80}"
ERP1_DOMAIN="${ERP1_DOMAIN:-}"
ERP1_API_PORT="${ERP1_API_PORT:-3000}"
ERP1_ENV_FILE="/etc/erp1.env"
ERP1_USER="erp1"
NODE_MAJOR=22

log()  { printf '\033[1;36m[erp1]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[erp1] WARNING:\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[erp1] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (use: curl -fsSL <url> | sudo bash)"
command -v apt-get >/dev/null 2>&1 || die "This installer targets Ubuntu/Debian (apt-get not found)."

export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
log "Installing base packages..."
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl gnupg lsb-release build-essential >/dev/null

UBUNTU_CODENAME="$(lsb_release -cs)"

log "Installing PostgreSQL 16 (PGDG repository)..."
if ! command -v psql >/dev/null 2>&1 || ! psql --version | grep -q ' 16\.'; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${UBUNTU_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-16 >/dev/null
fi
systemctl enable --now postgresql >/dev/null 2>&1 || true

log "Installing Redis..."
apt-get install -y -qq redis-server >/dev/null
systemctl enable --now redis-server >/dev/null 2>&1 || true

log "Installing Node ${NODE_MAJOR} (NodeSource)..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v\([0-9]*\).*/\1/')" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null

log "Installing Caddy..."
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# ---------------------------------------------------------------------------
# 2. App user + source tree (install vs upgrade auto-detected)
# ---------------------------------------------------------------------------
if ! id -u "${ERP1_USER}" >/dev/null 2>&1; then
  log "Creating system user '${ERP1_USER}'..."
  useradd --system --create-home --home-dir "${ERP1_DIR}" --shell /usr/sbin/nologin "${ERP1_USER}"
fi

# Run a command as the app user with the right HOME (runuser keeps the passed
# environment, unlike sudo's env_reset — needed to hand secrets to pnpm/seed).
run_as_erp1() {
  runuser -u "${ERP1_USER}" -- env HOME="${ERP1_DIR}" "$@"
}

UPGRADE=0
if [ -d "${ERP1_DIR}/.git" ]; then
  UPGRADE=1
  log "Existing installation detected — UPGRADE mode."
  run_as_erp1 git -C "${ERP1_DIR}" fetch origin
  run_as_erp1 git -C "${ERP1_DIR}" checkout "${ERP1_BRANCH}"
  run_as_erp1 git -C "${ERP1_DIR}" reset --hard "origin/${ERP1_BRANCH}"
else
  log "Fetching ${ERP1_REPO} (${ERP1_BRANCH}) into ${ERP1_DIR}..."
  # The home dir already exists (skel files) — init+fetch instead of clone,
  # which refuses a non-empty target.
  install -d -o "${ERP1_USER}" -g "${ERP1_USER}" "${ERP1_DIR}"
  run_as_erp1 git -C "${ERP1_DIR}" init -q
  run_as_erp1 git -C "${ERP1_DIR}" remote add origin "${ERP1_REPO}" 2>/dev/null || \
    run_as_erp1 git -C "${ERP1_DIR}" remote set-url origin "${ERP1_REPO}"
  run_as_erp1 git -C "${ERP1_DIR}" fetch origin "${ERP1_BRANCH}"
  run_as_erp1 git -C "${ERP1_DIR}" checkout -B "${ERP1_BRANCH}" "origin/${ERP1_BRANCH}"
fi

# Activate the repo-pinned pnpm (corepack shim, available to all users).
PNPM_VERSION="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "${ERP1_DIR}/package.json")"
log "Activating pnpm ${PNPM_VERSION:-latest} via corepack..."
corepack prepare "pnpm@${PNPM_VERSION:-latest}" --activate >/dev/null

# ---------------------------------------------------------------------------
# 3. Database role + database, /etc/erp1.env
# ---------------------------------------------------------------------------
rand() { openssl rand -base64 48 | tr -d '/+=' | head -c "${1:-32}"; }

env_get() { [ -f "${ERP1_ENV_FILE}" ] && sed -n "s/^$1=//p" "${ERP1_ENV_FILE}" | head -1 || true; }

ADMIN_PASSWORD=""
ADMIN_GENERATED=0
if [ "${UPGRADE}" -eq 0 ] || [ ! -f "${ERP1_ENV_FILE}" ]; then
  log "Provisioning PostgreSQL role + database..."
  DB_PASSWORD="$(rand 32)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp1') THEN
    CREATE ROLE erp1 LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE erp1 LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='erp1'" | grep -q 1 \
    || sudo -u postgres createdb -O erp1 erp1

  # Admin credentials (fresh install only).
  ADMIN_EMAIL="${ERP1_ADMIN_EMAIL:-admin@erp1.local}"
  if [ -n "${ERP1_ADMIN_PASSWORD:-}" ]; then
    [ "${#ERP1_ADMIN_PASSWORD}" -ge 12 ] || die "ERP1_ADMIN_PASSWORD must be at least 12 characters."
    ADMIN_PASSWORD="${ERP1_ADMIN_PASSWORD}"
  elif [ -t 0 ]; then
    printf '\033[1;36m[erp1]\033[0m Admin password for %s (Enter = auto-generate): ' "${ADMIN_EMAIL}"
    read -rs ADMIN_PASSWORD_INPUT || ADMIN_PASSWORD_INPUT=""
    echo
    if [ -n "${ADMIN_PASSWORD_INPUT}" ]; then
      [ "${#ADMIN_PASSWORD_INPUT}" -ge 12 ] || die "The admin password must be at least 12 characters."
      ADMIN_PASSWORD="${ADMIN_PASSWORD_INPUT}"
    else
      ADMIN_PASSWORD="$(rand 20)"; ADMIN_GENERATED=1
    fi
  else
    ADMIN_PASSWORD="$(rand 20)"; ADMIN_GENERATED=1
  fi

  PUBLIC_URL_VALUE=""
  if [ -n "${ERP1_DOMAIN}" ]; then PUBLIC_URL_VALUE="https://${ERP1_DOMAIN}"; fi

  log "Writing ${ERP1_ENV_FILE} (root-only)..."
  umask 077
  cat > "${ERP1_ENV_FILE}" <<ENV
# ERP1 runtime configuration — read by systemd (erp1-api, erp1-worker) and the
# installer. Root-only; contains secrets. Regenerated ONLY on fresh install.
NODE_ENV=production
API_PORT=${ERP1_API_PORT}
DATABASE_URL=postgresql://erp1:${DB_PASSWORD}@127.0.0.1:5432/erp1?schema=public
REDIS_URL=redis://127.0.0.1:6379
SESSION_SECRET=$(rand 48)
PUBLIC_URL=${PUBLIC_URL_VALUE}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_INITIAL_PASSWORD=${ADMIN_PASSWORD}
ADMIN_MUST_CHANGE_PASSWORD=$([ "${ADMIN_GENERATED}" -eq 1 ] && echo true || echo false)
# Legacy Mar-Kov CMS (read-only) — used by the import engine. Set the password
# to enable imports.
LEGACY_MSSQL_HOST=${ERP1_LEGACY_MSSQL_HOST:-10.10.10.11}
LEGACY_MSSQL_PORT=1433
LEGACY_MSSQL_DB=CMS
LEGACY_MSSQL_USER=sds_readonly
LEGACY_MSSQL_PASSWORD=${ERP1_LEGACY_MSSQL_PASSWORD:-}
ENV
  umask 022
else
  log "Upgrade: keeping existing ${ERP1_ENV_FILE}."
fi

# ---------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------
log "Installing dependencies (pnpm install --frozen-lockfile)..."
run_as_erp1 sh -c "cd '${ERP1_DIR}' && pnpm install --frozen-lockfile" >/dev/null

log "Generating Prisma client + building api/web..."
run_as_erp1 sh -c "cd '${ERP1_DIR}' && pnpm --filter @erp1/db generate && pnpm build" >/dev/null

# ---------------------------------------------------------------------------
# 5. Migrations + seed
# ---------------------------------------------------------------------------
# Secrets are handed over via the environment (runuser preserves it), never
# interpolated into shell strings.
export DATABASE_URL="$(env_get DATABASE_URL)"
export ADMIN_EMAIL="$(env_get ADMIN_EMAIL)"
export ADMIN_INITIAL_PASSWORD="$(env_get ADMIN_INITIAL_PASSWORD)"
export ADMIN_MUST_CHANGE_PASSWORD="$(env_get ADMIN_MUST_CHANGE_PASSWORD)"

log "Applying database migrations..."
set +e
MIGRATE_OUT="$(run_as_erp1 sh -c "cd '${ERP1_DIR}' && pnpm --filter @erp1/db migrate:deploy" 2>&1)"
MIGRATE_RC=$?
set -e
if [ ${MIGRATE_RC} -ne 0 ]; then
  if printf '%s' "${MIGRATE_OUT}" | grep -q "P3005"; then
    # Pre-migrations (db-push'd) database: baseline it, then deploy the rest.
    log "Existing schema without migration history — baselining 000000000000_init..."
    run_as_erp1 sh -c "cd '${ERP1_DIR}' && pnpm --filter @erp1/db exec prisma migrate resolve --applied 000000000000_init" >/dev/null
    run_as_erp1 sh -c "cd '${ERP1_DIR}' && pnpm --filter @erp1/db migrate:deploy" >/dev/null
  else
    printf '%s\n' "${MIGRATE_OUT}" >&2
    die "prisma migrate deploy failed."
  fi
fi

log "Seeding baseline data (idempotent)..."
run_as_erp1 sh -c "cd '${ERP1_DIR}' && pnpm --filter @erp1/db seed" >/dev/null

# ---------------------------------------------------------------------------
# 6. systemd units
# ---------------------------------------------------------------------------
log "Installing systemd units (erp1-api, erp1-worker)..."
cat > /etc/systemd/system/erp1-api.service <<UNIT
[Unit]
Description=ERP1 API (NestJS)
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=${ERP1_USER}
WorkingDirectory=${ERP1_DIR}/apps/api
EnvironmentFile=${ERP1_ENV_FILE}
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/erp1-worker.service <<UNIT
[Unit]
Description=ERP1 background worker (BullMQ)
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=${ERP1_USER}
WorkingDirectory=${ERP1_DIR}/apps/api
EnvironmentFile=${ERP1_ENV_FILE}
ExecStart=/usr/bin/node dist/worker.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable erp1-api erp1-worker >/dev/null 2>&1

# ---------------------------------------------------------------------------
# 7. Caddy (web dist + /api reverse proxy)
# ---------------------------------------------------------------------------
log "Configuring Caddy..."
SITE_ADDRESS=":${ERP1_HTTP_PORT}"
if [ -n "${ERP1_DOMAIN}" ]; then SITE_ADDRESS="${ERP1_DOMAIN}"; fi

cat > /etc/caddy/Caddyfile <<CADDY
# ERP1 — static web app + API reverse proxy. Managed by install.sh.
${SITE_ADDRESS} {
	encode gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:${ERP1_API_PORT}
	}

	handle {
		root * ${ERP1_DIR}/apps/web/dist
		try_files {path} /index.html
		file_server
	}
}
CADDY

# The web dist (and the path to it) must be readable by the caddy user.
chmod o+rx "${ERP1_DIR}"
chmod -R o+rX "${ERP1_DIR}/apps/web/dist"

systemctl enable caddy >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 8. Start + verify
# ---------------------------------------------------------------------------
log "Starting services..."
systemctl restart erp1-api erp1-worker
systemctl restart caddy

log "Waiting for the API to come up..."
API_OK=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${ERP1_API_PORT}/api/health" >/dev/null 2>&1; then API_OK=1; break; fi
  sleep 2
done
[ "${API_OK}" -eq 1 ] || warn "API health check did not pass yet — check: journalctl -u erp1-api -n 50"

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
URL="http://${HOST_IP:-localhost}$([ "${ERP1_HTTP_PORT}" != "80" ] && echo ":${ERP1_HTTP_PORT}")"
if [ -n "${ERP1_DOMAIN}" ]; then URL="https://${ERP1_DOMAIN}"; fi

echo
log "=============================================================="
if [ "${UPGRADE}" -eq 1 ]; then
  log "ERP1 upgrade complete."
else
  log "ERP1 installation complete."
  log "  URL:            ${URL}"
  log "  Admin login:    $(env_get ADMIN_EMAIL)"
  if [ "${ADMIN_GENERATED}" -eq 1 ]; then
    log "  Admin password: ${ADMIN_PASSWORD}   (auto-generated — must be changed at first login)"
  elif [ -n "${ADMIN_PASSWORD}" ]; then
    log "  Admin password: (the one you provided)"
  fi
  log "  Secrets/config: ${ERP1_ENV_FILE} (root-only)"
fi
log "  Services:       systemctl status erp1-api erp1-worker caddy"
log "  Logs:           journalctl -u erp1-api -f"
log "=============================================================="
