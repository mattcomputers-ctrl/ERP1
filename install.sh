#!/usr/bin/env bash
#
# ERP1 unattended installer / upgrader for Ubuntu Server.
#
#   Fresh install or upgrade (auto-detected):
#     curl -fsSL https://raw.githubusercontent.com/mattcomputers-ctrl/ERP1/main/install.sh | sudo bash
#
#   Optional overrides (env vars after sudo so they survive into the script):
#     curl -fsSL <url> | sudo ERP1_HTTP_PORT=8080 bash
#     curl -fsSL <url> | sudo ERP1_ADMIN_PASSWORD='your-strong-pw' bash   # non-interactive
#     curl -fsSL <url> | sudo ERP1_ADMIN_EMAIL=you@company.com bash
#
# On a fresh install the admin password is chosen as follows (first match wins):
#   1. ERP1_ADMIN_PASSWORD env var (>=12 chars), or
#   2. an interactive hidden prompt (Enter = auto-generate), or
#   3. auto-generated (fully unattended, no terminal).
# A password you set is used as-is; an auto-generated one must be changed at
# first login.
#
# Prerequisites (Docker Engine + Compose plugin, git, openssl) are installed
# automatically with no prompts.
#
set -euo pipefail

ERP1_REPO="${ERP1_REPO:-https://github.com/mattcomputers-ctrl/ERP1.git}"
ERP1_DIR="${ERP1_DIR:-/opt/erp1}"
ERP1_BRANCH="${ERP1_BRANCH:-main}"
ERP1_HTTP_PORT="${ERP1_HTTP_PORT:-80}"

log()  { printf '\033[1;36m[erp1]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[erp1] WARNING:\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[erp1] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root (use: curl -fsSL <url> | sudo bash)"

# ---------------------------------------------------------------------------
# 1. Prerequisites (unattended)
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive

install_base_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing base packages (git, curl, openssl, ca-certificates)..."
    apt-get update -qq
    apt-get install -y -qq git curl ca-certificates openssl >/dev/null
  else
    warn "apt-get not found; assuming a non-Debian system. Ensure git, curl, openssl are installed."
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker and the Compose plugin are already installed."
  else
    log "Installing Docker Engine + Compose plugin (via get.docker.com)..."
    curl -fsSL https://get.docker.com | sh
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || warn "Could not enable docker via systemd; continuing."
  fi
  docker info >/dev/null 2>&1 || die "Docker daemon is not available. Check 'systemctl status docker'."
}

install_base_packages
install_docker

# ---------------------------------------------------------------------------
# 2. Fetch or update the source (detect existing install -> UPGRADE mode)
# ---------------------------------------------------------------------------
MODE="install"
if [ -d "${ERP1_DIR}/.git" ]; then
  MODE="upgrade"
  log "Existing installation detected at ${ERP1_DIR} -> UPGRADE mode."
  git -C "${ERP1_DIR}" fetch --depth 1 origin "${ERP1_BRANCH}"
  git -C "${ERP1_DIR}" reset --hard "origin/${ERP1_BRANCH}"
else
  log "Fresh installation -> cloning into ${ERP1_DIR}..."
  mkdir -p "$(dirname "${ERP1_DIR}")"
  git clone --depth 1 --branch "${ERP1_BRANCH}" "${ERP1_REPO}" "${ERP1_DIR}"
fi

cd "${ERP1_DIR}"

# ---------------------------------------------------------------------------
# 3. Environment & secrets
# ---------------------------------------------------------------------------
ENV_FILE="${ERP1_DIR}/.env"
SECRETS_DIR="${ERP1_DIR}/secrets"
ADMIN_CREDS_FILE="${SECRETS_DIR}/admin-credentials.txt"
FRESH_ENV=0
ADMIN_GENERATED=0

rand_hex() { openssl rand -hex "${1:-24}"; }

