# syntax=docker/dockerfile:1.7
#
# Single production image: the Fastify API serves the compiled SPA and mounts
# itself under /api. Runs the in-process scheduler (dunning, QuickBooks sync,
# Stripe import, housekeeping) — safe with several replicas thanks to DB leases.
#
#   docker build -t autocollect-ai .
#   docker run --env-file .env.production -p 4000:4000 autocollect-ai
#   docker run --env-file .env.production autocollect-ai node apps/api/dist/scripts/migrate.js   # migrations

ARG NODE_VERSION=22

# ── deps: full install for building ────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund

# ── build: shared types, API (tsc) and SPA (vite) ──────────────────────────
FROM deps AS build
COPY . .
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
RUN npm run build

# ── prod-deps: runtime dependencies only ───────────────────────────────────
FROM deps AS prod-deps
RUN npm prune --omit=dev --workspaces --include-workspace-root

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    SERVE_WEB_DIR=/app/apps/web/dist
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
