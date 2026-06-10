# EQX Peri — Deployment Runbook

The authoritative server (Colyseus + persistence) deployment story (plan
squishy-canyon, E2). The express layer is API/WS-only; the client bundle
(`pnpm build:client`) is hosted separately (static host / CDN) and points at
this server's WS + `/auth` + `/galaxy` + `/healthz`.

## Image

`Dockerfile` builds the server image. It runs from **source via `tsx`** (not a
compiled dist) because `bundleWorker` esbuild-bundles the physics + DB worker
`.ts` entrypoints at runtime — the `.ts` source, `esbuild`, and `tsx` must be in
the runtime image. node:sqlite is a Node 22 built-in, so there is no native
build step.

```
docker build -t eqx-peri-server .
docker run --rm -p 2567:2567 \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e ALLOWED_ORIGINS="https://play.example.com" \
  -v eqx-data:/data \
  eqx-peri-server
```

## Required / recommended environment

| Var | Required? | Notes |
|-----|-----------|-------|
| `JWT_SECRET` | **Yes (prod)** | Fail-closed (S9): the server throws at boot if missing or the literal placeholder. `openssl rand -hex 32`. |
| `ALLOWED_ORIGINS` | Recommended | Comma-separated CORS allowlist (S1). Production is **closed** to cross-origin browser reads without it. Set to your client host(s). |
| `DB_PATH` | Defaulted | `/data/eqx.db` in the image. Point at the mounted volume. |
| `PORT` | Defaulted | `2567`. |
| `NODE_ENV` | Set by image | `production` — gates test rooms off (S6), enables HSTS, arms the fail-closed JWT. |
| `EQX_ENABLE_TEST_ROOMS` | **Never in prod** | Re-registers the test/engineering rooms; controlled load tests only (S6). |
| `EQX_ALLOW_DEV_OVERRIDES` | **Never in prod** | E2E-only JoinOption bypass; the server warns at boot if set in prod. |
| `EQX_DISABLE_LIVING_WORLD` | Optional | `1` disables hunter-bot AI (peaceful build/playtest). |
| `SESSION_TTL_DAYS` | Optional | JWT session lifetime (default 30). |

## SQLite / persistence

- The DB lives at `DB_PATH` on a **persistent volume** (`/data`). It runs in WAL
  mode (`-wal`/`-shm` sidecar files) — back up all three together, or checkpoint
  first. Losing the volume loses accounts + roster + galaxy snapshots.
- Persistence health is exposed on `GET /healthz` under `persistence`
  (`criticalFailures`, `queueDepth`, `exited`, hydrate counters) — alert on
  `exited === true` or a climbing `criticalFailures` (R4).

## Health, readiness, draining

- `GET /healthz` → `{ status, ready, persistence, ... }`. `ready` flips true only
  after hydration + eager galaxy rooms are up. The container `HEALTHCHECK` gates
  on it; orchestrators should gate traffic on `ready:true`.
- **SIGTERM** triggers the graceful drain (`shutdown()` in `src/server/index.ts`):
  stop Limbo prune + Living World, flush persistence (8 s), `gameServer.
  gracefullyShutdown()`, then exit. Hard deadline 10 s. `STOPSIGNAL SIGTERM` is
  set; give the orchestrator ≥ 12 s stop grace.
- Uncaught exceptions / unhandled rejections are caught (R1, B1): logged `fatal`,
  drained, and exited non-zero so the supervisor restarts a clean instance.

## Logs

Production logs are pino JSON to stdout (no pretty transport when
`NODE_ENV=production`) — capture with the platform's stdout collector. Never log
position/velocity (Pino policy).

## Rollback

The image is stateless apart from `/data`. Roll back by redeploying the previous
image tag against the same volume. Schema changes that bump
`CURRENT_SCHEMA_VERSION` reseed galaxy sectors on boot (mismatched snapshots are
discarded) — account/roster tables are additive and safe across a rollback.

## Fly.io sketch (optional)

A `fly.toml` would set `[[services]]` internal port 2567, a `[checks]` http GET
`/healthz` expecting `ready:true`, `kill_signal = "SIGTERM"`, `kill_timeout =
12`, and a mounted volume at `/data`. Secrets (`JWT_SECRET`, `ALLOWED_ORIGINS`)
via `fly secrets set`.

## CI

`.github/workflows/ci.yml` runs a build-only `docker build` (no push) to catch
Dockerfile rot. A real boot smoke (`docker run … until /healthz ready:true`)
requires `JWT_SECRET` and a writable volume and is a deploy-pipeline step, not a
PR gate.
