# CLAUDE.md — src/server (The Authority)

`src/server` is the absolute source of truth. The client runs prediction to hide latency, but the server's state is reality. Every piece of game logic runs here first, then gets broadcast. Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing.

---

## Forbidden Imports (CI-enforced)

Never import from `src/server/`:

- UI / rendering: `pixi.js`, `pixi-viewport`, `react`, `react-dom`, `@mui/*`, `@emotion/*`, `howler`, `zustand`
- The client-side Colyseus package: `colyseus.js` (the server uses `colyseus`, not `colyseus.js`)
- Anything under `src/client/**`

Allowed: `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `node:sqlite` (built-in, replaces `better-sqlite3` — see `docs/LESSONS.md` for why), `bcryptjs`, `jose`, `dotenv`, `pino` + `pino-pretty`, `src/core`, `src/shared-types`. Phase 9 may additionally allow `@colyseus/redis-driver` / `@colyseus/redis-presence` *iff* the multi-VM deployment shape is chosen.

---

## Authority Model

- Clients send **inputs**. The server decides **outcomes**. Never the other way around.
- Any state that matters is computed server-side. Client-side prediction (Phase 3) and ghost projectiles (Phase 4) are presentation tricks; they must never influence the authoritative state.
- The Colyseus `SectorRoom` owns one sector's physics world, AI, combat resolution, and broadcast path. Everything else (persistence, orchestration, galaxy registry) is a supporting service the room uses.

---

## Validation Contract (zod at the boundary)

- **Every** inbound message has a zod schema in `src/shared-types/`.
- Parse every message in `onMessage`. On failure: drop silently, increment a per-connection error counter, sampled `pino.warn`. Never throw to the game loop.
- Keep schemas strict (`.strict()`), no unknown keys.

---

## Thresholds (fill in as phases land)

Phase 0: placeholder. These tighten as each phase ships:

- **Phase 3 — snapshot broadcast rate**: 20 Hz (every 3 main-thread `update()` calls, via `broadcastCounter` field). Do NOT use SAB tick divisibility — two independent 60 Hz loops (physics worker + Colyseus) are never in phase and cause ~25% missed broadcasts. See `docs/LESSONS.md` for details.
- **Phase 4 — micro rate limit**: max 3 inputs per entity per tick in `onMessage`. Excess silently dropped.
- **Phase 4 — temporal plausibility**: hit claims older than 12 ticks (~200 ms) rejected.
- **Phase 4 — backpressure**: `ws.bufferedAmount > 50 KB` drops oldest queued snapshot; `> 250 KB` force-closes the socket.
- **Phase 4 — lag-comp buffer**: pre-allocated 1000 entities × 12 ticks × 16 bytes = 192 KB per sector. No per-tick allocation.
- **Phase 5d — interest grid**: `SpatialGrid` (2048-unit cells). Each client receives entities in its 3×3 cell window at full fidelity; out-of-interest entities are still shipped every 6 ticks (decimation cadence). Cell move per entity per tick is cheap because most entities don't cross a 2048 u boundary in a single 16.67 ms step.
- **Phase 5d — wire format**: encoder is per-client, called from `SectorRoom.update()` inside the existing per-client backpressure loop. `BinarySwarmBroadcast.encode(registry, sab, sab, tick, inInterest?)` — when `inInterest` is undefined the encoder behaves like Phase 5c (broadcast-all), so unit tests that pre-date 5d still pass unmodified.
- **Phase 6 — TiDi**: `SimulationClock` reports `totalMs` once per `update()`. Constants in `src/core/clock/SimulationClock.ts`: `OVER_BUDGET_MS = 14`, `WINDOW_TICKS = 30`, `RAMP_PER_TICK = 0.005` (1 s ramp from 1.0 → 0.7), hard `FLOOR = 0.7`. The room mirrors `clock.rate` to `state.clockRate` (Colyseus schema diff broadcasts to clients) and posts a `CLOCK_RATE` worker command only when the rate moves at least 1e-4 — keeps the worker queue clean. Single-writer rule: only the worker writes `CLOCK_RATE_IDX` in the SAB header; the server's only path to mutate it is the `CLOCK_RATE` postMessage. At floor, the `LoadShedder` (sub-phase C) despawns farthest-from-any-player drones in batches (10 % of drone count, capped at 8 per tick) until the budget recovers.
- **Auth (pre-Phase 5)**: `node:sqlite` introduced early for auth/stats. Currently runs on main thread (low-frequency queries). Phase 7 threading plan still applies: move DB worker to `worker_threads`.
- **Phase 7 — SQLite**: WAL mode. Two priority queues (`CRITICAL` with coalescing write-ahead buffer, `VOLATILE` purgeable). Graceful shutdown flushes `CRITICAL`.
- **Phase 8 — Limbo**: 5-minute TTL, keyed by `playerId` (NOT `sessionId` — sessionIds are ephemeral). 15-second Colyseus seat reservation TTL on destination rooms.

Update this section when a threshold is set.

---

## Pino Sampling Policy

- Dev: `pino-pretty` transport.
- Prod: JSON to stdout (Fly.io captures).
- High-frequency events (`LASER_FIRED`, `ENTITY_WOKE` storms, reconciliation drifts): sample at **1 %**.
- Discrete lifecycle events (join/leave, transit state changes, sector spin-up/-down): **full fidelity**.
- Never log position/velocity data.

---

## Combat Architecture (Phase 4)

- **SnapshotRing** (`src/server/lagcomp/SnapshotRing.ts`): pre-allocated Float32Array ring buffer (1000 × 12 × 16 bytes = 192 KB). `record(tick, entities)` called every `update()`; `getAt(entityId, tick)` returns rewound position for lag-comp. No per-tick allocation.
- **Lag-comp hit resolution**: uses the pure-geometry `rayHitsSphere()` from `src/core/combat/Weapons.ts` against SnapshotRing positions — NOT Rapier's `castRay`. The server main thread does not have a live Rapier world (physics lives in the worker).
- **Projectile simulation**: Euler integration in `advanceProjectiles()` on the main thread, not in the physics worker. Lifetime limit: 180 ticks (3 s). Circle-circle collision detection per-tick against each live ship.
- **Backpressure** (`src/server/net/Backpressure.ts`): `checkBackpressure(client, logger)` returns `'ok' | 'drop' | 'close'`. Called in the per-client broadcast loop in `update()`.
- **Weapon cooldown enforcement**: `lastFireTick` map, compared against `WEAPON_COOLDOWN_TICKS = 10` (167 ms at 60 Hz). Excess fire requests return `hit: false` immediately.
- **Temporal plausibility**: fire claims with `tick < serverTick - 12` are rejected before any lag-comp lookup.

---

## Threading

- Phase 2 evicts Rapier to a `worker_threads` worker; the main Colyseus thread reads SAB directly.
- Phase 7 moves `better-sqlite3` to its own worker; the main thread never touches the connection.
- If you are adding a new CPU-heavy subsystem, default to spawning a worker rather than running on the main thread.
