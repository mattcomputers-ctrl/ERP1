# ERP1 API + worker + migrate image.
# Builds entirely inside the container, so the host only needs Docker.
FROM node:22-bookworm-slim

# Prisma query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Copy the whole monorepo (node_modules/dist excluded via .dockerignore).
COPY . .

# Install workspace deps, generate the Prisma client, compile the API.
# (devDeps are intentionally kept: the migrate step needs the Prisma CLI + tsx.)
RUN pnpm install --no-frozen-lockfile \
  && pnpm --filter @erp1/db generate \
  && pnpm --filter @erp1/api build

EXPOSE 3000

# Default command runs the API; compose overrides it for worker/migrate.
CMD ["node", "apps/api/dist/main.js"]
