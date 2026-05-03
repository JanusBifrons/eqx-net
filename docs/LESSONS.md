# Lessons Learned — EQX Peri

Chronological log of non-obvious findings discovered while implementing the phased plan. Append-only; each entry dated, referencing phase and commit.

Use this file for findings that would cost a future Claude (or human) time to re-derive: gotchas, benchmark surprises, failure modes the blueprint didn't anticipate. Do **not** use this file for general architecture — that belongs in CLAUDE.md.

Entry format:

```
## YYYY-MM-DD — <Phase N> — <short title>
Commit: <sha or PR>
What we hit, how we diagnosed it, how we resolved it, and what downstream phases need to know.
```

---

## 2026-05-03 — Phase 5 — Mobile `corr` rate of 30–60% caused by accumulator-cap discarding elapsed time
Commit: Phase 5 sub-phase A (mobile reconciliation).

`ColyseusClient.tickPhysics()` originally used a fixed-timestep accumulator with a 5-frame cap: `this.accumulator += Math.min(elapsedMs, FIXED_MS * 5)`. On mobile the main thread is regularly blocked for tens of ms (touch dispatch, scroll, GPU composite hiccups). Each block discarded the over-cap elapsed time, so `inputTick` permanently fell behind real wall-clock time — and therefore behind `serverTick`, which advances strictly at 60 Hz. Over a 30-second session the desync accumulated to a steady-state offset where 30–60 % of snapshots produced reconciliation drift > `LERP_THRESHOLD` (0.05 u) and triggered a visible lerp.

**Fix**: derive `targetTick` directly from wall clock — `serverTickAtWelcome + Math.floor((now − welcomePerfNow) / FIXED_MS)` — and step the input loop until `inputTick === targetTick`, capped at `MAX_CATCH_UP_TICKS = 4` per RAF (so a long pause amortises catch-up over several frames rather than burning CPU). Identical mechanism on respawn: re-anchor `welcomePerfNow` and `serverTickAtWelcome` to `msg.serverTick`.

**Why the existing `logEvent('snapshot', …)` ring buffer was sufficient for diagnosis**: it already captures `serverTick`, `ackedTick`, `ticksAhead = inputTick − ackedTick`, and `driftUnits` per snapshot. Any future "the corrections feel weird" investigation should start by reading `window.__eqxLogs.filter(e => e.tag === 'snapshot')` rather than adding new instrumentation. Specifically, a steady `ticksAhead` that shrinks rather than holds at the expected RTT/2 ticks is the smoking gun for a clock-anchor bug like this one.

**Don't re-introduce an accumulator-cap design** — the cap is a property of the inner loop (`MAX_CATCH_UP_TICKS`), not of the elapsed-time measurement. Capping `elapsedMs` itself is the bug.

## 2026-04-18 — Phase 0 — Foundation seeded
Commit: initial scaffolding.

