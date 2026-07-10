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

# Drift repair for db-push-era descendants: baselining marks the init
# migration applied WITHOUT running it, so anything folded into init before
# it froze (2026-07-02) but after the database's db-push snapshot never
# materializes (found live 2026-07-10: RecipeDetail.TotalVolume/UseFrom and
# the approval_request table were missing — the full import rejected all
# 177K RecipeDetail rows). schema.prisma is authoritative and these installs
# carry no manual schema customizations, so apply the computed delta.
# Migration-built databases never drift — this is a no-op for them.
echo "[migrate] Checking for schema drift..."
if pnpm --filter @erp1/db exec prisma migrate diff \
    --from-url "$DATABASE_URL" \
    --to-schema-datamodel prisma/schema.prisma \
    --exit-code --script > /tmp/drift.sql 2>/dev/null; then
  echo "[migrate] No drift."
else
  echo "[migrate] Schema drift detected (db-push-era baseline) — repairing with:"
  cat /tmp/drift.sql
  pnpm --filter @erp1/db exec prisma db execute --url "$DATABASE_URL" --file /tmp/drift.sql
  echo "[migrate] Drift repaired."
fi

echo "[migrate] Seeding baseline data (idempotent)..."
pnpm --filter @erp1/db seed

echo "[migrate] Complete."
