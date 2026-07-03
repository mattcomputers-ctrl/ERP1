#!/bin/sh
# Applies the database schema and seeds baseline data. Idempotent and safe to
# re-run (used on every install/upgrade). Runs inside the API image.
set -e
cd /app

# Versioned Prisma migrations are the deployment mechanism. Databases created
# before the baseline migration existed were db-push'd and have the full
# schema but no _prisma_migrations table — those are BASELINED first (the
# init migration is marked as already applied) so `migrate deploy` only runs
# migrations newer than the schema they already hold.
BASELINE="000000000000_init"

echo "[migrate] Applying database schema..."
if pnpm --filter @erp1/db migrate:deploy 2>/tmp/migrate-deploy.err; then
  echo "[migrate] Migrations deployed."
else
  if grep -q "P3005" /tmp/migrate-deploy.err; then
    # Pre-migrations (db-push'd) database: baseline it, then deploy the rest.
    echo "[migrate] Existing schema without migration history detected — baselining ${BASELINE}."
    pnpm --filter @erp1/db exec prisma migrate resolve --applied "${BASELINE}"
    pnpm --filter @erp1/db migrate:deploy
  else
    cat /tmp/migrate-deploy.err >&2
    exit 1
  fi
fi

echo "[migrate] Seeding baseline data (idempotent)..."
pnpm --filter @erp1/db seed

echo "[migrate] Complete."