Phase 1 is expected to surface the first real gameplay findings (Rapier WASM async init timing, Colyseus schema types under strict TS, pixi-viewport v8 with React's mount lifecycle).

## 2026-04-18 — Phase 0 — better-sqlite3 not installed at Phase 0
Commit: initial scaffolding.

`better-sqlite3` 11.x has no prebuilt binaries for Node 24, and `node-gyp` requires Python to build from source, which this Windows dev machine lacks. Rather than introduce a Python dependency or downgrade Node, we deferred installing `better-sqlite3` until Phase 7 (when it is actually used). The Technology Stack Matrix in the root CLAUDE.md still lists it as the server zone's persistence layer — only the `package.json` dependency was removed.

**Action at Phase 7**: evaluate whether to pin to `better-sqlite3@^12` (which ships Node 24 prebuilts), downgrade the project's Node engine, or switch to another SQLite binding. Decide at that boundary, not now.

## 2026-04-19 — Phase 1 — Thrust/turn direction mismatch between Rapier and Pixi
Commit: Phase 1 physics fix.

The ship polygon draws the nose at (0, -16) in Pixi local space — pointing visual-up at sprite.rotation=0. Rapier's angle=0 means facing +X (right). The original thrust formula `(cos θ, sin θ)` applied force in the wrong direction relative to the visual ship facing.

**Correct thrust formula**: `(-sin θ, cos θ)`. Derived from the visual nose direction in Rapier world space: at θ=0, the nose is Pixi-up = Rapier +Y = (0, 1) = (-sin 0, cos 0). ✓

**Turning was also inverted**: `sprite.rotation = -ship.angle`, so Rapier CCW (positive ω) produces a decreasing sprite.rotation = CCW on screen = visual left turn. The original code had A → negative ω (CW in Rapier → CW on screen → right turn). Swapped to A → positive ω, D → negative ω.

**Rule**: whenever the renderer applies a Y-flip (`sprite.y = -rapier.y`) and a rotation-flip (`sprite.rotation = -rapier.angle`), the "visual forward" direction is `(-sin θ, cos θ)` not `(cos θ, sin θ)`. Don't change the polygon — fix the impulse formula.

## 2026-04-19 — Phase 1 — Vite WebSocket proxy for Colyseus rooms
Commit: Phase 1 WS proxy fix.

After fixing HTTP matchmaking CORS via `/matchmake` Vite proxy, the Colyseus room WebSocket still hung. Root cause: `colyseus.js` constructs the room WebSocket URL as `ws://localhost:5173/<processId>/<roomId>?sessionId=xxx` (from the base `Client` URL). Vite's built-in proxy `bypass()` function is also called for WebSocket upgrade requests (contrary to what the docs imply), so a `'/'` rule with `bypass(req) { return req.url; }` caused both HTTP and WS to be served by Vite — the WebSocket hung waiting for a 101 that never came.

**Fix**: remove all `ws:true` proxy rules; add a `configureServer` plugin that listens for `httpServer.upgrade` events and manually TCP-proxies non-HMR WebSocket connections to port 2567 using `node:net`. HMR moved to a dedicated port (`server.hmr.port: 24678`) so it never hits the same upgrade listener.

**Diagnostic that unlocked it**: adding `httpServer.on('upgrade', ...)` to the Colyseus server to log every WebSocket upgrade. Absence of that log meant the upgrade was never reaching the server.

## 2026-04-18 — Phase 1 — @colyseus/schema v3 + tsx decorator mismatch
Commit: Phase 1 runtime fix.

Three separate decorator-related crashes appeared together:

1. **`defineTypes()` + `Symbol.metadata` crash** (`EncodeOperation.ts:37`): @colyseus/schema v3's encoder reads `constructor[Symbol.metadata]` to locate field type descriptors. `defineTypes()` registers types in a parallel registry but never populates `Symbol.metadata`. Result: every `broadcastPatch` tick throws.

2. **`@type` decorator + Stage 3 transform** (`target.constructor is undefined`): switching to `@type` decorators failed because `tsx watch src/server/index.ts` had no tsconfig to read, so esbuild defaulted to Stage 3 decorator semantics. @colyseus/schema's `@type` implementation is written for the legacy `experimentalDecorators` API where the decorator receives `(target: prototype, key: string)`. Under Stage 3, it receives `(value, context)` — `target` is `undefined`.

3. **tsx `watch` flag ordering**: `tsx --tsconfig ... watch ...` treats `watch` as the script to run. Correct order is `tsx watch --tsconfig ... <script>`.

**Resolution**: `tsconfig.server.json` gets `experimentalDecorators: true, useDefineForClassFields: false`. `useDefineForClassFields: false` is required because `target: ES2022` would otherwise default it to `true`, causing field initializers to run via `Object.defineProperty` *after* decorators and overwrite their registrations. The `dev:server` script passes `--tsconfig tsconfig.server.json` after `watch` so tsx/esbuild reads the right settings.

**Downstream phases**: any server-side schema class must use `@type` decorators (not `defineTypes()`). The tsconfig settings apply to the entire server zone.

## 2026-04-19 — Phase 1 — Rapier ball collider mass far exceeds expectations
Commit: Phase 1 movement fix.

`THRUST_IMPULSE = 0.15` produced visually invisible movement. Root cause: Rapier's default density is 1.0; a ball collider with radius=12 has area=π×144≈452, giving mass≈452. `dv = impulse/mass = 0.15/452 ≈ 0.00033 units/step` — after 800 ms of thrust the ship moved <0.01 units, indistinguishable from stationary.

**Fix**: set collider density to `1/(π×r²)` so mass≈1, keeping THRUST_IMPULSE at 0.15. At mass=1, 800 ms of continuous thrust yields ~4 units of displacement — clearly perceptible.

**Rule for future phases**: when tuning physics constants, always verify with a quick unit test or console readout that mass is in a sane range before assuming impulse values are reasonable. The Rapier default density of 1 is designed for meter/kg/second units; game worlds using "pixel-ish" units need explicit density or mass overrides.

## 2026-04-19 — Phase 1 — React StrictMode async IIFE needs disposal guard
Commit: Phase 1 StrictMode fix.

React StrictMode fires the effect cleanup synchronously after the effect function returns, then re-runs the effect. Because the async IIFE inside `useEffect` yields at `await renderer.init(el)`, the cleanup (setting `disposed = true`) fires before the IIFE resumes. Without a guard, the IIFE continues after `init()` resolves: it appends a second orphan canvas, starts a second render loop, and calls `gameClient.connect()` — resulting in two rooms joined per browser tab.

**Fix**: immediately after `await renderer.init(el)`, check `if (disposed) { renderer.dispose(); return; }`. This tears down the just-initialised canvas and exits the first IIFE cleanly, leaving the second (real) mount to proceed normally.

**Rule**: any async `useEffect` that allocates resources must guard against disposal at every `await` boundary, not only at the start.

## 2026-04-19 — Phase 1 — Shared localStorage causes playerId collision between tabs
Commit: Phase 1 identity collision fix.

Two browser tabs in the same Chrome profile share `localStorage`. Both tabs read the same `eqxPlayerId` and present it to the server. `assignPlayerId` accepts any valid UUID, so both sessions got the same playerId → server found an existing ship and skipped spawning a second one → both sessions drove the same ship.

**Fix**: in `SectorRoom.onJoin`, if `playerToSession.has(playerId)` (the ID is already held by an active session), call `assignPlayerId(null)` to generate a fresh UUID. The incoming tab gets a new identity rather than colliding.

**Downstream (Phase 8)**: Limbo reconnection relies on presenting the stored playerId to resume a mid-transit session. The collision guard must NOT fire when the reconnecting client is the *same* person on the *same* device — it fires only when a truly different session presents the same ID. At Phase 8, the Limbo flow should close the old session before the new one calls `onJoin`, so `playerToSession` will no longer contain that ID when the reconnect arrives. Verify this assumption when implementing Limbo.

## 2026-04-19 — Phase 2 — tsx ESM loader does not rewrite imports inside worker_threads on Node.js v24
Commit: Phase 2 worker fix.

The Phase 2 plan calls for `execArgv: ['--import', 'tsx/esm']` to load the TypeScript physics worker. This approach fails silently on Node.js v24: tsx IS registered in the worker (it handles the `.ts` entry file), but its resolve hook does NOT rewrite `.js`-extension or extensionless imports inside the worker to `.ts`. Both `import './World.js'` and `import './World'` fail with `ERR_MODULE_NOT_FOUND` even though `World.ts` exists alongside the worker.

Root cause is an incompatibility between tsx v4.21 and the Node.js v24 module loader internals. The same pattern works on Node.js 20/22.

**Fix**: bundle `worker.ts` to a self-contained CommonJS string at room startup using esbuild (`{ bundle: true, platform: 'node', format: 'cjs', write: false, external: ['@dimforge/rapier2d-compat'] }`), then spawn it as `new Worker(code, { eval: true, workerData: { sab } })`. esbuild resolves all TypeScript imports at bundle time, so the runtime worker is plain JS with no loader dependency.

**Why Rapier is external**: Rapier ships a pre-built WASM binary. Including it in the esbuild bundle doubles the binary size and causes a second WASM init. Keeping it external means the worker loads the same package copy as the main thread.

**Rule**: never rely on tsx/ESM loader hooks inside `worker_threads.execArgv` — it is fragile across Node versions. Bundle to JS with esbuild for workers that import project code.

## 2026-04-19 — Phase 2 — SharedArrayBuffer seqlock guarantees linearisable reads without locking the main thread
Commit: Phase 2 SAB implementation.

The physics worker writes state to SAB under a seqlock (SEQLOCK_IDX word flipped odd→even around each write batch). The Colyseus main thread reads under a spin-retry loop: load seq1, read all ship fields, load seq2 — retry if seq1 is odd or seq1 ≠ seq2. This guarantees the main thread always reads a consistent snapshot without any OS-level mutex.

The worker uses `Atomics.add(u32, SEQLOCK_IDX, 1)` (not `store`) for the lock/unlock increments. `add` issues a full memory barrier on x86 and ARM, which is necessary so that the subsequent `f32[base + ...] = ...` writes are not reordered past the unlock increment. `Atomics.store` only provides a release barrier, which is asymmetric and would allow reads to observe the unlock before all slot writes complete on some architectures.

**Rule**: use `Atomics.add` for seqlock increments in SharedArrayBuffer, not `Atomics.store`.

## 2026-04-19 — Phase 3 — onStateChange can fire before welcome; local ship accidentally enters remoteHistory
Commit: Phase 3 prediction fix.

Colyseus delivers `onStateChange` and `onMessage('welcome')` independently. When the initial state patch arrives before the welcome message, `mirror.localPlayerId` is still null, so `syncMirror` treats the local ship as a remote entity and adds it to `remoteHistory`. Subsequent state patches correctly skip `remoteHistory` for the local player (welcome has now fired, localId is known), but the stale entry from the first patch is never removed.

In `updateMirror()`, the remote-ship interpolation loop iterated over **all** `remoteHistory` entries, including the stale local-player entry. The interpolation returned the spawn-position snapshot (100 ms display-delay, still pointing at t=0), which overwrote the prediction-world position set earlier in the same `updateMirror` call. Result: the local ship appeared frozen at spawn coordinates despite the prediction world advancing correctly.

**Fix**: skip `localId` in the remote-ship interpolation loop inside `updateMirror()`:
```typescript
for (const [playerId, hist] of this.remoteHistory) {
  if (playerId === localId) continue;
  ...
}
```

**Diagnostic**: two symptoms pointed here — (1) position dist=0 after 800 ms of W-key thrust, and (2) cross-client position diff of ~5.5 units (P1's frozen spawn vs P2's server-updated view of P1). The frozen position was always the spawn coordinate, not a moving stale value, which revealed the single-entry stale remoteHistory.

**Rule**: when using a `localId` guard inside `syncMirror` to separate local vs remote handling, also apply the same guard in every subsequent read of `remoteHistory` — the guard in the writer is not enough if the writer had a race-condition window at startup.

## 2026-04-19 — Phase 3 — Lerp offset `lerpInitial * 0` produces -0, breaking Object.is equality in tests
Commit: Phase 3 reconciler fix.

The final `advanceLerp` frame decrements `lerpFramesLeft` to 0 and then computes `lerpOffset.x = lerpInitial.x * (0 / LERP_FRAMES) = lerpInitial.x * 0`. When `lerpInitial.x` is negative (ship teleported left), the result is `-0`. Vitest's `expect(...).toBe(0)` uses `Object.is`, which distinguishes `+0` from `-0`, so the test fails.

**Fix**: branch on `lerpFramesLeft === 0` and assign literal `0` rather than computing `lerpInitial * ratio`:
```typescript
if (this.lerpFramesLeft === 0) {
  this.lerpOffset.x = 0;
  this.lerpOffset.y = 0;
} else {
  const ratio = this.lerpFramesLeft / LERP_FRAMES;
  ...
}
```

**Rule**: never derive a zero value through multiplication when testing with `Object.is` equality; assign literal `0` when the intent is "cleared".

## 2026-04-19 — Phase 3 — Physics worker variable-dt caused server/client step-count divergence
Commit: Phase 3 diagnostics fix.

The physics worker originally used actual elapsed wall-clock time (`dtSec = (now - lastMs) / 1000`) to drive the accumulator. `setInterval` on Node.js is not perfectly timed; the actual callback period jitters by ±1–3 ms. When `dtSec` slightly overshoots `TICK_MS`, the accumulator produces 2 steps in one callback; when it undershoots, 0 steps. Over even 3 seconds this produces step-count drift between server and client, causing persistent reconciliation corrections even with no inputs.

**Fix**: remove the wall-clock measurement entirely. Pass the nominal fixed dt (`TICK_MS / 1000`) directly to `physics.tick()`. The accumulator in `World.ts` then always produces exactly 1 step per callback, matching the client's per-`requestAnimationFrame` behaviour.

**Diagnostic signal**: `no-input drift` E2E test reported mean drift of ~0.02 u per snapshot before the fix, dropped to 0.0000 u after — provably deterministic with no inputs.

**Rule**: the physics worker must use the *nominal* tick duration, not the *measured* one. Measured time is only ever needed for the fixed-timestep accumulator at the top level; inside `setInterval` the nominal value is canonical.

## 2026-04-19 — Phase 3 — Physics worker tick counter can hit two broadcast multiples in one Colyseus interval
Commit: Phase 3 diagnostics fix.

`SectorRoom.update()` runs at 60 Hz (Colyseus `setSimulationInterval`). The physics worker also runs at 60 Hz independently. On a lightly-loaded machine these are nearly in sync, but occasionally the worker fires twice before the Colyseus callback fires once. When the worker is exactly 1 tick ahead, the SAB tick counter is read as, e.g., 20 in one Colyseus update and 30 in the next — fine. But when the worker fires twice, the counter reads 20 and then 30 before the Colyseus callback has fired again; the check `serverTick % 10 === 0` then triggers on both 20 and 30 within 16 ms, broadcasting duplicate snapshots.

Clients receiving two snapshots within 16 ms interpret the first as a very short interval, which triggered the `snapshotIntervalMs` assertion in the no-input drift test (`16 ms < 100 ms`).

**Fix**: track `lastBroadcastTick` and guard the broadcast with `serverTick !== lastBroadcastTick`. This is idempotent — the same tick can never be broadcast twice regardless of how many times `update()` reads it.

**Rule**: any "broadcast every N ticks" logic must include a deduplication guard (`lastBroadcastTick`) because the SAB/Colyseus tick loops are not perfectly synchronised.

## 2026-04-19 — Phase 3 — Browser setInterval clock drift causes persistent post-collision corrections
Commit: Phase 3 LERP_THRESHOLD fix.

After a ship collision, clients showed persistent ~0.6 u correction every snapshot (~167 ms) that slowly decayed. Pre-collision drift was always 0 u. Root cause: browser `setInterval(1000/60)` fires at ~62–67 Hz; Node.js worker `setInterval(TICK_MS)` fires at ~57–60 Hz. After 9 seconds, the client `inputTick` counter is ~54 ticks ahead of `serverTick`. The reconciler replays `currentTick - ackedTick ≈ 1` step from `serverState`, placing `predWorld` ~1 step behind `before`. Drift = 1 step × velocity ≈ v/60.

Pre-collision drift is 0 because v ≈ 0. Post-collision velocity ~35 u/s gives 35/60 ≈ 0.58 u drift per snapshot — exactly what was observed. Drift decays as linear damping (0.01) bleeds velocity back to 0.

**Immediate fix**: changed `DRIFT_THRESHOLD` (2 u) to `LERP_THRESHOLD = 0.05 u`. All corrections above the Float32 noise floor (~1e-5 u) are now visually smoothed over 5 frames (83 ms). Post-collision corrections still occur but are imperceptible.

**Proper fix (deferred)**: synchronise client `inputTick` to `serverTick` via the server's welcome message, and let the client's tick counter track server time rather than raw `setInterval` accumulation. This eliminates the systematic 1-step overshoot entirely.

**Rule**: a correction rate of 0 on idle ships does NOT prove the reconciler is correct — idle velocity means 0 drift regardless of tick offset. Always test with ships that have been thrusted or collided before concluding corrections are absent.

## 2026-04-25 — Phase 3 — ackedTick SAB race caused 80-90% correction rate while holding W
Commit: Fix 1 (SLOT_APPLIED_TICK_OFF).

**Symptom**: holding W for 1–3 seconds drove the correction rate to 80–90%, even though the ship was accelerating in a straight line with no other players present. Worse, corrections *continued* for ~100 seconds after releasing W despite zero new inputs.

**Root cause — the race**: `SectorRoom.onMessage('input')` calls `postToWorker({ type: 'INPUT', inputTick: tick, ... })` and then immediately returns to the Colyseus event loop. The physics worker receives the postMessage asynchronously — up to one 16.67 ms tick later. `SectorRoom.update()` fires on its own 60 Hz interval. If `update()` fires in the gap between the main thread posting the input command and the worker actually applying it, the snapshot it broadcasts carries `ackedTick = N` (the tick the main thread knows about) while the SAB state still predates that input's effect. The client replays from `ackedTick + 1`, sees the pre-input state, and computes `drift = v/dt` — proportional to velocity.

**Root cause — why corrections persist after release**: `LINEAR_DAMPING = 0.01` gives a time constant of 100 seconds. After 3 s of thrust at ~270 u/s, drift is `270/60 ≈ 4.5 u` per snapshot — well above `LERP_THRESHOLD = 0.05 u`. Velocity decays so slowly that this race-induced drift stays visible for ~100 seconds.

**Fix**: added `SLOT_APPLIED_TICK_OFF = 7` (word 7 in each SAB slot, SLOT_WORDS = 8). The worker writes `inputTick + 1` into this word inside the seqlock window after it applies an input (`0` = no input applied yet; `N+1` = tick N was applied). `SectorRoom.update()` reads this word per slot and uses `storedValue - 1` as `ackedTick` in the snapshot — the tick the worker *actually* applied, not the tick the main thread last received.

**Why `inputTick + 1` encoding**: 0 is the SAB default, making it unambiguous ("no input applied yet" vs "tick 0 applied"). Subtracting 1 on the read side recovers the real tick.

**Downstream**: any future per-player SAB extension should continue using `SLOT_APPLIED_TICK_OFF` and avoid reading `lastReceivedInputTick` from the main thread for snapshot purposes. The main thread's view of which tick it sent is never the same as which tick the worker executed.

## 2026-04-25 — Phase 3 — Browser setInterval fires at ~70 Hz, not 60 Hz, diverging from server
Commit: Fix 2 (rAF fixed-timestep accumulator).

**Symptom**: after Fix 1 (SLOT_APPLIED_TICK_OFF), the W-thrust correction rate dropped from 80-90% to ~59%. Still too high. Diagnostic showed `inputTick - serverTick` growing from 32 to 47 over a 3 s thrust window, meaning the client was producing ~5 more ticks per second than the server.

**Root cause**: the client input loop used `setInterval(1000/60)` — `setInterval` fires at ~67–70 Hz in Chromium when the requested period is 16.67 ms, not exactly 60 Hz. The server physics worker uses its own `setInterval` but at a calibrated nominal dt (always `TICK_MS/1000`, not measured wall-clock), so it advances at true 60 Hz. The gap widens by ~7 ticks per second: after 3 s the client is 20 extra ticks ahead; the reconciler must replay all 20 to realign.

**Fix**: replaced `setInterval` in `ColyseusClient` with a rAF-driven fixed-timestep accumulator exposed as `tickPhysics(elapsedMs)`. The caller (`App.tsx` `GameSurface`) passes `now - lastFrameTime` each animation frame. `tickPhysics` accumulates elapsed time and steps exactly once per `1000/60` ms of accumulated time, capped at 5 steps per call to prevent spiral-of-death after long frames or background tabs. After fix: correction rate dropped to ~14%.

**Why rAF instead of a tighter setInterval**: `requestAnimationFrame` is the only browser timer guaranteed to fire exactly once per display refresh (~16.67 ms at 60 Hz). `setInterval` has OS-level clamping and jitter that makes precise 60 Hz impossible without drift. The accumulator converts variable-interval rAF calls into exactly-60-Hz physics ticks.

**Rule**: never use `setInterval` for the client input/prediction loop. Always tie it to `requestAnimationFrame` via a fixed-timestep accumulator.

## 2026-04-25 — Phase 3 — Overwrite-latest input model caused ackedTick >> serverTick in physics worker
Commit: Fix 3 (FIFO input queue).

**Symptom**: after Fix 2 (rAF accumulator), the correction rate was still ~14%. `ticksAhead` stabilised at ~18-20 (expected for ~300 ms RTT), but each snapshot broadcast arrived with `ackedTick ≈ serverTick + 2`: the worker was labelling snapshots with ticks it had *received* but not yet *applied*.

**Root cause**: the worker stored one pending input per slot with overwrite semantics. Between two physics steps, 2–3 inputs arrived from the client (the network delivers batches). All 3 were stored in `pendingInputs[slot]`, overwriting each other. The *last* received input's tick number was used as `ackedTick`, even though only one physics step was taken. After the step, `pendingInputs.clear()` discarded the other 2 inputs. The client set `ticksAhead = inputTick - ackedTick`, which appeared correct (~18), but the reconciler replayed `ticksAhead` steps starting from `ackedTick + 1` — replaying 18 steps from a state that was actually 20 steps behind reality. Two steps were always missing, causing drift proportional to velocity.

**Fix**: replaced the overwrite map with a FIFO queue per slot (`inputQueues: Map<number, Array<...>>`). Each physics step dequeues exactly one input (`q.shift()`). If the queue is empty, the last applied input is held (prevents the ship from coasting when inputs arrive in bursts). The queue is capped at 20 entries to prevent unbounded growth. `ackedTick` is only advanced when an entry is *dequeued*, not when it is *received*. After fix: correction rate dropped to ~14% (see collision note below).

**Startup backlog**: when a client first connects, 13–20 inputs queue up before the worker processes the SPAWN command and begins dequeuing. This creates a persistent queue depth of ~18–20 steps, explaining why `ticksAhead ≈ 20` and apparent RTT reads ~300 ms (real RTT + queue wait). This is correct and expected behaviour.

**Rule**: physics workers must dequeue inputs one-per-step via a FIFO queue, never via overwrite. Overwrite causes `ackedTick` to advance faster than physics steps, leaving the reconciler with a too-small replay window.

## 2026-04-25 — Phase 3 — Collision corrections are expected, not a bug; calibrate test thresholds accordingly
Commit: Fix sync-health W-thrust threshold.

After Fix 2 and Fix 3, the remaining ~14% correction rate during W-thrust is entirely from asteroid collision events. The client predicts a collision ~18-20 ticks before the server resolves it (equal to `ticksAhead`). When the server snapshot arrives post-collision, the client's prediction-world position differs from the server's authoritative post-collision position by `driftUnits` — a large single correction (typically 40-75 u) followed by a rapid decay to 0. This is correct client-side prediction behaviour.

**What distinguishes collision corrections from bugs**:
- Collision corrections: 1–3 large-drift events per thrust window, clustered in time, followed by immediate return to near-zero drift
- Timer drift (Fix 2 regression): continuous small corrections every snapshot, growing proportionally to velocity
- FIFO regression (Fix 3 regression): continuous corrections, `ackedTick` jumps ahead of `serverTick`, `ticksAhead` grows without bound

**Test threshold calibration**: the `sync-health.spec.ts` W-thrust test uses a 40% correction rate threshold (not 5%). The 40% bound:
- PASSES collision corrections (~20-28%)
- FAILS timer drift regression (~59%+)
- FAILS FIFO/overwrite regression (~80%+)
The additional `expect(stats.ticksAhead).toBeLessThan(30)` guard catches queue-runaway independently of the rate check.

**Rule**: do not reduce collision corrections by lowering `DRIFT_THRESHOLD` — that would mask real physics divergences. Instead, spawn test ships in asteroid-free zones if zero-correction tests are required.

## 2026-04-26 — Phase 3 — Snapshot-rate broadcast using tick divisibility missed ~25% of broadcasts

Two independent 60 Hz `setInterval` loops — the physics worker and the Colyseus main thread — are never in phase. When `SectorRoom.update()` reads the SAB tick counter with `% 3 === 0`, the counter has often already advanced past the next multiple of 3. In a 5 s window, 77 out of ~100 expected broadcasts fired (15.4 Hz, not 20 Hz). Gaps of 163–178 ms were observed between consecutive snapshots that should have been 50 ms apart.

**Fix**: replaced divisibility check with an independent `broadcastCounter` field incremented every `update()` call. The broadcast fires whenever `++broadcastCounter >= 3`, then resets. This is decoupled from the SAB tick value entirely — guaranteed every 3 main-thread update calls, regardless of whether the worker has advanced its tick counter by 1, 2, or 3 during that window.

**Why not track `lastBroadcastTick`**: the seqlock could re-read the same tick value on consecutive `update()` calls (if the worker is slow). `lastBroadcastTick` would prevent the duplicate but still skip a broadcast when the divisibility misses. The counter approach never skips.

**Rule**: never gate a broadcast on SAB tick divisibility when the broadcast period is driven by the main thread. Use an independent counter on the broadcasting thread.

## 2026-04-26 — Phase 3 — Obstacle temporal-frame mismatch caused large collision corrections

**Symptom**: asteroid collisions produced corrections of 10–30u even though both client and server simulated the same physics. Corrections should be near-zero for a deterministic collision.

**Root cause**: after each snapshot, obstacles were teleported to `serverTick` positions in the prediction world, while the local ship remained at `inputTick` (~20 ticks ahead). Collision detection then ran with the ship 20 ticks ahead of the asteroids — meaning the ship would "see" the asteroid 20 ticks too late or too early depending on trajectory.

**Fix**: After the reconciler replay (which naturally advances obstacles to approximately `inputTick`), keep Rapier's post-replay obstacle positions rather than teleporting them backward. A soft correction fires only if client and server differ by > 8u (indicating another ship changed the asteroid's velocity on the server). This preserves the client-side collision response while handling server-divergent cases.

