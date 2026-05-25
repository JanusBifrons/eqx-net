# GC Discipline — Hot-Path Allocation Paradigm

## Why this matters

EQX Peri runs a 60 Hz physics tick, a 60 Hz render frame, a 20 Hz
broadcast cadence per client, and a continuous inbound input stream.
Every per-tick allocation compounds: at 60 Hz, allocating ONE small
object per tick mints ~3,600 objects per minute per ship — enough to
fire a V8 minor-GC every few seconds. Minor-GC is not free — even a
2 ms scavenge stalls the snapshot wire by a wire-format-period, and
the inter-arrival jitter is what the player feels as "stuttering".

The 2026-05-04 measurement (LESSONS.md) captured this directly:
`snapshotJitterMs = 29.3 ms`, scatter of ±30 ms around the nominal
50 ms broadcast — "due to V8 minor-GC bursts and Colyseus's
`setSimulationInterval` granularity, even when the server has 90 %
budget headroom." V8's minor-GC granularity is inherent; what we
control is **how often we hand the GC something to clean up**.

The root `CLAUDE.md` budget is **GC pauses < 2 ms** (Performance
Budgets table). Every per-tick / per-frame allocation we eliminate
raises the time-between-minor-GCs and reduces the *frequency* of
the bursts. This document is the playbook.

## The shapes of allocation

Drawn from the 2026-05-25 static audit. Each pattern is listed with
its measured cost in the EQX Peri codebase and the canonical fix.

### 1. Object literals in hot paths

```ts
// HOT — allocates one object per tick per ship.
states[ship.shipInstanceId] = {
  x: ship.pose.x, y: ship.pose.y, vx: ship.pose.vx, vy: ship.pose.vy,
  angle: ship.pose.angle, angvel: ship.pose.angvel ?? 0,
  playerId: ship.playerId, isActive: ship.isActive,
};
```

**Cost at scale:** 10 ships × 20 Hz × 3 clients = 600 objects/sec.

**Fix:** `ObjectPool`. Acquire on populate, release at the start of
the next tick.

```ts
const entry = scratch.stateEntryPool.acquire();
entry.x = ship.pose.x;
entry.y = ship.pose.y;
// ... write every field; reset() in the pool clears stale values
states[ship.shipInstanceId] = entry;
```

### 2. Array literals populated in a loop

```ts
// HOT — one array per tick.
const boostingIds: string[] = [];
for (const id of this.boostingPlayers) if (aliveIds.has(id)) boostingIds.push(id);
```

**Fix:** persistent scratch on the room / instance, `clearArray(...)`
at start.

```ts
clearArray(this.scratch.boostingIds);
for (const id of this.boostingPlayers) if (aliveIds.has(id)) this.scratch.boostingIds.push(id);
```

### 3. `new Map()` / `new Set()` per call

```ts
// HOT — `updateLiveBeam` runs every render frame.
const mountIds = new Set<string>();
for (const m of mounts) mountIds.add(m.id);
```

**Fix:** persistent field, `.clear()` at start.

```ts
this._beamMountIdsScratch.clear();
for (const m of mounts) this._beamMountIdsScratch.add(m.id);
```

### 4. Object spread inside per-frame rebuild

```ts
// HOT — runs 60 Hz per ship in updateMirror().
this.mirror.ships.set(localId, {
  x: state.x + ox, y: state.y + oy,
  vx: state.vx, vy: state.vy,
  angle: state.angle + oa,
  ...(prev?.kind ? { kind: prev.kind } : {}),
  ...(prev?.displayName !== undefined ? { displayName: prev.displayName } : {}),
  ...(prev?.mountAngles ? { mountAngles: prev.mountAngles } : {}),
});
```

**Fix:** mutate the existing entry in place. Field preservation is
automatic — only write the fields you want to update.

```ts
const prev = this.mirror.ships.get(localId);
if (!prev) {
  this.mirror.ships.set(localId, { x: state.x + ox, y: state.y + oy, vx: state.vx, vy: state.vy, angle: state.angle + oa });
} else {
  prev.x = state.x + ox;
  prev.y = state.y + oy;
  prev.vx = state.vx;
  prev.vy = state.vy;
  prev.angle = state.angle + oa;
  // kind / displayName / mountAngles unchanged — that's the point
}
```

**Subtle correctness gain:** removing the spread also removes a real
class of bugs where a non-spatial field is silently dropped from the
preservation block.

