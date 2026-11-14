# Integration test determinism — what's controlled, what isn't

For the user-experience reasons in 2026-05-13's smoke-test feedback ("everything programmatically controlled so we can make tests as quick as possible and create minimum viable conditions"), this file is the **explicit contract** for what the `bootSectorTestServer` harness guarantees and where the remaining sources of variance are.

## What IS programmatically controlled

| Surface | Mechanism | Notes |
|---|---|---|
| **Player ID** | Caller passes a UUID into `harness.connectAs(playerId, opts)`. The server's `assignPlayerId` validates the UUID and uses it as-is. | Tests typically pre-generate UUIDs at module top (`const PID_A = randomUUID()`) so each test step references the same ID. |
| **Ship instance ID** | `PlayerShipStore` is constructed with an injected `generateShipId` that returns `test-ship-1`, `test-ship-2`, ... sequentially. | Deterministic ordering — first spawn gets `-1`, second `-2`. |
| **Persistence** | `setPersistence(new CaptureSink())` — every `enqueueCritical/Volatile` is captured into an in-memory array, no SQLite, no DB worker. | `harness.sink.ops` is the captured op log; `harness.sink.reset()` clears it. |
| **Server event ring buffer** | `harness.events.clear()` is called on every boot. The 500-entry buffer at `src/server/debug/ServerEventLog.ts` is cleared so event-count assertions are scoped to the current test. | Without this clear, the buffer leaks across tests within a single file because we run `pool: threads + singleThread + isolate: false` for the Colyseus tinypool workaround. |
| **Server port** | Random in 2580–3580 range, per harness instance. | Different port per test ⇒ each test is its own server. Collision risk is ~0 for serial test runs. |
| **Drone count** | `bootSectorTestServer({ droneCount: 0 })` — tests default to no drones unless they explicitly need them. | Eliminates ambient physics noise. |
| **Sector key** | `bootSectorTestServer({ sectorKey: 'sol-prime' })` — galaxy room (autoDispose: false, lingering enabled) vs `undefined` for engineering rooms. | Pick deliberately based on the behaviour under test. |
| **Spawn position** | Pass `joinOpts: { spawnX, spawnY }` to `connectAs(PID, joinOpts)`. The server's `onJoin` honours these. | Without these, the server picks a random spawn from a scatter pattern. Use explicit coords for any test that depends on position. |
| **Idle gate** | Sectors are "idle from birth" — snapshot broadcasts are suppressed until motion is detected. Use `harness.sendThrust(client)` to wake the broadcast loop before waiting on a snapshot. | Documented in `harness.waitForSnapshot`'s doc comment. |
| **Time progression** | Use `harness.events.waitFor({ tag, where? })` instead of `advance(N)` whenever the test is waiting for a specific server-side event. Polls every 25 ms; resolves the moment the event fires. | Catches genuine event-not-firing regressions; doesn't wait longer than necessary. |

## What is NOT under our control (and is acceptable)

| Source of variance | Why it's tolerable |
|---|---|
| **Physics worker tick rate** (60 Hz via `setImmediate`) | OS-dependent (~1 ms granularity on Linux/Mac, slightly worse on Windows). Tests that depend on a specific physics step count are fragile by design; instead, gate on events the worker emits (e.g. `SLEEP_TRANSITION`, `CONTACT_BATCH`). |
| **WebSocket latency** (localhost) | Sub-millisecond in practice. `colyseus.js`'s state-sync may lag the server's `onJoin` by 1–2 frames; assertions that read `harness.getServerRoom().state` are synchronous on the server side and don't see this lag. |
| **`Date.now()` in event timestamps** | The event log uses `Date.now()` and doesn't accept a clock injection. Tests assert on tags + data shape, not on absolute timestamps. |

## How to write a fast, deterministic test

The recipe (canonical example: `selfCollision.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('thing under test', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0 });
  }, 15_000);
  afterEach(async () => harness.cleanup(), 10_000);

  it('exercises the minimum behavior', async () => {
    const PID = randomUUID();
    const client = await harness.connectAs(PID, { shipKind: 'fighter' });

    // Assert on the SERVER state directly — synchronous, no waits.
    const state = harness.getServerRoom()!.state;
    expect(state.ships.size).toBe(1);

    // Wait on events, not wall-clock. Resolves in ~50 ms when healthy.
    await harness.disconnectClient(client);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === PID });

    // Assert event counts, not just side-effects.
    expect(harness.events.count({ tag: 'collision_self_filtered' })).toBe(0);
  });
});
```

**Anti-patterns that re-introduce non-determinism:**
- `harness.advance(500)` "for safety" → use `events.waitFor` instead.
- `Math.random()` inside the test body → seed-controlled or inject.
- Assuming wall-clock order between two `connectAs` calls without a `waitFor` between them.
- Reading from `harness.sink.ops` without `harness.sink.reset()` at the start.
- Reading from `harness.events.all()` without remembering the buffer is cleared per harness boot.

## Sources of randomness still on the wishlist

- `pickRandomPort` (cosmetic — never causes a test failure).
- Server-side spawn-position randomization when `spawnX/spawnY` aren't supplied (test should supply them; if it doesn't, this is a code smell).
- Physics worker's `setImmediate`-based tick scheduling — fundamentally OS-bound, not test-bound.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Server testing patterns