if [ ! -f "${ENV_FILE}" ]; then
  FRESH_ENV=1
  log "Generating .env with strong random secrets..."
  mkdir -p "${SECRETS_DIR}"; chmod 700 "${SECRETS_DIR}"

  POSTGRES_PASSWORD="$(rand_hex 24)"
  SESSION_SECRET="$(rand_hex 32)"
  ADMIN_EMAIL="${ERP1_ADMIN_EMAIL:-mcartwright@precisioninkcorp.com}"

  # --- Admin password: env var > interactive prompt > auto-generated ---------
  ADMIN_MUST_CHANGE=false
  if [ -n "${ERP1_ADMIN_PASSWORD:-}" ]; then
    ADMIN_INITIAL_PASSWORD="${ERP1_ADMIN_PASSWORD}"
    [ ${#ADMIN_INITIAL_PASSWORD} -ge 12 ] || die "ERP1_ADMIN_PASSWORD must be at least 12 characters."
    log "Using admin password from ERP1_ADMIN_PASSWORD."
  elif [ -e /dev/tty ] && [ -z "${ERP1_NONINTERACTIVE:-}" ]; then
    while :; do
      printf 'Set a password for the admin account (%s)\n  minimum 12 characters, or press Enter to auto-generate: ' "${ADMIN_EMAIL}" > /dev/tty
      IFS= read -rs ERP1_PW1 < /dev/tty; printf '\n' > /dev/tty
      if [ -z "${ERP1_PW1}" ]; then
        ADMIN_INITIAL_PASSWORD="$(rand_hex 16)"; ADMIN_GENERATED=1; ADMIN_MUST_CHANGE=true; break
      fi
      if [ ${#ERP1_PW1} -lt 12 ]; then
        printf '  Too short (minimum 12 characters). Try again.\n' > /dev/tty; continue
      fi
      printf '  Confirm password: ' > /dev/tty
      IFS= read -rs ERP1_PW2 < /dev/tty; printf '\n' > /dev/tty
      if [ "${ERP1_PW1}" != "${ERP1_PW2}" ]; then
        printf '  Passwords do not match. Try again.\n' > /dev/tty; continue
      fi
      ADMIN_INITIAL_PASSWORD="${ERP1_PW1}"; break
    done
    unset ERP1_PW1 ERP1_PW2 2>/dev/null || true
  else
    ADMIN_INITIAL_PASSWORD="$(rand_hex 16)"; ADMIN_GENERATED=1; ADMIN_MUST_CHANGE=true
  fi

  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "${SERVER_IP}" ] || SERVER_IP="localhost"
  if [ "${ERP1_HTTP_PORT}" = "80" ]; then
    PUBLIC_URL="http://${SERVER_IP}"
  else
    PUBLIC_URL="http://${SERVER_IP}:${ERP1_HTTP_PORT}"
  fi

  cat > "${ENV_FILE}" <<EOF
# Generated by install.sh on first install. Keep this file secret.
NODE_ENV=production
HTTP_PORT=${ERP1_HTTP_PORT}
PUBLIC_URL=${PUBLIC_URL}

POSTGRES_USER=erp1
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=erp1
DATABASE_URL=postgresql://erp1:${POSTGRES_PASSWORD}@db:5432/erp1?schema=public

REDIS_URL=redis://redis:6379

API_PORT=3000
SESSION_SECRET=${SESSION_SECRET}
SESSION_TTL_HOURS=12

ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_INITIAL_PASSWORD=${ADMIN_INITIAL_PASSWORD}
ADMIN_MUST_CHANGE_PASSWORD=${ADMIN_MUST_CHANGE}
APP_VERSION=$(git -C "${ERP1_DIR}" rev-parse --short HEAD 2>/dev/null || echo 0.1.0)
EOF
  chmod 600 "${ENV_FILE}"

  if [ "${ADMIN_GENERATED}" -eq 1 ]; then
    cat > "${ADMIN_CREDS_FILE}" <<EOF
ERP1 bootstrap administrator (generated $(date -u +%Y-%m-%dT%H:%M:%SZ))
URL:      ${PUBLIC_URL}
Email:    ${ADMIN_EMAIL}
Password: ${ADMIN_INITIAL_PASSWORD}

This password was auto-generated. You must change it on first login.
EOF
  else
    cat > "${ADMIN_CREDS_FILE}" <<EOF
ERP1 bootstrap administrator (generated $(date -u +%Y-%m-%dT%H:%M:%SZ))
URL:      ${PUBLIC_URL}
Email:    ${ADMIN_EMAIL}
Password: (the one you set during installation)
EOF
  fi
  chmod 600 "${ADMIN_CREDS_FILE}"
else
  log "Preserving existing .env (upgrade)."
  NEW_VER="$(git -C "${ERP1_DIR}" rev-parse --short HEAD 2>/dev/null || echo 0.1.0)"
  if grep -q '^APP_VERSION=' "${ENV_FILE}"; then
    sed -i "s/^APP_VERSION=.*/APP_VERSION=${NEW_VER}/" "${ENV_FILE}"
  else
    echo "APP_VERSION=${NEW_VER}" >> "${ENV_FILE}"
  fi
fi

# Load HTTP_PORT/PUBLIC_URL from the (possibly pre-existing) .env for messaging.
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a

# ---------------------------------------------------------------------------
# 4. Build & start
# ---------------------------------------------------------------------------
log "Building images and starting the stack (this can take several minutes on first run)..."
docker compose pull --ignore-buildable 2>/dev/null || true
docker compose up -d --build

# ---------------------------------------------------------------------------
# 5. Wait for health & report
# ---------------------------------------------------------------------------
log "Waiting for the application to become healthy..."
HEALTH_URL="http://localhost:${HTTP_PORT:-80}/api/health"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done

echo
if [ "${ok}" -eq 1 ]; then
  log "ERP1 is up. (${MODE} complete)"
else
  warn "Health check did not pass yet. The stack may still be starting."
  warn "Check status:  docker compose -f ${ERP1_DIR}/docker-compose.yml ps"
  warn "View logs:     docker compose -f ${ERP1_DIR}/docker-compose.yml logs -f"
fi

echo
echo "  URL:         ${PUBLIC_URL:-http://<server-ip>:${HTTP_PORT:-80}}"
echo "  Install dir: ${ERP1_DIR}"
if [ "${FRESH_ENV}" -eq 1 ]; then
  echo
  echo "  -- Bootstrap administrator (first install) -------------------------"
  echo "     Email:    ${ADMIN_EMAIL}"
  if [ "${ADMIN_GENERATED}" -eq 1 ]; then
    echo "     Password: ${ADMIN_INITIAL_PASSWORD}   (auto-generated)"
    echo "     Saved to ${ADMIN_CREDS_FILE} (root-only). Change it on first login."
  else
    echo "     Password: (the one you set during installation)"
  fi
  echo "  --------------------------------------------------------------------"
fi
echo
log "Done."
