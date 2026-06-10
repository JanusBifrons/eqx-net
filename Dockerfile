# EQX Peri — production server image (plan squishy-canyon, E2).
#
# Runs the authoritative Colyseus server. NOTE: we run from SOURCE via tsx, not
# from a compiled dist — `bundleWorker` esbuild-bundles the physics + DB worker
# `.ts` entrypoints at RUNTIME (see src/server/workers/bundleWorker.ts), so the
# `.ts` source + esbuild + tsx must be present in the runtime image. The express
# server is API/WS-only (no static hosting — see docs/architecture/security.md),
# so the client bundle is hosted separately and is NOT in this image.
#
# node:sqlite is a Node built-in (>=22.5) — no native better-sqlite3 build step.

# ── deps stage: install the full dependency tree (tsx + esbuild are needed at
#    runtime, so this is NOT a --prod install). ──────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── runtime stage ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

ENV NODE_ENV=production \
    PORT=2567 \
    DB_PATH=/data/eqx.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.server.json tsconfig.core.json ./
COPY src ./src

# SQLite WAL volume — survives container restarts. Owned by the non-root user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 2567

# Health probe: /healthz returns ready:true once hydration + eager rooms are up.
# node:slim has no curl, so use Node's global fetch (Node 22).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||2567)+'/healthz').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))"

# SIGTERM triggers the graceful drain in src/server/index.ts (persistence flush
# + colyseus gracefullyShutdown). tsx forwards signals to the child.
STOPSIGNAL SIGTERM
CMD ["pnpm", "exec", "tsx", "--tsconfig", "tsconfig.server.json", "src/server/index.ts"]