- **Hand-rolled mocks for orchestrator-shaped logic**: `src/server/transit/TransitOrchestrator.test.ts` is the gold standard. `makeRoom()`, `makePlayerShipStore()`, `makeFakeClient()` factories let a test set up a Sector-room-shaped harness in ~50 lines of mock plumbing. Fast (~10 ms per case), no I/O, no IPC. Use this for any test that exercises decision logic over state — the messages-to-state-to-broadcasts pipeline doesn't need a real server.
- **Integration tests for end-to-end snapshot routing** (Phase A1, 2026-05-13): `tests/integration/sectorRoom/harness.ts` boots a real `Server` + `SectorRoom` + `WebSocketTransport` + `colyseus.js` client in the same node process. Run via `pnpm test:integration` (separate vitest config — `vitest.integration.config.ts`). Use this whenever a behaviour spans the snapshot wire format, the broadcast gates (idle suppression, backpressure), or the schema-diff serialisation. The Phase 6b "lingering hull invisible" bug class is the canonical reason: the bug was in the broadcast loop's iteration, not in the room's state-mutation code. A hand-rolled mock couldn't catch it. The integration test would have.
- **When introducing a new visible entity type** (lingering hull, scrap, future X), add an integration test in `tests/integration/sectorRoom/` that drives the full snapshot path. Don't rely on smoke tests — they are not repeatable and don't protect future PRs.

## History

- **Integration clients MUST send `client_ready` or ships never activate (2026-06-03).** The bare `colyseus.js` client in `harness.ts` does NOT run the browser's bootstrap, so without an explicit `client_ready` the join handshake never completes — `ship.isActive` stays `false` until the 30-s `CLIENT_READY_TIMEOUT_TICKS` watchdog. Tests that assert on active hulls (`abandonToScrap`, `lingering`) were silently RED for this reason. Use `harness.connectActive(playerId, opts)` (sends `client_ready`, polls until `isActive`) for any test that needs a live hull; plain `connectAs` only gives a pending/lingering-able hull. The `SectorRoom._internals` piercing getter (dropped by the v3 subsystem extraction, which had left `hitAckContract`/`droneTargetActiveOnly`/`ramming`/`lingering` erroring with `_internals` undefined) was **restored 2026-06-03** (exposes `serverTick`, `ownerlessShips`, `aiPlayerScratch`, `postToWorker`, `applyDamage`). The lingering/wreck/pool suite is now green. **Follow-up completed 2026-06-10:** the combat/AI/energy/warp files (`hitAckContract`, `droneTargetActiveOnly`, `ramming`, `shieldHull`, `missileLifecycle`, `slotFiringAndEnergy`, `livingWorldHooks`, `livingWorldDirector`, `warpBroadcasts`) were migrated to `connectActive` for their active-ship spawns — the whole `pnpm test:integration` suite is now green (34 files / 90 tests). The living-world harness (`bootLivingWorldTestServer`) gained its own `connectActive` (the director's `playerCount()` only counts `isActive` hulls, so a funnel/flap test needs a *live* occupant). Two assertions also had to track behaviour that the `client_ready` gap had been masking: (a) `warpBroadcasts` now expects `warp_in` on ALL occupants INCLUDING the joiner (the unified crispy-kazoo handshake broadcasts with `arrivalTick`, no `except: client`); (b) `slotFiringAndEnergy` reads the energy pool at its TROUGH (energy regenerates every tick with no post-spend delay, so a fixed wall-clock read lets regen mask the single-slot drain / refill an `initialEnergy: 0` pool past `BOOST_TICK_COST`). **CI now runs `pnpm test:integration` as its own required `integration-tests` job** (`.github/workflows/ci.yml`) — previously integration tests never ran in CI, so this whole class of rot was invisible. New integration tests are gated from here on.