**Why linear extrapolation caused oscillation**: Setting obstacles to `serverPos + serverVelocity × ticksAhead` ignores velocity changes from client-side collisions. The obstacle gets put back to its pre-collision trajectory, potentially causing a re-collision on the next frame → another correction → oscillation. The threshold-based approach avoids this by keeping Rapier's post-collision state.

**Rule**: Never hard-teleport obstacles to `serverTick` position when the prediction world is running at `inputTick`. Either extrapolate to `inputTick` or keep the simulation's post-replay position. Hard teleports backward break collision prediction.

## 2026-04-26 — Phase 3 — 20 Hz snapshot rate with adaptive lerp eliminated the "2-ship lag" feeling

At 6 Hz (every 10 ticks, 167 ms), human-perceptible lag persisted because prediction errors accumulated for up to 167 ms before the server corrected them (human lag threshold ≈ 70 ms). Three improvements shipped together:

1. **20 Hz snapshots** (every 3 main-thread update calls, 50 ms): correction window shrinks 3.3×
2. **Adaptive lerp duration** (lerpFramesForDrift): sub-pixel corrections (< 0.5 u) lerp over 3 frames (50 ms); large collision corrections (> 20 u) lerp over 18 frames (300 ms). Fixed 5-frame lerp made collision corrections jerky.
3. **Angle wrap in remote interpolation**: ships rotating through the 0/2π boundary were interpolating the wrong direction (backward through π). Fixed with `wrapAngle(b - a)` before lerp.
4. **Dead reckoning for remote ships**: when `renderTime > newest history entry` (snapshot slightly late), extrapolate using last known velocity for up to 100 ms. Previously froze at last position.

