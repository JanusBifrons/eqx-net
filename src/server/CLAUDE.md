# CLAUDE.md — src/server (The Authority)

`src/server` is the absolute source of truth. The client runs prediction to hide latency, but the server's state is reality. Every piece of game logic runs here first, then gets broadcast. Read the root [CLAUDE.md](../../CLAUDE.md) for project-wide invariants before editing.

---

## Forbidden Imports (CI-enforced)

Never import from `src/server/`:

- UI / rendering: `pixi.js`, `pixi-viewport`, `react`, `react-dom`, `@mui/*`, `@emotion/*`, `howler`, `zustand`
- The client-side Colyseus package: `colyseus.js` (the server uses `colyseus`, not `colyseus.js`)
- Anything under `src/client/**`

Allowed: `colyseus`, `@colyseus/schema`, `@colyseus/ws-transport`, `express`, `zod`, `better-sqlite3`, `pino` + `pino-pretty`, `src/core`, `src/shared-types`. Phase 9 may additionally allow `@colyseus/redis-driver` / `@colyseus/redis-presence` *iff* the multi-VM deployment shape is chosen.

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

- **Phase 4 — micro rate limit**: max 3 inputs per entity per tick in `onMessage`. Excess silently dropped.
- **Phase 4 — temporal plausibility**: hit claims older than 12 ticks (~200 ms) rejected.
- **Phase 4 — backpressure**: `ws.bufferedAmount > 50 KB` drops oldest queued snapshot; `> 250 KB` force-closes the socket.
- **Phase 4 — lag-comp buffer**: pre-allocated 1000 entities × 12 ticks × 16 bytes = 192 KB per sector. No per-tick allocation.
- **Phase 6 — TiDi**: simulation-clock rate ramps toward 0.7× when >14 ms/tick for 30 consecutive ticks. At floor, load-shedder despawns farthest-from-any-player AI.
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

## Threading

- Phase 2 evicts Rapier to a `worker_threads` worker; the main Colyseus thread reads SAB directly.
- Phase 7 moves `better-sqlite3` to its own worker; the main thread never touches the connection.
- If you are adding a new CPU-heavy subsystem, default to spawning a worker rather than running on the main thread.
