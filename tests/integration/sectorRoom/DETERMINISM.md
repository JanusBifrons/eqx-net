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