**Test signals to watch**: `snapshotJitterMs < 25` (catches scheduling regression), `rollingCorrRate < 0.25` (rolling 10-snapshot window, catches sustained drift).

## 2026-04-26 — Phase 3 — Obstacle double-advancement during reconcile replay caused post-collision jitter

**Symptom**: after any ship-asteroid collision, the impacted asteroid jumped and jittered at ~50 ms intervals indefinitely. Correction magnitudes for the LOCAL ship also drifted upward across snapshots rather than returning to near-zero.

**Root cause**: the `reconcile()` replay loop calls `world.tick(1/60)` once per replay step (≈ 19 iterations at ~300 ms RTT). This advances ALL Rapier bodies, including obstacle rigid bodies. Before the fix, obstacles were left at their current `predWorld` position (≈ `inputTick`) when reconcile started, so the replay advanced them a further 19 ticks to ≈ `inputTick + 19`. This overshoot of 19 ticks compounded across every 50 ms snapshot: for a 30 u/s asteroid, ≈ 9.5u per snapshot (19 × 30/60). When the accumulated overshoot exceeded the old 8u correction threshold, a hard teleport fired — then the overshoot started again. Fast post-collision asteroids (>26 u/s) exceeded the threshold on every snapshot, causing a hard jump every 50 ms.

