# Phase 1 — Hostile-drone CDP allocation profile (HEAD)

Branch: `integration/four-branches`, HEAD `088e8d0` + uncommitted (this session's `startHostile` primitive + new spec).
Workload: `room=feel-test-25`, `startHostile=1`, 25 s held-fire combat.
Spec: `tests/e2e/combat-allocation-profile-hostile.spec.ts`.

Ran twice — once with `diag=1` (matches the gate environment + lazy-mochi P2 precedent) and once with `diag=0` (production-parity, what phone capture `5d0e7d` actually saw).

## Run A — `diag=1` (gate environment)

Total sampled: **1.22 MB** over 25 s.

| Rank | KB | % | Function | Location |
|---|---:|---:|---|---|
| 1 | 48.0 | 3.8 | `exec` | (V8 RegExp internal) |
| 2 | 45.8 | 3.6 | `tickPhysics` | `ColyseusClient.ts:2022:14` |
| 3 | 42.8 | 3.4 | `loop` | `gameRafLoop.ts:11:16` |
| 4 | 35.9 | 2.9 | `FiberNode` | React (chunk-EM6PUTC5) |
| 5 | 30.7 | 2.5 | `handleWorkerMessage` | `WorkerRendererClient.ts:333:22` |
| 6 | 27.8 | 2.2 | `keys` | (V8 Object/Map iter) |
| 7 | 27.2 | 2.2 | `exec` | (V8 RegExp internal) |
| 8 | 24.5 | 2.0 | `logEvent` | `ClientLogger.ts:8:25` |
| 9 | 24.5 | 2.0 | `logEvent` | `ClientLogger.ts:8:25` |
| 10 | 24.4 | 1.9 | `tick` | `WarpScreen.tsx:51:18` |
| 11 | 24.1 | 1.9 | `scheduleUpdateOnFiber` | React (chunk-EM6PUTC5) |
| 12 | 22.3 | 1.8 | `FiberNode` | React (chunk-EM6PUTC5) |
| 13 | 20.4 | 1.6 | `logEvent` | `ClientLogger.ts:8:25` |
| 14 | 19.4 | 1.5 | `logEvent` | `ClientLogger.ts:8:25` |
| 15 | 18.8 | 1.5 | `checkType` | Pixi (chunk-RGZPK2M4) |
| 16 | 17.9 | 1.4 | `indexOf` | (V8 Array internal) |
| 17 | 17.3 | 1.4 | `logEvent` | `ClientLogger.ts:8:25` |

`logEvent` cumulative across visible frames: **106.1 KB / 8.4 %** — the largest single contributor under `diag=1`, exactly the lazy-mochi P2 pattern. Not a fix target for THIS plan because the rising-edge we're chasing (phone capture `5d0e7d`) ran with `diag=0`.

## Run B — `diag=0` (production-parity — what the phone runs)

Total sampled: **0.79 MB** over 25 s. 36 % lower than diag=1 (matches the cost of ClientLogger.logEvent being suppressed).

| Rank | KB | % | Function | Location |
|---|---:|---:|---|---|
| 1 | 55.0 | 6.8 | `loop` | `gameRafLoop.ts:11:16` |
| 2 | 40.8 | 5.1 | `tick` | `WarpScreen.tsx:51:18` |
| 3 | 31.4 | 3.9 | `exec` | (V8 RegExp internal) |
| 4 | 30.1 | 3.7 | `onMessageCallback` | `colyseus__js.js:7630:24` (library) |
| 5 | 23.4 | 2.9 | `keys` | (V8 Object/Map iter) |
| 6 | 20.0 | 2.5 | `validateChildKeys` | React jsx-dev-runtime |
| 7 | 17.9 | 2.2 | `getPrototypeOf` | (V8 internal) |
| 8 | 17.6 | 2.2 | `keys` | (V8 Object/Map iter) |
| 9 | 17.5 | 2.2 | `keys` | (V8 Object/Map iter) |
| 10 | 14.4 | 1.8 | `exec` | (V8 RegExp internal) |
| 11 | 14.3 | 1.8 | `logEvent` | `ClientLogger.ts:8:25` |
| 12 | 14.2 | 1.8 | `(anonymous)` | `ColyseusClient.ts:731:34` (resetPredictionState region) |
| 13 | 13.9 | 1.7 | `deepmerge` | Pixi (chunk-RGZPK2M4) |
| 14 | 12.4 | 1.5 | `isCustomComponent` | React |
| 15 | 11.7 | 1.5 | `useDebugValue` | React |
| 16 | 11.5 | 1.4 | `renderWithHooks` | React |
| 17 | 10.9 | 1.4 | `join` | (V8 Array internal) |
| 18 | 10.7 | 1.3 | `logEvent` | `ClientLogger.ts:8:25` |
| 19 | 10.2 | 1.3 | `logEvent` | `ClientLogger.ts:8:25` |
| 20 | 8.7 | 1.1 | `deepmerge` | Pixi (chunk-RGZPK2M4) |
| 21 | 8.2 | 1.0 | `logEvent` | `ClientLogger.ts:8:25` |
| 22 | 8.1 | 1.0 | `createElement` | React |
| 23 | 8.1 | 1.0 | `(anonymous)` | `longtaskObserver.ts:10:46` |
| 24 | 7.8 | 1.0 | `diffProperties` | React |
| 25 | 7.5 | 0.9 | `parseFloat` | (V8 internal) |

`logEvent` cumulative (4 entries): **43.4 KB / 5.4 %** — still allocating even with `?diag=0`. The `HIGH_VOLUME_TAGS` early-return is at line 93 INSIDE `logEvent`; the caller's `{...}` literal + per-field `toFixed(2)` strings are allocated BEFORE the bail-out. So `?diag=0` doesn't suppress them — only the ring-buffer push.

## Honest read-out

The lazy-mochi handoff's named suspects (`handleDamage`, `GhostManager.update`/`spawn`, `sendFire`, `handleSnapshot`) are **not in the top-25 under either diag setting**. The hostile workload landed real combat (drones did return fire and damage events flowed — confirmed by the 25 s test passing with sampling > 100 samples), so the absence is real, not measurement-induced.

The actual top-of-stack production allocators are clustered in:

1. **`gameRafLoop.loop`** (55 KB / 6.8 % under diag=0) — the RAF callback. Per-frame `logEvent('rafWork', {...})` + per-5-frame `writeE2EDataset` (JSON.stringify of shipPositions, swarmDetail, predStats, etc.). The `logEvent` builder allocates the `{...}` literal + 5 `toFixed(2)` strings BEFORE the HIGH_VOLUME_TAGS early-return inside logEvent — so `?diag=0` doesn't save it.

2. **`tick` WarpScreen** (40.8 KB / 5.1 %) — React component re-rendering. WarpScreen is always mounted during the `game` phase; its `tick` selector chain re-runs every Zustand store update (and hostile combat fires lots of hull/shield store updates).

3. **`onMessageCallback` colyseus__js** (30.1 KB / 3.7 %) — Colyseus library code. Each incoming message (DamageEvent, ShieldEventMessage, snapshots, hit_acks) allocates buffers for parsing. Hard to fix without library work; out of scope.

4. **`logEvent`** cumulative 43.4 KB / 5.4 % — the gate inside `logEvent` doesn't help when the caller already built the `{...}` literal. **The fix is at the call sites: gate the builder, not the receiver.**

5. **`(anonymous) ColyseusClient.ts:731`** (14.2 KB / 1.8 %) — line 731 is inside the JSDoc for `resetPredictionState`; the function body starts line 763. Likely a misattribution to a nearby closure (the `weaponHitPrediction` adapter at line ~700 or the various inline handlers). Sub-2 % — below the fix threshold for this round.

The handoff's `handleDamage` / GhostManager / sendFire candidates may still allocate, but they don't make the top-25 — they're below the ~7 KB / 0.9 % floor. Fixing them would yield <1 % each. The data says the gain is at the RAF-loop + React-component sites.

## Cross-reference with lazy-mochi P2 baseline (peaceful, diag=1)

| Allocator | lazy-mochi peaceful HEAD-post-fix (diag=1) | This hostile HEAD (diag=0) |
|---|---|---|
| `gameRafLoop.loop` | 52.0 KB / 5.0 % | **55.0 KB / 6.8 %** |
| `WarpScreen.tick` | 61.4 KB / 5.9 % | 40.8 KB / 5.1 % |
| `tickPhysics` | 76.7 KB / 7.3 % | (not in top-25 under diag=0) |
| `logEvent` cumulative | ~160 KB / 14 % | **43.4 KB / 5.4 %** |

The `gameRafLoop.loop` share went UP under hostile combat (5.0 % → 6.8 %), confirming the workload-sensitive path. `tickPhysics` falling out of the top-25 under diag=0 is expected — most of its samples in the diag=1 path were the input-bit-pattern logEvent traces.
