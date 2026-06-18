# ---- Build the React SPA ----
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile && pnpm --filter @erp1/web build

# ---- Serve static assets + reverse-proxy /api via Caddy ----
FROM caddy:2
COPY --from=build /app/apps/web/dist /srv
COPY ops/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