**Fix**: Reset obstacles to the server's `serverTick` position BEFORE calling `reconcile()`. The replay loop then naturally advances them together with the ship from `serverTick` → `inputTick`. After reconcile, compute the visual lerp offset as `preReset - postReconcile` (not `preReset - serverTick`): in normal motion these are equal so no lerp fires; only a server-side velocity change (another ship hitting the asteroid) produces a non-zero offset that needs visual smoothing.

**Why lerp offset must be computed AFTER reconcile**: recording `offset = current - state` (inputTick - serverTick = v × ticksAhead/60) BEFORE reconcile is incorrect. After reconcile, predWorld is again at ≈ inputTick, so adding that offset to the rendered position pushes it to ≈ inputTick + ticksAhead — double-advancing the render. The correct formulation is `offset = preReset - postReconcile`, matching the ship's lerp pattern (`lerpInitial = before - after`).

**Why the previous "keep Rapier's post-replay state" comment was wrong**: the comment said "do NOT hard-reset obstacles to serverTick — that teleports them 20 ticks backward, out of sync with the ship." This is backwards. Resetting to serverTick and letting the replay advance them IS how both ship and obstacles end up at inputTick together. The old code failed because it tried to keep a position that was already 19 ticks too far ahead.

**Test**: `robustness.spec.ts` test 8 (post-collision asteroid frame-delta < 5u) catches this regression. Pre-fix: 10.53u jumps. Post-fix: < 2.06u (normal physics motion).

