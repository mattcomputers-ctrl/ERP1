#!/bin/sh
# Applies the database schema and seeds baseline data. Idempotent and safe to
# re-run (used on every install/upgrade). Runs inside the API image.
set -e
cd /app

echo "[migrate] Applying database schema..."
if [ -d packages/db/prisma/migrations ] && [ -n "$(ls -A packages/db/prisma/migrations 2>/dev/null)" ]; then
  pnpm --filter @erp1/db migrate:deploy
else
  echo "[migrate] No versioned migrations present; using 'prisma db push' (fresh database)."
  pnpm --filter @erp1/db db:push
fi

echo "[migrate] Seeding baseline data (idempotent)..."
pnpm --filter @erp1/db seed

echo "[migrate] Complete."