### 5. New typed-arrays per call

```ts
// HOT — per ship per snapshot per recipient.
mountAnglesArr = new Array<number>(angles.length);
for (let i = 0; i < angles.length; i++) mountAnglesArr[i] = Math.round(angles[i]! * 10_000) / 10_000;
```

**Fix:** per-ship persistent array keyed in a Map; lazy alloc, reuse.
Clean up on `onLeave` / despawn.

### 6. Continuous-data `bus.emit`

Already forbidden by the Event Bus invariant (root CLAUDE.md "Event
Bus Architecture"). Cross-reference; do not re-emit per-tick state.

### 7. `Object.entries` / `.map` / `.filter` per tick

```ts
states: Object.fromEntries(allShips.map((s) => [s.playerId, { x: s.pose.x, y: s.pose.y }]))
```

`map` allocates a new array; `Object.fromEntries` allocates the
result object plus tuple arrays inside `.map`. If this is on a hot
path, convert to a manual loop populating a scratch object.

### 8. postMessage payloads

Every `worker.postMessage({ ... })` structures-clones the object.
For SAB-backed state, never postMessage poses — use SAB. The
`RendererFeedback` contract (`src/client/render/worker/protocol.ts`)
is the closed-set channel; expanding it is a phase-gate review.

## The patterns we use

### A. `ObjectPool` (the canonical primitive)

Lives at `src/core/util/ObjectPool.ts`. Pure, zone-blind, consumable by
both server and client. Modelled on `HitPredictionLedger`'s inline
pool.

```ts
const pool = new ObjectPool<Entry>(
  () => ({ x: 0, y: 0, label: '' }),    // factory
  (e) => { e.x = 0; e.y = 0; e.label = ''; }, // reset on release
);

const e = pool.acquire();
e.x = 1; e.y = 2;
// ... use ...
pool.release(e); // or pool.releaseAll(arrayOfEntries)
```

The `pool.allocations()` probe returns the lifetime factory-call
count. **This is the regression-test surface.**

### B. Persistent scratch (no pool needed)

For primitive arrays / Maps / Sets that don't need per-entry pooling:

```ts
class SectorRoom {
  private readonly _boostingIds: string[] = [];
  private readonly _aiPlayerScratch: AiPlayerView[] = [];
  private readonly _swarmNearbyIds = new Set<number>();

  update(): void {
    clearArray(this._boostingIds);
    this._swarmNearbyIds.clear();
    // ... populate
  }
}
```

### C. Caller-owned scratch parameters

Code in `src/server/interest/SpatialGrid.ts` already uses this:

```ts
query9(cx: number, cy: number, out: Set<number>): void {
  out.clear();
  // ... populate out
}
```

The caller owns the lifetime; the callee never allocates.

### D. Pre-allocated typed arrays

`SnapshotRing` (`src/server/lagcomp/SnapshotRing.ts`) is the textbook
example: 1000 entities × 12 ticks × 6 floats = 576 KB pre-allocated
at boot; per-tick writes use index arithmetic, never allocation.

## The HitPredictionLedger contract

`src/core/combat/HitPrediction.ts` is the canonical example of how
this paradigm scales. The class:

1. Has an internal `pool: Entry[]` free list.
2. Acquires via private `acquire()`, increments `allocCount` only on
   factory fallback.
3. Releases via private `evict()`, pushes back to free list.
4. Exposes `allocations(): number` so a test can prove the steady
   path is allocation-free.

Test lock at `src/core/combat/HitPrediction.test.ts:229`:

```ts
for (let i = 0; i < 1000; i++) { /* fire / reconcile cycle */ }
expect(l.allocations()).toBeLessThanOrEqual(4);
```

**Why `<= 4` and not `=== 0`?** Initial pool warm-up plus one
transient overflow during peak concurrent shots. The number is
parameterised by the peak concurrent count, NOT by the loop count.

## How to measure

### Built-in observability

- **`GcMonitor`** (`src/server/debug/GcMonitor.ts`) — boot-installed
  `PerformanceObserver` for `type: 'gc'`. Emits `gc_pause` server-
  events for pauses > 5 ms; capture pipeline routes them into
  `perf.ndjson`.
- **`tick_hitch`** — per-tick > 12 ms produces a hot-capture event
  with 3-tick phase history. Correlate timestamps with `gc_pause`
  events to confirm GC-induced stutters.
- **`tick_budget`** — 60-tick aggregate window: avg / max / over-
  budget count per phase.

### Manual profiling

```bash
pnpm dev:server:gctrace
# NODE_OPTIONS="--max-semi-space-size=128 --trace-gc-verbose"
# Forces frequent minor-GCs so allocation pressure surfaces.
```

```bash
node scripts/analyze-cdp-profile.mjs diag/drawer-lag-trace/cdp-perf.json
# Post-hoc CDP profile analysis (function self / total time).
```

### Automated regression locks

Allocation tests live in `tests/integration/allocations/`:

```bash
pnpm test:alloc
# NODE_OPTIONS='--expose-gc' vitest run tests/integration/allocations
```

Each test asserts a pool's `allocations()` bound parameterised by
the test inputs — NOT a hard-coded number — so new test data
doesn't break unrelated assertions.

## Common smells / anti-patterns

| Smell | Why it's bad | Fix |
|---|---|---|
| `const arr: T[] = []` inside `update()` | Per-tick array allocation | Class field + `clearArray()` |
| `new Set()` inside any per-frame function | Per-frame Set + GC | Persistent field + `.clear()` |
| `arr.map(...)` per frame | New array + N tuple objects | Manual `for` loop into scratch |
| `Object.entries(obj)` per tick | New array of [k,v] tuples | Iterate object directly |
| `JSON.stringify(payload)` per tick | New string allocation | Move telemetry off the hot path |
| `worker.postMessage({ x, y, … })` per frame | Structured-clone allocates | SAB write OR batch via `RendererFeedback` |
| `bus.emit('FOO', { … })` per tick | Object + Event-Bus invariant violation | Direct state mutation / SAB |
| `Array.from(set)` to iterate | New array per iteration | `for (const x of set)` |
| Closure `set.forEach(x => ...)` | Per-call closure | Hoisted callback OR `for…of` |
| `${a},${b}` Map key | Per-lookup string + key garbage | Two-level Map OR a packed numeric key |
| Allocating an Error to throw on a hot rejection | New Error allocates a stack | Reject silently / increment counter |

## When pooling is wrong

Pooling has overhead — the free-list, the reset function, indirection
through `acquire()`. It's the right answer for **steady-path** allocations
in hot loops; it's the wrong answer for:

- Cold paths — one-shot init, `onJoin`, `onDispose`.
- Immutable value objects passed across boundaries (Colyseus schema
  diffs, msgpack-encoded wire messages).
- Frozen constants / enums.
- Returns to the public API where the caller expects fresh ownership
  (the caller-owned-scratch pattern inverts this — the caller decides).

If a hot-path allocation can be measured at < 1 % of `tick_budget.avg`
AND the alloc count is < 100 per minute, prefer leaving it alone over
introducing a pool. **Profile first.**

## Known untouched allocators (2026-05-25 snapshot)

Catalogued from the 2026-05-25 audit. Not fixed in the GC-discipline
sweep PR — opt-in via `/allocation-audit` on touching PRs.

- `SectorRoom.tickPlayerMounts` per-drone target object literals
  (60 Hz, but partly mitigated by `mountTargetsScratch.length = 0`).
- `SectorRoom.tickDroneMounts` per-player target object literals
  (same shape as above).
- `ColyseusClient._recentIntervals` push/shift (20 Hz, numbers only,
  bounded length 10).
- `SectorRoom` snapshot telemetry log `Object.fromEntries(allShips.map(...))`
  (20 Hz, gated by `broadcastCounter % 3 === 0`).
- Server `tickHistoryRing` `phases: { ...this.thisTickPhases }` per tick
  (cap 3, recycled).
- Lifecycle bus emits (BOT_SPAWNED, SHIP_DESTROYED) — combat-rate, not
  per-tick.

Physics worker audited: `src/core/physics/worker.ts` only allocates
`new Map(...)` at module init (lines 102–122). No per-tick allocation.

## See also

- `src/core/util/ObjectPool.ts` — primitive
- `tests/integration/allocations/` — regression locks
- `.claude/skills/allocation-audit/SKILL.md` — `/allocation-audit` skill
- `src/core/combat/HitPrediction.ts:226-241` — the prototype pattern
- `src/server/lagcomp/SnapshotRing.ts` — pre-allocated TypedArray
- `src/server/net/BinarySwarmBroadcast.ts` — reusable encoder buffer
- `docs/LESSONS.md` 2026-05-04 (V8 minor-GC jitter) + 2026-05-25 (GC sweep)