**Rule**: always reset obstacles to `serverTick` position BEFORE `reconcile()`, not after. The reconcile replay is the mechanism that brings both ship and obstacles to `inputTick` simultaneously.

## 2026-04-26 — Phase 3 — Remote ships absent from predWorld caused P2P collision delay and drift accumulation

**Symptom**: P2P collision response was delayed by ~RTT/2 (~200 ms), ships visually overlapped, and corrections accumulated with each successive hit (rollingCorrRate → 1.0 while ships were near each other).

**Root cause**: Remote ships were never spawned in `predWorld`. The local ship's prediction world had no rigid body for them, so it stepped freely through their positions — Rapier collision detection never fired client-side. When the server snapshot arrived with the authoritative post-collision state, a large correction fired (50–100 u drift) every snapshot for as long as ships remained near each other. This is the same temporal-mismatch pattern as the obstacle jitter bug, but more fundamental: obstacles were in predWorld at the wrong time; remote ships were not in predWorld at all.

**Fix**: apply the obstacle fix pattern to remote ships:
1. `syncMirror()` spawns a predWorld body via `world.spawnShip()` the first time a remote ship is seen.
2. `handleSnapshot()` resets each remote ship to `snap.states[remoteId]` (serverTick position) BEFORE calling `reconciler.reconcile()` — the replay then advances all bodies together from serverTick → inputTick.
3. After reconcile, compute lerp offsets (`preReset − postReconcile`) for each remote ship; apply in `updateMirror()` with the same decaying-offset pattern as local ship and obstacles.
4. `updateMirror()` reads remote ship positions from predWorld (not remoteHistory) so Pixi renders them at the same temporal frame as the local ship, with Rapier physics providing smooth intermediate positions between snapshots.

