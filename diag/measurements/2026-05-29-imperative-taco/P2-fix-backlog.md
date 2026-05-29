# Phase 2 — Fix backlog (data-driven from P1 ranking)

The Phase 1 hostile-`diag=0` ranking names a different top-of-stack than the lazy-mochi handoff predicted. Picking by data, not by audit hint.

## Selected fix targets (top 2)

### Fix 1 — `logEvent('rafWork', {...})` per-RAF allocation in `gameRafLoop.loop`

**Site:** `src/client/app/gameRafLoop.ts:87-94`.

**What allocates:** the `{...}` literal with 6 fields + 5 `parseFloat(toFixed(2))` strings, **every RAF** (60 Hz). The `HIGH_VOLUME_TAGS` early-return is INSIDE `logEvent` (`ClientLogger.ts:93`); by the time control reaches that line, the caller has already paid the full allocation cost. Production phones running `?diag=0` still pay 6+ KB/s of pointless `{...}` + string churn.

**Fix shape:** import `isFullDiagMode` from `ClientLogger` at the call site; wrap the `logEvent('rafWork', ...)` block in `if (isFullDiagMode()) { ... }`. `isFullDiagMode` is already a cached boolean read (per the comment block at `ClientLogger.ts:88-92` it's "two boolean reads" hot-path). Same pattern is applied to `pixi_first_frame` (one-shot — keep unconditional) and to any other `logEvent` calls in the RAF hot loop.

**Locked by:** new heap-delta unit test `tests/unit/gameRafLoop.heapDelta.test.ts` — drives `createGameRafLoop(...)` via stub deps, runs 3000 simulated frames, asserts heap growth < 50 KB.

**Expected impact:** the `logEvent` cumulative share (43.4 KB / 5.4 % under diag=0) — at least the `rafWork` slice (~10-15 KB / 1.3-1.9 %) drops out. Real-world ~60-300 KB/s allocation reduction (depending on sampling overhead factor).

### Fix 2 — `writeE2EDataset` JSON.stringify + map building every 5th frame

**Site:** `src/client/app/gameRafLoop.ts:128-139` (the call site) + `156-255` (the function body).

**What allocates:** every 5th RAF (12 Hz at 60 Hz native), the function builds `posMap`, `swarmMap`, `swarmDetail`, `remoteHitTargetIds`, `remoteLaserRanges`, then calls `JSON.stringify` on each. Each iteration over `mirror.ships` / `mirror.swarm` allocates a per-entry `{x, y}` (or `{x, y, angle, kind, sleeping, lastUpdateTick, radius}`) object literal. Then `JSON.stringify` allocates a fresh string per call. With 25 drones, ~25 entries × ~7 fields × 12 Hz = 2100 small object allocations/sec **plus** 4 `JSON.stringify` calls per frame producing 4 strings.

**Production phones don't read these `data-*` attributes.** They exist solely so Playwright specs can poll entity positions and game state from the DOM. On a real player's phone they're wasted allocation.

**Fix shape:** gate the entire `writeE2EDataset` invocation at the call site on `navigator.webdriver`. Playwright sets `navigator.webdriver === true`; a real player's browser sets it to `false` (or `undefined`). The check is cached at module load (or first call) so it's free in the hot path.

```ts
const E2E_DATASET_ENABLED = typeof navigator !== 'undefined' && navigator.webdriver === true;
// in the loop:
if (writeDataset && feedback && E2E_DATASET_ENABLED) {
  writeE2EDataset(...);
}
```

The first `if (localShip && writeDataset && feedback)` block at line 132 (which writes `shipX`/`shipY`/`shipAngle`/`mountCount` directly to el.dataset without JSON.stringify) is **kept unconditional** — it's the cheapest part and a couple of specs read it directly. Only the heavy `writeE2EDataset` (with the maps + JSON.stringify) is gated.

**Locked by:** the same heap-delta unit test extended to assert that the per-5-frame branch does not allocate when `E2E_DATASET_ENABLED === false`. Stub navigator.webdriver via a settable hook on the function (the simplest non-invasive shape).

**Expected impact:** the `gameRafLoop.loop` share (55 KB / 6.8 % under diag=0) — at least the `writeE2EDataset` slice (~20-40 KB sampled = ~25-50 % of the rank-1 entry) drops out. Real-world ~150-400 KB/s allocation reduction on phones.

## Not selected this round (and why)

### `tick` WarpScreen (40.8 KB / 5.1 %)

React component re-rendering. WarpScreen is always mounted while `phase === 'game'`; each Zustand store update (hostile combat fires lots of hull/shield updates) re-runs the selector chain and React reconciles the Fiber tree. The fix shape is React-specific (React.memo with stable selectors, OR conditionally-mount on phase) and risks UX regression on the join-readiness chain. Deferred — revisit if Fixes 1+2 don't move the needle.

### `onMessageCallback` colyseus__js (30.1 KB / 3.7 %)

Library code (`node_modules/.vite/deps/colyseus__js.js:7630`). Each incoming Colyseus message allocates parse buffers. Reducing this requires either patching the library or reducing message volume (snapshot cadence, etc.) — both out of scope and risky.

### `handleDamage` / `GhostManager` / `sendFire` / `handleSnapshot` (handoff candidates — NOT in top-25)

The audit pre-named these, but the hostile-`diag=0` profile does not rank them. They allocate, but below the ~7 KB / 0.9 % top-25 floor. Fixing them would yield <1 % each at the cost of code complexity. Following the data per the plan's Phase 2 decision-gate.

### `(anonymous) ColyseusClient.ts:731` (14.2 KB / 1.8 %)

Inside a JSDoc comment region; likely misattributed sample. Sub-2 % share. Defer.

## Exit criteria for Phase 3

- New heap-delta unit test `tests/unit/gameRafLoop.heapDelta.test.ts` exists, fails on current code, passes after both fixes land.
- Inner-loop green: `pnpm typecheck && pnpm lint && pnpm test:gc && pnpm test -- --run` (8 pre-existing failures expected).
- Test + fix per commit per Invariant #9.

Move to Phase 4 once both fixes are committed + locked.