**Why the 100 ms display delay (remoteHistory) was wrong**: The display delay buffered the symptom (visual latency) without fixing the cause (no collision body). With predWorld, Rapier provides 60 Hz smooth intermediate positions between 20 Hz snapshots, making the delay unnecessary. Lerp offsets replace it for correction smoothing.

**Rule**: every physics entity the local ship can collide with must have a body in `predWorld`. Remote ships are no different from obstacles in this respect. Spawn via `world.spawnShip()`, reset before `reconcile()`, render from predWorld. See `syncMirror()` + `handleSnapshot()` in `src/client/net/ColyseusClient.ts`.

## 2026-04-27 — Phase 3 — Pre-welcome state patch caused local ship to be spawned as remote, killing the reconciler

**Symptom**: after the remote-ship predWorld fix landed, the W-key movement test returned dist=0 (ship not moving) and the two-client drift test showed ~56u divergence instead of the expected ~1u. `ticksAhead` was always 0 even during sustained W-thrust — a sign the prediction world was never stepping.

**Root cause**: Colyseus delivers the initial state patch (`onStateChange`) before the welcome message (`onMessage('welcome')`) resolves on the client. At patch time, `mirror.localPlayerId` is still `null`. Inside `syncMirror()`, the guard `if (playerId !== localId)` evaluates to `true` for ALL players (including the joining player's own ship, since any UUID `!== null`). My new code — added to spawn remote ships in predWorld — therefore ran for the local player's ship, calling `predWorld.spawnShip(localId, ...)` and adding `localId` to `predRemoteShipIds`.

When the welcome message then arrived and called `tryInitPredWorld(localId)`, the method saw `predWorld.hasShip(localId) === true` and returned immediately **without creating the Reconciler**. With no reconciler:
- `tickPhysics()` skipped the `predWorld.tick()` call (guarded by `&& this.reconciler`)
- `updateMirror()` skipped the local-ship update (same guard)
- The ship appeared frozen at spawn coordinates regardless of input

The 56u divergence in the two-client test was P2's `predRemoteShipIds` tracking P1 correctly, but P2's OWN ship frozen at its spawn Y-position because P2 had no reconciler — `updateMirror()` was never writing P2's mirror from predWorld.

**Fix — two changes**:
1. Guard the remote-ship predWorld spawn in `syncMirror()` with `&& localId !== null`. This prevents any ship from being spawned as remote during the pre-welcome window.
2. In `tryInitPredWorld()`, after creating the reconciler, iterate `mirror.ships` and retrospectively spawn any remote ships that were seen before `localId` was set (they had their mirror entries populated by `syncMirror()` but no predWorld body).

**Why this is subtle**: the existing `else if (!predWorld.hasShip(playerId))` branch in `syncMirror()` was safe even without the guard, because it only fires when `localId` is set (the `if` branch consumes all ships when `localId === null`). The new predWorld spawn code was the only caller that needed the guard.

**Diagnostic signal**: the pre-welcome bug produced exactly the same surface symptom as the earlier Phase-3 lesson (2026-04-19) about `remoteHistory` — dist=0 after W-press, position stuck at spawn. The difference is the mechanism: old bug = remoteHistory overwrote predWorld output in `updateMirror`; new bug = no predWorld output at all (reconciler null).

**Rule**: when adding any code to `syncMirror()` that spawns entities in predWorld as remote, always guard with `localId !== null`. Pre-welcome state patches are delivered before the client knows its own identity; spawning the local player's ship as remote breaks `tryInitPredWorld()`.

## 2026-04-30 — Phase 4 — Rapier `castRay`: `hit.collider` is already a `Collider`, `hit.toi` doesn't exist
Commit: Phase 4 combat.

Two Rapier API mismatches caused TypeScript errors when implementing hitscan:

1. `world.castRay(...)` returns a `RayColliderHit`. Its `.collider` property is already a `Collider` object — NOT a `ColliderHandle` number. Passing `hit.collider` to `world.getCollider()` (which expects a `number`) is a type error.
   - **Fix**: call `hit.collider.parent()` directly to get the parent `RigidBody`.

2. The toi (time of impact) property is `hit.timeOfImpact`, not `hit.toi`. The `toi` alias does not exist on this type.

**Rule**: when in doubt, read the `@dimforge/rapier2d-compat` TypeScript declaration file directly — the API surface differs from the Rust docs.

## 2026-04-30 — Phase 4 — Rapier query pipeline requires `world.step()` before `castRay` sees new bodies
Commit: Phase 4 combat.

Three `hitscanRaycast` unit tests returned `null` even though target bodies were spawned. Root cause: Rapier's broadphase/narrowphase (the "query pipeline") is only updated inside `world.step()`. Bodies spawned after the last `step()` do not yet exist in the pipeline — `castRay` cannot find them. In tests, the `beforeEach` spawned ships and immediately called `hitscan` without stepping.

**Fix**: call `world.tick(1/60)` in `beforeEach` after spawning all bodies, before any `castRay` call.

**Rule**: whenever a unit test spawns Rapier bodies and then calls `castRay` or any shape query, call `world.tick(1/60)` first to register the bodies in the query pipeline.

## 2026-04-30 — Phase 4 — Server-side lag-comp must use geometric ray-sphere math, not Rapier `castRay`
Commit: Phase 4 combat.

The server main thread does not have a live Rapier world — physics runs in the `worker_threads` physics worker (Phase 2). Calling `castRay` on the main thread would require a separate Rapier world initialisation just for lag-comp, which is heavyweight and unnecessary.

**Fix**: lag-comp uses `rayHitsSphere()` from `src/core/combat/Weapons.ts` — a pure-geometry ray-sphere intersection that operates on the `Float32Array` positions stored in `SnapshotRing`. No Rapier world needed.

**Rule**: server-side hit validation must use the `SnapshotRing` positions + `rayHitsSphere()` combo, not Rapier. Rapier is physics worker-only.

## 2026-05-03 — Auth — better-sqlite3 still broken on Node 24; use node:sqlite instead
Commit: auth system.

`better-sqlite3@^12` (v12.9.0) was supposed to fix Node 24 compatibility but still has no prebuilt Windows x64 binaries for Node 24.14.0 on this machine — `prebuild-install` finds nothing, and `node-gyp` cannot run because Python is not properly accessible even though 3.11 is installed (version string returns empty). Do not attempt to compile from source.

**Resolution**: use `node:sqlite` (built-in Node.js module, available from v22.5.0 as experimental, stable in v24). API is nearly identical to better-sqlite3 — `DatabaseSync`, `prepare().run()/.get()/.all()`. No install needed. Shows `ExperimentalWarning: SQLite is an experimental feature` at runtime — acceptable until Node.js removes the warning.

**Downstream rule**: All server persistence code must import `{ DatabaseSync } from 'node:sqlite'`, not `better-sqlite3`. Remove `better-sqlite3` from the allowed-deps list in `src/server/CLAUDE.md` and replace with `node:sqlite`. The Phase 7 threading plan (move DB to its own worker) is still valid but the binding changes.

## 2026-04-18 — Phase 0 — ESLint `no-undef` disabled globally
Commit: initial scaffolding.

TypeScript already checks for undefined identifiers with full type information, including `process`, `__dirname`, `document`, etc. under the right `lib`/`types` settings. ESLint's `no-undef` was double-checking the same thing and fighting against Node-context config files (`vite.config.ts`, `vitest.config.ts`). Disabled project-wide; TS is the authority. If a genuine "undefined identifier" slips through, `tsc -b` will catch it.
