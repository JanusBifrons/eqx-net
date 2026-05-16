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

## 2026-05-11 — Multi-mount refactor — six lessons in one session

Commits: `47ff0be`..`a73a2a9` (multi-mount/turret refactor Phases 0–4c).

Six gotchas surfaced while shipping ~20 commits on this branch. Future
sessions extending the combat surface will hit these unless they're
documented here.

### 1. Physics-worker `setImmediate(loop)` busy-poll pegs one core per worker

The 60 Hz tick loop in [src/core/physics/worker.ts](../src/core/physics/worker.ts)
originally re-scheduled via unconditional `setImmediate(loop)`. That
fires the callback as soon as the event loop is idle — between the
actual 16.67 ms physics steps it spins **millions of times per second**
checking `now >= nextTickAt`. **One core per worker × 7 galaxy sectors
= ~700 % parent-process CPU** at idle, which starves the main-thread
Colyseus event loop and inflates WebSocket send latency.

The pre-existing comment warned about `setInterval(16.67)` quantising to
~15.6 ms on Windows. That made the original author choose `setImmediate`
for precision — but the same author didn't realise `setTimeout(loop, 1)`
on Node-Windows doesn't have the quantisation problem: Node's libuv
calls `timeBeginPeriod(1)` whenever timers are pending, so the
multimedia clock runs at 1 ms resolution and `setTimeout(1)` fires
within ~1 ms.

**Fix:** `setImmediate(loop)` ONLY after stepping (so a post-GC backlog
drains in one event-loop turn); when `nextTickAt` is still in the
future, `setTimeout(loop, 1)`. Empirically: 700 % → 122 % parent
CPU, per-sector tick rate 60.08 Hz (target 60, measured via
`/dev/events?tag=tick_budget` cadence over 71 s, 500-event window).

Forbidden alternatives: `setInterval(16.67)` (quantises);
`setImmediate(loop)` unconditional (busy-poll). See the block comment
above `TICK_MS_HR` in worker.ts for the full incident write-up.

### 2. Stale browser tabs masquerade as server lag

Mid-session, the phone's mobile-Chrome tab had been through hours of
Vite HMR cycles + multiple WebSocket reconnects (the server got
rebooted ~8 times). The TAB itself was degraded — zombie listeners,
leaked Pixi state, queued frames. Symptoms looked like server lag:

- `rttMs: 3717` (sustained for minutes)
- `snapshotIntervalMs: 105.9 ≈ snapshotJitterMs: 105.8` — the matching
  numbers mean snapshots aren't arriving at a steady cadence but in
  **bursts** with the largest gap = whole interval. Receiver-side
  stalls, not sender-side cadence problems.
- `client/raf_gap: 23 events in a 3.6 s capture window` — the
  smoking gun. The browser's `requestAnimationFrame` is repeatedly
  stalling. Server can be perfect; if the tab can't process frames,
  RTT goes through the roof.
- Server-side `tick_budget`: ~0.1 ms total per tick, zero hitches,
  zero GC pauses. The server was healthy throughout.

**Force-closing the tab + reopening on the SAME server code dropped
RTT instantly from 3717 ms → 190 ms.** It was never a server bug.

**The misdiagnosis cost:** I'd committed a CPU fix mid-window, watched
RTT climb (798 → 934 ms), reverted the fix — but the tab kept
degrading and RTT continued climbing to 3717 ms on the reverted code.
I'd attributed worsening lag to my fix; in fact the fix was correct
and the tab was the variable.

**Rule:** before attributing lag to a recent commit, rule out
client-side state. Check for `raf_gap` events in the diag's
`raf.ndjson`. If present + tick_budget healthy, force a fresh tab.

### 3. Don't attribute lag to your recent commit without isolating the variable

Corollary of #2. I reverted commit `1d5fa7d` (CPU fix) at `088cd2b`
based on diag readings that correlated with the fix's timeline. They
didn't actually correlate causally — the tab was degrading
monotonically. The revert just put 700 % CPU back, which was an
orthogonal regression on top of the still-degrading tab.

When debugging a moving baseline, the only valid signal is
**A→B→A→B alternation**: apply, measure, revert, measure, apply,
measure. A single A→B → "broke" → revert is unfalsifiable.

### 4. Per-frame `mirror.ships.set()` rebuild wipes preserved fields silently

`ColyseusClient.updateMirror()` runs every render frame and **rebuilds
each ship's `mirror.ships` entry from scratch** from `predWorld` +
reconciler lerp offset. Non-spatial fields (`kind`, `displayName`,
`mountAngles`) have to be explicitly preserved via
`...(prev?.X ? { X: prev.X } : {})` or they get wiped.

**Symptom:** the local player's interceptor had two correctly-rotated
wing beams from the ghost projectiles (which carry their own pre-
computed endpoints) but the continuous `liveBeam` rendered straight
forward — because the renderer re-derives beam direction from
`mirror.ships.get(localId).mountAngles` each frame, and that field
was being wiped between `tickLocalMountAim`'s write and the
renderer's read.

**Fix:** the per-frame rebuild now spreads `prev?.mountAngles`
alongside `prev?.kind` and `prev?.displayName`. **Future Claudes
adding any new non-spatial field to `ShipRenderState` must add it to
both rebuild sites** (`updateMirror` local-ship path AND remote-ship
path) or it'll silently disappear at 60 Hz.

### 5. AI fire gate must widen to cover turret arc

`HostileDroneBehaviour.tickCombat`'s body-aim fire gate was a flat
14 ° / 26 ° point-blank, regardless of how far the turrets could
swing. For multi-mount drones this suppressed fires the turret AI
would have resolved as hits — surfaced as the user-reported "AI
doesn't shoot sometimes when I'm in range" symptom on Phase 4c.

The gate now widens by the kind's widest rotating mount's half-arc:

- Interceptor wings ± π/6 → tolerance 14 ° + 30 ° = 44 °.
- Gunship rear ± π/2 → tolerance 14 ° + 90 ° = **104 °** (drone fires
  even when target is almost directly behind it — its rear turret
  can swing that far around).
- Legacy single-mount kinds (zero arc) → unchanged.

Computed once at behaviour construction (from `kind.mounts`), so the
tick path stays allocation-free.

### 6. Sector boundary clamp + accumulated state = visible drone thrash

The pre-existing position-clamp backstop (commit `6953984`) teleports
any drone that drifts past `±10 000 u` back inside the playable bound.
With drone density accumulated across many sessions, ~20 drones per
sector ended up clustered against the wall, each clamping at ~5 Hz —
visible to the client as a 1737-unit median snap-per-frame on every
drone.

**Diagnostic signature:** `swarmSnapP50` in the tens of thousands of
units (vs ~5–20 in steady state) + `636 "drone position clamped to
bounds" warnings` in 4 s of server log.

**Cheap recovery:** `node scripts/reset-sectors.mjs` — wipes
`game_snapshots` so each sector re-seeds at its sunflower-spiral
defaults on next room creation. Keeps auth intact.

**Proper fix (deferred):** soften the clamp to reflect velocity
inward instead of pure teleport, OR harden the AI's patrol inward-
bias to be more aggressive near the bound. Either is a contained
edit to `HostileDroneBehaviour.tickPatrol` / the clamp invocation
site, but both can wait — the reset script unblocks testing.

### Bonus: Windows `Get-Process.CPU` aggregates across all threads

PowerShell's `.CPU` property is total CPU-seconds across **every
thread in the process**, including Node `worker_threads`. With the
physics worker spawned per sector × 7 sectors, a single PID can
show >700 % CPU on a multi-core machine without doing anything
genuinely wrong. Per-thread breakdown isn't available from
PowerShell — must instrument inside Node (`process.cpuUsage()`)
or use Windows perf counters.

---

## 2026-05-10 — Galaxy Map refactor — two Pixi maps, not one

Refactored both galaxy maps from SVG to Pixi. Two non-obvious findings:

1. **Pixi 8 `Container` has a public `destroyed: boolean` field.** Subclassing
   it and adding `private destroyed = false` for your own dispose-guard is a
   TypeScript visibility error (private member shadows a public base member).
   Use a different name (`disposed`) for the guard. Same trap will catch any
   future Container subclass.

2. **Two distinct maps, one transparent, one full-screen.** A single hex
   renderer was tempting but the modes pull in opposite directions: the
   in-game overlay (Map B) needs to be a screen-space layer on the **same**
   canvas as gameplay so non-hex pixels pass through to the viewport via
   Pixi's hit-testing (avoiding the DOM-canvas hit-test trap where a
   transparent canvas still blocks taps on its bounding rect); the standalone
   overview (Map A) wants its own `Application` + `pixi-viewport` for full
   drag/pinch/wheel pan & zoom on a 7-sector graph the player can roam.
   Trying to share a renderer between these two roles fights both. Two
   files, both consume `src/core/galaxy/galaxy.ts`, no inheritance.

The DI seam is `IRenderer.addOverlayContainer(unknown)` — typed as `unknown`
to keep `src/core` Pixi-free; `PixiRenderer` narrows to `Container` and
parents to `app.stage` **above** the viewport so the overlay doesn't pan/zoom
with the world camera.

Commit: pending — galaxy-map refactor branch.

---

## 2026-05-09 — Network-Feel — the paradigm gap: drone AI was server-only; client must run identical AI for collisions to align

After ~15 hours and 8 commits chasing per-symptom fixes (welford reset, tick-gate, lead-subtract, drone-unlock, display-delay), the user reported the felt experience hadn't materially improved. The honest answer was that every fix was treating a symptom of one underlying paradigm gap: **the client predicts the player ship's physics 1:1 with the server, but for drones it only had a velocity vector + dead-reckoning between snapshots**. Server applies AI thrust/torque every tick; client never did. So drone position diverged from server between every snapshot, collision happened at slightly different geometry on each side, and reconciler corrections perpetually re-opened.

The standard rollback-prediction paradigm is "everything you can interact with is simulated and rendered 1:1 client-side, and then if it goes out of step it corrects." For drones, only the *snap* part was happening; the *simulate* part was missing.

The fix (commit 31af74c) was structural, not parametric:
  - Moved `AiController` from `src/server/ai/` to `src/core/ai/` (it had no server-only dependencies — `AiIntentSink` was already abstracted)
  - The client constructs an `AiController` with a sink that calls `predWorld.applyImpulse('swarm-${id}', fx, fy, torque)`
  - On every binary-swarm packet, drones (kind=1) are registered with `HostileDroneBehaviour`; asteroids stay locked
  - The client's AI ticks once per input-loop iteration AND once per reconciler-replay tick, mirroring the server's per-step pattern
  - Critical determinism contract: the AI's player view must come from `predWorld.getShipState`, not `mirror.ships` — `mirror.ships` includes the reconciler's render-only lerp offset, which the server never sees. Using `predWorld` gives both sides the same authoritative-physics positions.

Verified by `tests/scenarios/clientAiDeterminism.test.ts`: two `AiController`s ticked through identical synthetic timelines produce **bit-identical** (fx, fy, torque) outputs. Locks the contract that any future drift in client-vs-server AI sync fails the test before merge.

User-reported result: "Best it's ever felt. Minor lag." After 15 hours of single-axis fixes, the structural fix was the one that actually delivered.

**Action item for any future client-prediction work**: when adding a new entity type that the local ship can interact with, default to **simulating it client-side with the same module the server runs**. Predicting only "kinematic from velocity + position" is what brought us here; the player can interact with it physically, so it has to be in `predWorld` and driven by the same intent generator.

**Distinguishing future occurrences of this anti-pattern**: any feature that
  - has authoritative server logic (combat AI, NPC pathing, environment events)
  - and produces forces or impulses applied to bodies the player can collide with
  - and runs at server tick rate
... must run client-side too, behind a contract / sink the client implements as "apply to predWorld."

Test coverage:
  - `src/core/ai/AiController.test.ts` — controller invariants (now in core)
  - `tests/scenarios/clientAiDeterminism.test.ts` — bit-identical output across two controllers
  - `tests/e2e/network-feel-combat.spec.ts` — end-to-end combat-feel regression lock

---

## 2026-05-09 — Network-Feel — server input queue drained inputs claiming future ticks, producing ~10 u correction bursts under network jitter

After the sector-handoff Welford reset shipped, the `srvTick − ackedTick = −37` saturation was gone but mobile cap `2026-05-09T08-34-31-317Z-66038n` still showed felt-jitter bursts: three episodes of 3–4 consecutive corrections each at ~10 u position drift, lerping smoothing them but the user reporting "warping, jitter, and issues at times." The data was suspicious — drift values within each burst were essentially identical (10.69 / 10.73 / 10.71 in burst 1; same shape elsewhere), zero angle drift, and `srvTick − ackedTick` would shift from the steady −2 to −6/−7 during the bursts. None of that is random noise; it pointed at a systematic mechanism.

**Root cause** in `src/core/physics/inputQueue.ts`. The pre-fix contract drained the queue greedily on every physics step:

```ts
if (queue.length > 0) {
  const entry = queue.shift()!;        // <-- no tick gate
  // apply, advance ack to entry.tick
}
```

When the client sent an input claiming clientTick X (with the natural prediction lookahead, so X > current serverTick), the worker dequeued and applied that input *at the current sim tick*, then reported `ackedTick = X`. The client then received a snapshot saying `serverTick = simTick, ackedTick = X` and locally interpreted that as "my input from clientTick X has been processed" — when in fact it had been processed at simTick `X − leadTicks` or so. The two diverged by exactly one input application, which is a thrust impulse worth of velocity ≈ ~3.3 u/tick × 3 ticks = ~10 u of position drift, sustained until network jitter cleared and the queue settled into 1-input-per-tick rhythm.

The signature: `ackedTick > serverTick` in the snapshot, drift values quantised to ~one-thrust-impulse worth, zero angle drift (symmetric since turn impulse is per-tick angular), bursts that resolve as the queue empties.

**Fix shipped**: tick-gated dequeue. `tickInputQueue` now takes a `currentTick` parameter and only drains when `queue[0].tick ≤ currentTick`. Future-claim inputs stay queued until sim tick reaches their claimed tick; the worker treats the slot as queue-empty in the meantime (re-applies held, ack += 1). Stale claims (claim < currentTick, e.g. a delayed retransmit) are still drained immediately — the input is better applied late than dropped, and out-of-order ack regression is already prevented by the existing `max(message.tick, prior ack)` rule.

**Why the held-ack-advance contract still works**: when the gate holds a future-claim input, semantically nothing has changed for the slot's physics (it's running on the held input). The synthesised ack increment by 1 is exactly the same signal the client expected from the held-empty case. When the gate finally opens and drains the future-claim, `entry.tick > prior ack` so the ack jumps to the message's claim — but at that point `currentTick = entry.tick`, so `serverTick == ackedTick` and there's no anomaly.

**Steady-state behaviour change**: under healthy network with 1 input per tick at claim = currentTick, ack now equals serverTick exactly. The pre-fix `serverTick − ackedTick = −2` (typical desktop steady state in cap `07-51-26`) becomes 0 after this fix. Reconciler replay-from-`ackedTick+1` then aligns precisely with what the client locally applied.

**Distinguishing future occurrences**: position-only correction bursts whose drift values are quantised in tight clusters (not random magnitudes), ack > serverTick in snapshots, drift values matching ~one input application's worth of velocity. If the bursts come back, the gate may have regressed or some other path applies inputs out-of-tick (e.g., an immediate-apply on first arrival, or a rollback-replay using wrong tick alignment).

Test coverage: `src/core/physics/inputQueue.test.ts` adds a `tick-gated dequeue` describe block covering the hold case, the steady-state ack-tracks-currentTick case, the stale-claim-drain case, and a multi-step batch-arrival scenario. The pre-existing held-ack-advance and out-of-order tests are updated to pass `currentTick` and continue to lock the 2026-05-06 contract.

---

## 2026-05-09 — Network-Feel — sector-handoff inherits polluted Welford / leadTicks state, saturates lookahead at the cap

After warping between sectors, every snapshot for the rest of the session reported `srvTick − ackedTick = −37` (rock steady), 60–70 % of snapshots produced a significant correction, and the local ship rendered ~600 ms ahead of the authoritative server state. The user described the symptoms as "ships miles off centre, going in circles, lost control." All of that is a single bug: the Stage 4 prediction-loop state survived the sector handoff.

**Pathology**: `_rttWelford`, `_lookaheadCtrl`, `_dropDetector`, `_anchorInitialised`, `lastSnapshotAt`, `_recentIntervals`, and `_recentCorrFlags` were all `readonly` fields on `ColyseusGameClient`, initialised once at construction. The `transit_ready` handler hot-swaps the room's WebSocket via `consumeSeatReservation` but reuses the same client instance, so those fields persisted unchanged across the 5+ s warp gap. The first wave of post-arrival snapshots had `intervalMs` back in the steady-state band [35, 75] ms — bypassing Stage 4 hotfix #3's gap-detection guard — but their `lastRtt` was contaminated by the handoff (clamped to 250 ms by Stage 4 hotfix #1, but still pushed). The surviving welford mean drifted up to ~250 ms, `mean + 2σ` saturated `CEILING_TICKS = 30` in `lookaheadController`, and `leadTicks` stayed pinned at the cap for tens of seconds while the welford slowly accumulated clean samples.

`leadTicks ≈ 30` + 6 ticks of natural in-flight = **client predicts ~36 ticks ahead** ≈ exactly the −37 offset every snapshot reported. With a 30-tick prediction window, the rendered ship is wherever it *will be* in 600 ms — for a turning ship that's "going in circles" (predicted position several rotations ahead) and "miles off centre" (predicted overshoot on thrust).

**Diagnostic captures**:
- `2026-05-09T07-49-57-470Z-81numi/` — 105 snapshots, `srvTick − ackedTick` distribution `{−37: 104, −38: 1}` (locked), 67 % correction rate. Captured immediately after a warp.
- `2026-05-09T07-50-26-478Z-krns0x/` — bimodal `{−37: 52, −18: 107}`. Welford slowly settling.
- `2026-05-09T07-51-26-622Z-wc5fm0/` — long after the same session, `{−15: 104, −16: 62, ...}`. Clean steady state.

The decay from −37 → −18 → −15 over ~30 s is the welford's natural mean drift back toward live RTT. Without a reset there's no fast-path back to clean.

**Fix shipped**: `ColyseusGameClient.resetPredictionState()` re-creates the welford, lookahead controller, drop detector, and rolling buffers; clears `_anchorInitialised` so the next snapshot seeds the clock anchor afresh; zeros `reconciler.lastRtt` (read by the welford push *one snapshot later* than it's computed, so a pre-transit value would otherwise re-poison the just-reset welford). Called from the `transit_ready` handler after `room.leave(true)` and before `consumeSeatReservation`. The fields had to lose `readonly` to be reassignable.

**Why Stage 4 hotfixes #1 and #3 didn't cover this**: hotfix #1 clamps individual sample magnitude (caps each `lastRtt` push at 250 ms). Hotfix #3 filters whole snapshots whose `intervalMs` is outside [35, 75] ms. Both work *during* a gap. Neither resets state *across* a gap. Once the wire returns to steady cadence, the clamped/filtered samples are gone but the polluted mean isn't — and a 250 ms-clamped sample still pulls the mean up if pushed.

**Action item**: any future state that contributes to the prediction window (welford, EWMA, spring controllers) MUST be either (a) explicitly reset in `resetPredictionState()` or (b) have a `// reason: this state is OK to survive a sector handoff because …` comment justifying the omission. The default for prediction state is "transient to the room."

**Distinguishing future occurrences**: `predStats.ticksAhead` stuck at the saturation point (~30 + leadTicks-floor of 6 = ~36) for many seconds, large `srvTick − ackedTick` mismatch, AND no actual network jitter (intervalMs around 50 ms median, no broadcast gaps). The signature is "the client predicts hard but the wire is fine."

Test coverage: `src/client/net/ColyseusClient.resetPredictionState.test.ts` locks the reset semantics. An E2E warp regression test (warp between sectors, assert `ticksAhead` settles ≤ 10 within ~1 s) is the proper invariant #9 satisfier and should be added when the warp path is wired into the e2e harness.

---

## 2026-05-08 — Network-Feel Stage 5 hotfix #4 — union-of-cadences breaks recipient-side intervalMs distribution

Stage 5's initial design tried to deliver "30 Hz close-tier ships, 20 Hz far-tier" by gating sends on `closeFires || farFires` where `closeFires = (broadcastCounter + closeOffset) % 2 === 0` and `farFires = (broadcastCounter + farOffset) % 3 === 0`. Each predicate alone produces a clean cadence (every 2nd or every 3rd tick). The union does **not**.

For any per-client offset combination, the union firing pattern over a 6-tick LCM window is `{0, 2, 3, 4, 6, 8, 9, 10, ...}` (or a phase-shifted version). The intervals between fires are `2, 1, 1, 2, 2, 1, 1, 2` ticks — i.e. **17 ms, 17 ms, 33 ms, 33 ms, 33 ms, 17 ms, 17 ms, 33 ms** at 60 Hz physics. The recipient receives bursts of two snapshots 33 ms apart, then back-to-back 17 ms intervals, then a 33 ms gap. Median = 21 ms, jitter = 40 ms.

This breaks downstream code in two ways:

1. **Reconciler lerp instability**. The reconciler's `lerpHalfLifeMs` is tuned around a steady ~50 ms cadence. Sub-frame intervals (17 ms) queue a new lerp before the previous one finishes, producing visible overshoot. Diagnostic capture `2026-05-08T19-30-14-034Z-zw6exn.json` showed a correction at t=12100 where the client predicted y=559, server pose was y=553, and the lerp landed at y=536 — overshot the target by 17 u in the **wrong direction**.

2. **Snapshot-interval EWMA pollution**. `snapshotJitterMs` jumped from 6.7 ms (steady-state Stage 4) to 39.6 ms (Stage 5 broken cadence). The Stage 4 Welford on RTT and the swarm-interp delay EWMA both feed off intervalMs assumptions; chronic jitter pushes their outputs into degenerate ranges.

**Why the unit tests didn't catch it**: 27 tests in `snapshotScheduler.test.ts` covered each predicate (`shouldBroadcastClose`, `shouldBroadcastFar`) in isolation. They all passed. The bug lives in **the union of two correctly-cadenced predicates seen at the recipient**, which no unit test asserted. The plan called for a `cadence-fairness.spec.ts` E2E test that would have measured recipient-side intervalMs distribution; I deferred it via Decision Log on the grounds that "the underlying math is unit-tested." The math was unit-tested; the union behaviour wasn't. The deferral was the bug.

**Fix shipped (hotfix #4)**: collapse to a single 20 Hz cadence — only `shouldBroadcastFar` gates sends, every alive ship is in every fired snapshot. Phase staggering (per-recipient farOffset), idle suppression, and lastInput omission stay. The 30 Hz close-tier idea is shelved until a single-cadence design (e.g. 30 Hz global with selective tier inclusion controlling which ships are in each snapshot) can be tested end-to-end.

**Action item**: any future "two cadences for different priority tiers" design MUST land with an E2E test asserting **recipient-side intervalMs distribution** before being merged. Unit tests on the predicates are insufficient — they prove the math, not the wire behaviour. Tracked as Stage 5b.

**Distinguishing future occurrences**: the symptom is `predStats.snapshotJitterMs` 5×+ higher than steady-state baseline AND `snapshotIntervalMs` median pulled below the broadcast cadence (21 ms in this case, pre-fix 50 ms). If those two hold, suspect a multi-cadence union bug.

---

## 2026-05-08 — Network-Feel Stage 4 hotfix #3 — Welford mean inflates under repeated Pattern A spikes despite the σ-clamp

Hotfix #1 capped each RTT outlier at 250 ms before pushing into Welford. That bounds `σ` (uniform-bound: σ ≤ ½ × range = 125 ms) but does **not** bound the *mean*. Each clamped sample still adds 250 ms into Welford's running sum. After a session with several Pattern A spikes, the mean has drifted upward — even though every sample was individually clamped.

In the user's third diagnostic (`diag/captures/2026-05-08T17-51-56-297Z-71krw1.json`):
- Live `rttMs = 83` (instantaneous, healthy)
- `rttMeanMs = 177` (Welford, drifted)
- `mean + 2σ ≈ 343 ms = 21 ticks` (`leadTicks` saturated near 22)
- After a collision: 50+ u position drift before the next snapshot corrected it (drift ≈ Δv × leadTicks × dt)

**Mechanism**: a Pattern A snapshot gap delivers one big-interval snapshot followed by 5–15 burst-recovery snapshots in rapid succession. The first snapshot's `lastRtt` = real-RTT + gap-duration (clamped to 250 ms by hotfix #1). Each burst-recovery snapshot's `lastRtt` is *also* contaminated — the input being acked was sent before the gap, so its `now - sentAt` reads as several hundred ms even though wall-clock RTT is now healthy again. Over 5 gaps in a 10 s session, that's ~50 contaminated samples × 250 ms each, dragging the running mean into the 150–200 ms range while live RTT was steady at 83 ms.

**Why hotfix #1's drop-count gate (initial attempt) wasn't enough**: the `dropDetector` uses a 10-snapshot sliding window. An 800 ms gap queues ~16 burst snapshots; the first 10 are filtered out, but snapshots 11–16 fall outside the window and get pushed. Six samples per gap × five gaps = 30 inflators that hotfix #1's clamp was happy to accept at 250 ms each.

**Fix shipped**: gate the Welford push on the snapshot's `intervalMs` being inside the steady-state cadence band `[35, 75]` ms (`STEADY_STATE_INTERVAL_MIN_MS` / `STEADY_STATE_INTERVAL_MAX_MS` in [src/client/net/ColyseusClient.ts](../src/client/net/ColyseusClient.ts)). Server broadcasts every 3 server ticks (50 ms nominal); real wall-clock jitter spreads this to roughly [35, 75] ms. Outside that range, the snapshot is part of a gap (huge interval) or burst-recovery cluster (tiny interval — burst snapshots arrive in rapid succession). Both classes have contaminated `lastRtt`. Skipping them keeps Welford tracking only clean steady-state samples.

**Why intervalMs and not drop-count**: intervalMs catches *both* sides of the spike (the gap-delivery interval AND each burst-recovery's tiny interval) without any sliding-window assumption. Burst snapshots arrive at ~12.5 ms intervals — the `< 35` ms guard rejects each one individually. No need to size a window to the worst-case gap length.

**Why this wasn't caught by hotfixes #1 + #2**: Stage 4.5's scenario harness only had a single-gap fixture. Hotfix #3's regression test (`tests/scenarios/regressions.test.ts → 'Hotfix #3...'`) uses an aggressive 5-gap × 800 ms scenario over 11.5 s — closer to a real combat-spanning Pattern A session. The pattern doesn't show up unless you inject several gaps and let burst-recovery samples accumulate.

**Distinguishing future occurrences**: the symptom is `predStats.rttMeanMs >> live rttMs` (e.g. 2× or more) WHILE `predStats.rttStdDevMs` is bounded (≤ 125 ms — the σ-clamp is doing its job). The combination of bounded σ but inflated mean is the signature; an uncontrolled σ would mean hotfix #1 has regressed. Cross-check the snapshot intervals over the affected window — if you see clusters of `intervalMs > 200` followed by `intervalMs < 30`, hotfix #3's filter is the right tool.

---

## 2026-05-08 — Network-Feel Stage 4 hotfix #2 — `inputTick` starvation under server burst-recovery on slow-rafTick devices

A second-order failure mode revealed by the same combat-test diagnostic that motivated hotfix #1 (`diag/captures/2026-05-08T16-12-02-930Z-z4ixt3.json`).

**Setup**: mobile device, rafTick at 10–15 Hz under load (vs. 60 Hz desktop baseline). 552 ms Pattern A inbound network gap. Server burst-sends recovery snapshots at ~30 Hz to catch the client up.

**The mismatch**: the client's input loop advances `inputTick` once per rafTick frame, capped at `MAX_CATCH_UP_TICKS = 4` per rafTick. Max sustained advance rate = `rafTickHz × MAX_CATCH_UP_TICKS`. The server's `inputQueue.ts` held-ack-advance contract (necessary for the Phase-3 reconciler to converge under client throttling — see 2026-05-06 entry below) advances `ackedTick` at the full server tick rate (60 Hz) regardless of how fast the client sends. On a 10 Hz rafTick × 4 catch-up = 40 Hz device, the client cannot keep up with the server during burst recovery — `ackedTick` outpaces `inputTick`.

**Symptom**: `ticksAhead = inputTick - ackedTick` crosses zero and goes negative. Captured numbers: `min=-26, max=34`. The reconciler's replay range becomes empty (`replayStart = ackedTick + 1 > currentTick = inputTick`), so reconcile resets predWorld to serverState (which is "in the future" of where the client thinks the ship is) without any compensating replay. Drift = pre-reset position − server position = many units, every snapshot, for the duration of the storm. Observed: 13 corrections per 500 ms, max drift 30 u.

**Fix shipped**: `recoverInputTickFromStarvation(inputTick, ackedTick, leadTicks)` in [src/client/net/inputTickRecovery.ts](../src/client/net/inputTickRecovery.ts). Called in `handleSnapshot` before reconcile. When `inputTick ≤ ackedTick`, snap forward to `ackedTick + leadTicks` (analogous to clockAnchor's > 200 ms hard-snap path). Re-anchor the wall-clock too so subsequent rafTicks don't try to catch up the gap we just skipped.

**Trade-off**: the snap loses replay-buffer entries between old and new `inputTick`. The server already synthesized acks for those ticks via held-ack-advance, so the inputs were never going to be physically meaningful client-side anyway — the snap is a "cleaner" version of state that was already broken.

**Why this wasn't caught earlier**: every Stage 0–4 unit test verified an *atomic operation* (Welford push, lookahead formula, drop-detection sliding window) but no test exercised the *system under stress* — slow rafTick + server burst + held-ack-advance. The class of pure-function tests cannot exercise this bug because it's an emergent property of multiple components interacting over time. **Action item**: build a scenario harness (`tests/scenarios/`) that takes a synthetic timeline (rafTickHz, RTT, gaps, snapshot patterns) and runs the client logic through it, asserting properties like "ticksAhead never goes negative" or "no correction > 50 u". Tracked as `plans/network-feel-roadmap.md` Decision Log → "Stage 4.5: scenario harness" follow-up.

**Distinguishing future occurrences**: in a diagnostic, `predStats.ticksAhead p95 < 0` OR `min < 0` is the symptom. Cross-check rafTick gaps in the eqxLogs (`logs.filter(l => l.tag === 'rafTick')`); rafTick gap > 50 ms (= < 20 Hz) on the affected window confirms.

---

## 2026-05-08 — Network-Feel Stage 4 — `Reconciler.lastRtt` is *not* a clean RTT signal

Stage 4's Welford-based `leadTicks = ceil((mean + 2σ) / FIXED_MS)` formula assumes the input RTT samples are clean. They aren't.

`Reconciler.lastRtt = now - ackedRec.sentAt` is a "time since input was sent" measure, not the true TCP RTT. When a snapshot is delayed by a Pattern A network buffer (inbound 500 ms+ stall), the next snapshot's `lastRtt` is computed from an `ackedTick` that was sent before the gap — so the apparent RTT is the gap delay PLUS the real RTT.

In a real diagnostic (`diag/captures/2026-05-08T16-00-51-212Z-k35x92.json`):
- Live `rttMs = 37` (instantaneous, healthy)
- `rttMeanMs = 300`, `rttStdDevMs = 249` (Welford, contaminated)
- `mean + 2σ = 798 ms = 48 ticks` → clamped to 30
- `ticksAhead` distribution: median 6, p95 47, max 47
- During combat: 137 u / 115 u position corrections cascade

**Mechanism**: a single 572 ms snapshot gap injected one 500+ ms RTT sample into Welford. Welford's `mean + 2σ` saturated the lookahead at the 30-tick cap. Client speculated 500 ms ahead of server. Combat predictions diverged. Reconciliation produced massive corrections.

**Fix shipped**: clamp RTT samples at 250 ms before pushing to Welford (`RTT_SAMPLE_CLAMP_MS` in [src/client/net/ColyseusClient.ts](../src/client/net/ColyseusClient.ts)). Real-world high-RTT clients (international, cellular) measure 100–250 ms cleanly; outliers past 250 ms are almost certainly snapshot-delay contamination, not signal we want feeding the prediction window.

**Why the clamp instead of a smarter signal**: a true ping/pong RTT measurement would be cleaner but adds round-trip messages and a separate channel. The clamp is one line and bounded — σ on a `[0, 250]` clamped stream is ≤ 125 ms by uniform-distribution bound, so `mean + 2σ ≤ 500 ms` and the lookahead can't saturate beyond ~30 ticks even under sustained outliers. If multi-second real RTTs appear, revisit.

**Distinguishing future occurrences**: the symptom is `predStats.rttMeanMs >> live rttMs` AND `ticksAhead` p95 sitting at the cap. If both hold, the Welford state has been polluted; check the most recent 600 snapshots for any with `intervalMs > 200`.

---

## 2026-05-08 — Network-Feel Stage 0 — Two diagnostic patterns that look identical from stats but have different root causes

While verifying Stage 0 of the network-feel roadmap (`plans/network-feel-roadmap.md`) the user captured two diagnostics that both looked like "lag spike" from `stats.snapshotJitterMs` and `stats.rollingCorrRate`. They had completely different root causes; future investigations should distinguish them in this order before reaching for a fix.

**Pattern A — Mobile-network buffering** (Android, regular `sector` room, sub-second event):

- `stats.snapshotIntervalMs` median ~50 ms; one or two outliers in the 400–600 ms range; everything else clean.
- `stats.rttMs` low (37 ms in the captured case).
- `serverEvents` `tick_budget` for the user's room: `avgMs.total < 0.4 ms`, `maxTotalMs < 4 ms`, `overBudgetCount: 0`. Server **healthy**.
- `serverEvents` `snapshot_broadcast` for the user's room: continuous ~50 ms cadence with no gap matching the client-side gap. Server **kept sending**.
- Client `rafTick` log: continuous through the gap (max gap matches normal cadence, not the snapshot gap). Client **kept rendering**.
- Client `inputSent` log: ticks continued during the gap. Client **kept transmitting outbound**.

⇒ Diagnosis: cellular/WiFi power-save buffered inbound WebSocket frames briefly. Server sent fine, client rendered fine — only the *inbound packet delivery* stalled. The user perceived a single ~0.5 s "stutter" with a small drift correction afterward.

Stages 4 and 6 of the network-feel roadmap absorb this case (Welford-based mean+2σ lookahead, drop-detection, conservative spring half-life on post-gap snapshots).

**Pattern B — Server CPU-bound + mobile main-thread freeze + TiDi non-engagement** (Android, `swarm-tidi` 4000-entity room, sustained):

- `stats.rttMs = 2416 ms`, `snapshotIntervalMs = 214 ms`, `ticksAhead = 46`, `rollingCorrRate = 0.9`.
- `stats.lastServerTick` lags the *server's actual current tick* by hundreds of ticks (capture showed 222 vs server-current 475 = ~4 s of unprocessed broadcasts).
- `serverEvents` `tick_budget` for the user's room: `avgMs.total = 11–12 ms` (under 16.67 ms ceiling) — but **`maxTotalMs = 50–94 ms`** with **`overBudgetCount = 11–14 / 60`**. SAB-read alone consumed 8.7 ms (52% of budget) for 3200 entities.
- Server-side broadcast rate measured from `snapshot_broadcast.ts` deltas: ~42 Hz wall-clock (i.e. simulation falling behind real time at the 0.7× TiDi floor).
- TiDi did **not** engage despite the chronic falling-behind, because the trigger watches `avgMs.total` which sits under the threshold. Spike ticks (max 94 ms) don't move the average enough.
- Client `rafTick` log: max gap **3104 ms**, with multiple 400–700 ms gaps. The browser/OS scheduler paused the tab.

⇒ Diagnosis: the laptop running the server can't sustain 3200-entity physics + SAB-read at 60 Hz on this hardware. TiDi's averaging hysteresis hides the problem from its own trigger logic. A mobile main-thread pause then compounded the perceived lag into total unplayability.

This case is **outside the network-feel roadmap's scope**. Real fixes belong in three separate workstreams: TiDi tuning (engage on `p99(maxTotalMs)` or sustained `overBudgetCount`), SAB-read optimization (currently ~2.7 µs/entity), and mobile-client tab-pause resilience.

**Diagnostic checklist next time someone reports "lag":**

1. Read the user's-room `tick_budget`. If `maxTotalMs > 25 ms` or `overBudgetCount > 0`, suspect Pattern B. If both clean, Pattern A.
2. Compare client `rafTick` max gap with snapshot max gap. If they match, the client paused. If `rafTick` is steady through the snapshot gap, network/server caused it.
3. Compare server-side `snapshot_broadcast` cadence with client-side snapshot cadence over the same wall-clock window. A divergence is the smoking gun for Pattern A; a server-side slowdown is Pattern B.

Captured for posterity at `diag/captures/2026-05-08T12-01-30-847Z-omekg0.json` (Pattern A) and `diag/captures/2026-05-08T12-11-42-626Z-wpb1hl.json` (Pattern B).

---

## 2026-05-06 (final) — Limbo cooldown restore needs a tick-space plausibility gate

Third diagnostic in the same session reported "most/all of my shots are being rejected." The user had transited (or been Limbo-restored) between sectors. The capture showed `welcome.serverTick = 6814` and the ship spawned at `Y ≈ 5970` (clearly a Limbo restore, not a fresh spawn).

Cause: [src/server/rooms/SectorRoom.ts](../src/server/rooms/SectorRoom.ts) `onJoin` restored `lastFireClientTick` from the Limbo payload verbatim. That works for **same-room reconnect** (both sessions share the same `serverTick` counter, so the resumed value is within a handful of ticks of the new `welcome.serverTick`). It fails catastrophically for **cross-room sector transit**: room A's `serverTick` and room B's `serverTick` are independent counters. A resumed `lastFireClientTick = 200_000` from room A pinned in room B (whose `serverTick = 6_814`) makes every fire fail the cooldown check `tick - lastFireCt < WEAPON_COOLDOWN_TICKS` because `tick - lastFireCt` is hugely negative.

The cooldown check is correct in isolation — the bug is in the restore policy. The Limbo serialisation always carried `lastFireClientTick`; the cross-room hazard was latent until anyone tried to fire post-transit (and apparently no E2E exercised that exact path).

**Fix**: extracted [src/server/rooms/cooldownRestore.ts](../src/server/rooms/cooldownRestore.ts) — a pure helper `shouldHonourResumedCooldown(resumed, destinationServerTick)` that gates restoration on a plausibility window:
- A resumed value > `destinationServerTick + 60` is impossible same-room (client `inputTick` leads `serverTick` by `leadTicks ~6`) → discard.
- A resumed value > 600 ticks behind `destinationServerTick` (long-stale session) → discard for cleanliness.
- Otherwise honour it (preserves the legitimate same-room reconnect cooldown).

Regression coverage at [src/server/rooms/cooldownRestore.test.ts](../src/server/rooms/cooldownRestore.test.ts) including the exact 2026-05-06 reproduction (`destinationServerTick = 6_814`, `resumed = 200_000` → `false`).

**What downstream phases need to know:**
- Any future field carried across Limbo that's expressed in **ticks** must be evaluated for the same hazard. Tick-counters are per-room; resumed values from a different room can never be assumed compatible.
- The reverse case (a future feature wanting to enforce "no insta-fire after transit") would need its own state — wall-clock-based cooldown, not a tick counter.
- Diagnostic gap revealed: the client's diagnostic ring buffer doesn't log `fire` sends or `hit_ack` replies. Adding `logEvent('fireRejected', {clientShotId, ...})` inside the `hit_ack` handler when `ack.rejected === true` would have surfaced this immediately. Worth adding before the next round of diagnostics.

## 2026-05-06 (follow-up) — Network-Discipline — Held-ack-advance fix wasn't enough; throttling must be all-idle-only

After the previous fix, the user retested on mobile. Massive lag during steady-state was gone, but two new symptoms appeared:

- **Join lag** (1–3 s freeze on first snapshot).
- **`corr` rate stuck at 20–30 %** even when steady, with consistent ~8 unit drift per release event on a fast-moving ship.

Two more bugs underneath:

**Bug 1 — first-snapshot reconciler hang.** On join, the worker has applied no inputs yet, so the snapshot reports `ackedTick = 0`. The client's `inputTick` starts at `welcome.serverTick` (typically several thousand). The reconciler's replay loop runs `world.tick(1/60)` for every tick in the gap — a 2000+ step Rapier replay that froze the client. **Fix**: cap replay window at `BUFFER_SIZE` (128). Beyond that the buffer doesn't have the records anyway, so we accept a one-frame snap to server pose instead of a multi-second hang. Locked in by [src/core/prediction/Reconciler.test.ts](../src/core/prediction/Reconciler.test.ts) — the join-replay test asserts the reconcile call returns in < 50 ms even when `currentTick - ackedTick = 5000`.

**Bug 2 — throttled-then-changed inputs skip a tick of physics.** Trace: client sends thrust=true at tick 100, throttles ticks 101–104 (no state change), sends thrust=false at tick 105.
- Server worker dequeues 100, ack=100. Held-applies for ticks 101→103 (synth ack=103). Dequeues tick=105, `ack = max(105, 103) = 105` — **skipping client tick 104 entirely**.
- Server applied 4 thrust impulses (steps 100-103) + 1 no-thrust (step 105 with new input) = **4 thrust applications**.
- Client predicted thrust at tick 104 (kb still showed pressed) → **5 thrust applications**.
- Difference: 1 thrust impulse. At ~480 u/s velocity, that's the ~8 unit drift per release event seen in the diagnostic.

Why the held-ack fix didn't catch this: the held-ack contract works as long as the server's held state is what the client is also predicting. But when the server's `lastApplied.tick` lags the new message's tick by N (because the client throttled N ticks), the server's max-clamp on dequeue erases those N ticks of held physics from the ack timeline — even though the client did apply them locally.

**Why we can't gap-fill server-side**: physics is sequential. The server applies one impulse per `world.step()`. Squashing N held re-applications into one server step would integrate the velocity wrong (same impulse but only one step of motion = different position). Filling the gap properly costs N extra worker steps before the new input reaches the player — at a 250 ms heartbeat that's up to a 250 ms input latency on every release event. Not acceptable for a fast-paced shooter.

**Fix**: narrow A.2 throttling to **all-idle frames only**. When any control bit is held, the client MUST send every tick. The held branch on the worker still fires for true-idle suppression (which is harmless — held-all-idle adds zero impulse, so a skipped ack tick is physically equivalent to applying it). [src/client/net/ColyseusClient.ts](../src/client/net/ColyseusClient.ts) `tickPhysics()` now gates the throttle on `allIdle && lastAllIdle && !stateChanged && !heartbeatDue`.

Bandwidth cost: instead of saving ~3–5 KB/s/client during all input states, we now save it only during truly-idle stretches (AFK players, spectators). Active players send at full 60 Hz. Estimated upstream still drops 50 %+ for typical sessions where players spend much time coasting.

**What downstream phases need to know:**
- Any new per-tick input stream (fire commands, AI intent, future weapons) must NOT be throttled if its held state has any non-zero physics effect. The "all-idle only" gate is the safe pattern.
- The held-ack-advance contract from the previous fix still stands and is still load-bearing — without it, the all-idle synthesised acks would be stale. Both fixes together form the final correct design.
- The reconciler's replay-window cap (`BUFFER_SIZE` ticks) is now a hard ceiling on first-snapshot work — never iterate uncapped from `ackedTick + 1` again.

## 2026-05-06 — Network-Discipline — Client input throttling collided with the worker's "hold last input" branch

A bandwidth-reduction PR added client-side input throttling (`INPUT_HEARTBEAT_MS = 250`): when the control state hasn't changed since the last send, the client suppresses redundant input packets and the server's per-tick input queue runs empty for stretches of 1–15 ticks. On a mobile diagnostic, this produced **massive perceived lag** — the player's ship was being yanked back ~14–70 units per snapshot at a 100 % correction rate, with `maxDriftUnits = 165`.

Cause: the worker's input-queue tick had two branches —

```ts
if (q.length > 0) { ...dequeue, apply, set appliedTicks[slot] = entry.tick }
else { const held = lastApplied.get(slot); if (held) physics.applyInput(playerId, held); /* don't advance ack */ }
```

The "don't advance ack" comment was deliberate — it dates from when the client always sent every tick, so the held branch was just a defensive fallback for one-tick network gaps. With throttling enabled, the held branch fired for ~94 % of ticks while a key was held. The worker silently re-applied the held input every tick (advancing physics) but reported a stale `ackedTick` to the client. The client's reconciler then **replayed** the same inputs the worker had just re-held — a per-tick double-application that accumulated as visible drift.

**Diagnosis path that worked:** the [`/dev/capture` diagnostic](../src/server/routes/diagRouter.ts) on the mobile client surfaced `rollingCorrRate: 1` and `significantCorrectionCount: 196 / 328` immediately. 100 % corrections + huge per-snapshot drift can only be systematic divergence, not jitter — that ruled out perf and pointed straight at a prediction-model violation.

**Fix:** the held branch must advance the ack by 1 each step, synthesising an "implicit re-send" matching what the throttled client would have emitted under the old send-every-tick contract. Per-slot ack now persists across steps in `lastAckTick: Map<slot, number>`. Pure logic extracted to [src/core/physics/inputQueue.ts](../src/core/physics/inputQueue.ts) so the contract is unit-testable; regression coverage at [src/core/physics/inputQueue.test.ts](../src/core/physics/inputQueue.test.ts).

**What downstream phases need to know:**
- The send-every-tick contract is *gone*. Anywhere new that consumes `appliedTick` (snapshots, lag-comp, persistence) must treat it as monotonically advancing per server tick, NOT as "the highest tick of an actual inbound message". The two are no longer equivalent.
- Adding a NEW client-side throttle for any other per-tick stream (fire input, intent, etc.) needs the same audit: does the server have a "hold last value when missing" path? If yes, that path must advance whatever ack the client reconciles against.
- Held-tick monotonicity is locked in by `inputQueue.test.ts` — if anyone ever reverts the held branch to "don't advance ack", the 15-held-ticks assertion fails before merge.

## 2026-05-04 — Phase 7 — Two trap-doors hiding behind one E2E failure

The Phase 7 acceptance E2E (`tests/e2e/persistence-kill.spec.ts`) failed ~6 attempts in a row with a single shape: `victim_user_id` set, `killer_user_id` NULL, so `killerStats.kills >= 1` failed. Six rounds of speculative auth-path fixes did not move it. The actual cause was two unrelated issues compounding:

**Trap 1 — silent diagnostics.** The user's prior session added `pino.info`, `process.stderr.write`, and `appendFileSync('kill-diag.log', …)` inside the `SHIP_DESTROYED` bus handler. None of them produced any output, even though `recordKill` was clearly running (rows kept landing). Root cause: `playwright.config.ts` has `reuseExistingServer: true` for both `pnpm dev:server` and `pnpm dev:client`. A `node` process from earlier in the day was still alive on port 2567, so Playwright reused it. Bus handlers register *once* in `onCreate` and the closure captures the original function reference; even when `tsx watch` reloads modules, an already-instantiated `SectorRoom` keeps its old listener. Edits land in the source file but never reach the running process. **Fix for diagnostic loops:** run with `CI=1` (Playwright treats this as `reuseExistingServer: false`), or `Stop-Process` zombie PIDs on 2567/5173 first. Prefer absolute-path `appendFileSync` + `console.error` over `pino.warn` when the goal is to inspect a hot-path event — pino's worker-thread transport's stdout doesn't always make it through Playwright's webServer stdio capture, but synchronous fs writes always land.

**Trap 2 — drones, not auth.** Once diagnostics actually fired, every `KILL_RECORDED` line showed `shooterId=drone-N` (drone-20, drone-18, drone-26). The killer's playerId *was* in `playerToUser`, auth was clean for both players. The default `sector` room seeds 30 hostile `HostileDroneBehaviour` drones in a 350u ring around origin (see `SectorRoom.onCreate`'s `droneCount = 30` branch), and they were landing the killing blow before the human killer could. Drone shooters use `shooterId='drone-N'`, which is not in `playerToUser` → `playerToUser.get('drone-N') = undefined → null` → `killer_user_id NULL` in the row. **Fix:** the test now joins the drone-free `test-sector` room (already defined in `src/server/index.ts` for exactly this case) via `?room=test-sector`. Two follow-on details: `?room=` triggers `autoJoin=true` in `App.tsx`, which skips the splash screen entirely (so the test must NOT click "Enter Sector Alpha" — there is no such button); and ships spawn at angle 0 facing +Y (forward = `(-sin(0), cos(0)) = (0, 1)`), so aligning killer (0, 0) and victim (0, 100) keeps the beam on target without needing rotation.

**What downstream phases need to know:**
- Default `sector` is *not* a deterministic room for E2E kill tests. Use `test-sector` whenever a specific human attribution matters.
- Any future kill-attribution test must distinguish player vs AI shooters. The current `recordKill(null, victimUserId, …)` path for AI kills is intentional but means "killed by environment" rows have a NULL killer.
- For diagnosing hot-path bus events under Playwright: `CI=1` first, then synchronous `appendFileSync` to an absolute path. `pino.info`/`stderr.write` are not reliable.

## 2026-05-04 — Phase 6 — Accumulator-scaling vs Rapier-`integration_parameters.dt`-scaling

When the SimulationClock's `rate` drops to 0.7×, the worker scales the **input to the accumulator** (`physics.tick(FIXED_DT * rate)`) rather than Rapier's per-step `integration_parameters.dt`. The distinction is load-bearing: scaling Rapier's dt would change collision behaviour mid-frame (swept-AABB margins, contact persistence, friction integration), so a TiDi engagement would alter physics-correctness while it was active and a small position drift would accumulate after every recovery. Scaling the accumulator keeps every step deterministic — the `world.step()` math is identical at any clock rate; the only thing that changes is *how many* steps each wall-clock tick triggers. At 0.7× the accumulator gains 11.67 ms per 16.67 ms wall-clock tick, which is below the 16.67 ms `FIXED_DT`, so some ticks step 0× and some step 1×. Net 70 % progression with no per-tick rounding drift. This is the same pattern Source/Quake use for their slow-time effects.

## 2026-05-04 — Phase 6 — Quiet-evict for the Load Shedder

The Phase 6 LoadShedder despawns far drones when the budget can't recover at the floor rate. The eviction path deliberately bypasses both the `'destroy'` Colyseus broadcast and the `ENTITY_DESTROYED` bus emit (via the `evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false })` opts), so the kill-feed and explosion SFX (when Phase 4 polish lands them) don't fire on cleanup of player-invisible entities 5000+ units away. Persistence and telemetry that need to distinguish "killed in combat" from "shed for budget" subscribe to the new `ENTITY_SHED` bus variant instead of `ENTITY_DESTROYED`. Combat kills still go through the same `evictSwarmEntity` helper with `broadcast: true, emitDestroyed: true` — single teardown sequence, two call modes.

---

## 2026-05-03 — Phase 6.5 — Wire-arrival-time interpolation breaks under jitter; display-delay buffer is immune
Phase 6.5 sub-phase A.

A 4000-entity diagnostic capture showed `avgMs.total = 1.5 ms / 16.67 ms` — server CPU was idle from a budget perspective — yet the user felt visible lag. Cause: `snapshotJitterMs = 29.3 ms`. Snapshot inter-arrival times scatter ±30 ms around the nominal 50 ms (broadcast every 3 ticks at 60 Hz) due to V8 minor-GC bursts and Colyseus's `setSimulationInterval` granularity, even when the server has 90 % budget headroom. TiDi (Phase 6) doesn't help — it scales physics dt under *budget overrun*, not arrival-time variance.

The interpolator before this fix lerped between exactly two cached arrivals using `prevArrivalMs → latestArrivalMs` as the time axis. When arrivals stalled (a 30 ms wire-late packet), the sprite hit `t = 1` and froze at the latest pose; when the late packet finally arrived the sprite caught up in one jump. Visually: freeze-burst-freeze-burst at ~1 Hz.

**Fix**: 3-deep `poseRing` per `SwarmRenderState`. Renderer reads at `now − DISPLAY_DELAY_MS` (100 ms) and walks the ring for the two arrivals bracketing that target time. Continuous lerp keyed by *render time* (always advancing at 60 Hz) instead of *arrival time* (jittery). 100 ms matches the Phase 3 remote-ship buffer so swarm and ship visuals stay temporally aligned.

**What downstream phases need to know**: any future test that reads `prevX/latestArrivalMs` directly is reading bookkeeping shadows now, not the interpolation source. The decoder still maintains those fields for back-compat, but the renderer's hot path goes through `interpolateSwarmPose(entry, now, out)` which only reads `entry.poseRing` + `entry.ringHead`. If you bump `MAX_ENTITIES` past ~50 000, the `populated.sort` allocation in the interpolator will start showing up; promote to in-place sort or single-pass scan.

---

## 2026-05-03 — Phase 5e — 500-entity acceptance gate met on dev machine
Commit: Phase 5e — bulk seed + bandwidth + sleep + benchmark.

After the 5d interest grid + the 5e bulk-seed harness landed, a headless soak with 500 entities (80% asteroids, 20% drones) sustained **60.01 Hz** with `update()` averaging **0.24 ms (1.4 % of the 16.67 ms budget)** on a Windows dev box. Phase per-tick averages: sabRead 0.04 ms, swarmEncode 0.08 ms (per client), aiTick 0.11 ms — every phase is sub-millisecond, including AI iterating 100 drones. The Fly.io `shared-cpu-1x` soak proof remains a Phase 10 deliverable, but the dev-machine equivalent is green.

The interest grid carries the wire-side acceptance — without it, 500 entities × 4 clients × 60 Hz × 24 B = 2.8 MB/s per client on a broadcast-all path, well above the 60 KB/s target. With the 9-cell window each client typically sees < 100 entities at full fidelity plus ~83 decimated entities/sec from the rest, comfortably inside budget.

**Bench note**: `pnpm bench` reports NaN/0 for all benchmarks under vitest 2.1 + Node 24. Pre-existing — `physics-tick.bench.ts` from Phase 2 has the same symptom. The bench files compile, import cleanly, and the underlying code is exercised; the timing-extraction pipeline upstream needs a vitest/tinybench bump. Real perf data lives in the `tick_budget` server event for now.

## 2026-05-03 — Phase 5 — `setInterval(fn, 16.67)` only fires at 32–46 Hz on Windows
Commit: hi-res tick loop.

The Phase 1 worker physics loop and the Phase 1 SectorRoom main-thread loop both used `setInterval(fn, 1000/60)` to drive their 60 Hz tick. On Windows, Node's `setInterval` resolves to the OS multimedia-clock granularity (~15.6 ms) and fires only every other tick of that clock — measured 37.67 Hz on a localhost dev box, 46 Hz on the user's mobile-against-LAN setup. The diagnostic capture instrumentation (`tick_budget` server event) confirmed the *work* per tick was ~0.2 ms; the missing time was timer scheduling, not computation.

**Fix**: replace both `setInterval`/`setSimulationInterval` callers with a `setImmediate`-driven hi-res loop:

```ts
const TICK_MS_HR = 1000 / 60;
let nextTickAt = performance.now();
const loop = (): void => {
  if (stopped) return;
  const now = performance.now();
  if (now >= nextTickAt) {
    step();
    nextTickAt += TICK_MS_HR;
    if (now > nextTickAt + 5 * TICK_MS_HR) nextTickAt = now + TICK_MS_HR; // catch-up cap
  }
  setImmediate(loop);
};
loop();
```

Result: server tick advanced 37.67 Hz → 60.00 Hz exactly. CPU overhead is negligible (the loop runs ~1000 iterations/sec, each one a clock check, totalling well under 1 % of one core).

**Don't re-introduce `setInterval` for sub-20-ms intervals.** It will silently halve the simulation rate on every Windows dev machine. The Linux (Fly.io) setInterval granularity is much better, but coding to the lowest-common-denominator scheduler keeps dev experience consistent across platforms.

**Diagnosis approach**: when the server tick rate seems wrong, sample `serverTick` advance over wall-clock from server-side `snapshot_broadcast` events (already in `getRecentEvents`). Don't rely on perceived feel — the user reported "30–60 % corr" which sounded like a client bug, but was actually the server failing to hit 60 Hz.

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

## 2026-05-04 — Phase 7 — 50 ms write-ahead buffer trades latency for transaction throughput
Commit: Phase 7 SQLite persistence.

Per-op `INSERT` calls into `node:sqlite` cost a non-trivial amount of CPU (statement bind + bytecode dispatch + journal sync). Issuing 1 000 individual KILL inserts on the main thread blocks for tens of ms; even off-thread in the worker, they stack up against each other.

**Fix**: `WorkerBackedSink` accumulates CRITICAL ops for up to 50 ms in a write-ahead buffer, then ships them to the worker as one `BATCH` postMessage. The worker wraps the batch in `db.exec('BEGIN') / COMMIT'`, amortising the journal sync. Earns ~5–10× write throughput at the cost of 50 ms p95 latency on persistence — acceptable because no CRITICAL op has a read-after-write consumer (kills go into the journal, not into the next combat tick).

**Rule**: any future CRITICAL op type that *does* need read-after-write semantics must use `enqueueCriticalAwaitable`, not `enqueueCritical`. The awaitable bypasses the WAB and round-trips through `AWAITABLE_ACK` for the rowid.

## 2026-05-04 — Phase 7 — `play_id` correlation beats round-trip rowid for game_sessions
Commit: Phase 7 SQLite persistence.

Pre-Phase-7, `recordGameJoin` returned `lastInsertRowid` synchronously; `recordGameLeave` then did `UPDATE game_sessions WHERE id = ?` against that rowid. Moving writes to a worker would have forced an awaitable round-trip on every join just to learn the rowid before the player could leave.

**Fix**: `playId` is already unique per game session (assigned by `assignPlayerId()`). `recordGameJoin` now stores `play_id` and `recordGameLeave` does `UPDATE WHERE play_id = ?`. Both ops are fire-and-forget through the WAB; FIFO ordering inside one batch (or across batches) guarantees the JOIN row exists by the time LEAVE's UPDATE runs. If LEAVE arrives before JOIN (impossible given the bus event ordering, but defensive), the UPDATE matches zero rows — a silent no-op rather than a crash.

**Rule**: any future "create-then-update" persistence pair should prefer a stable client-side correlation key over a server rowid. Awaitable round-trips are reserved for ops where the caller genuinely cannot proceed without the row's identity (auth `register` returning a userId).

## 2026-05-04 — Phase 7 — `bundleWorker` reused across all worker_threads workers
Commit: Phase 7 SQLite persistence.

The physics worker (Phase 2) bundled itself via an inline `bundleWorker()` defined inside `SectorRoom.ts`. Phase 7's DB worker needed identical esbuild config (`bundle:true, platform:'node', format:'cjs', sourcemap:'inline'`) but with different `external` (Rapier vs none).

**Fix**: extract `bundleWorker({ entryPoint, external? })` into `src/server/workers/bundleWorker.ts`. Both workers call it with their own entrypoints. Rapier physics passes `external: ['@dimforge/rapier2d-compat']` so the WASM binary isn't double-loaded; DB worker passes no externals so `node:sqlite` resolves at runtime via Node's CJS loader.

**Rule**: all future `worker_threads` workers must use this helper. Never re-introduce the tsx ESM loader path (broken on Node 24 inside workers — see entry above).

## 2026-05-04 — Phase 7 — Sole-writer invariant per WAL DB
Commit: Phase 7 SQLite persistence.

Pre-Phase-7 considered keeping auth's `register`/`updateDisplayName` writes on the main thread as a second writer to `eqx.db`. WAL mode allows multiple writers, so it would have worked — but it splits schema migrations across two code paths and complicates the "where do writes go" mental model.

**Fix**: auth keeps a `readOnly: true` connection on the main thread for `SELECT`s only. Every write — including `register` (via `enqueueCriticalAwaitable` because the HTTP handler needs the userId synchronously) — flows through the worker. One writer, one schema-creation site (`dbWorker.ts` exec's `SCHEMA_SQL` on init).

**Rule**: future schema migrations (ALTER TABLE, new tables) live in `dbWorker.ts`. Main thread reads-only assumes the schema. If you find yourself opening a writable `DatabaseSync` outside the worker, stop — you are breaking the invariant.

## 2026-05-04 — Phase 7 — Worker SHUTDOWN_ACK can race process.exit; use setImmediate
Commit: Phase 7 SQLite persistence.

Initial `dbWorker` shutdown handler did `post(SHUTDOWN_ACK); process.exit(0)` inline. The `parentPort.postMessage` call queues the message on the IPC channel; `process.exit(0)` immediately tears down the worker thread before the queue flushes. The main thread waits for an ack that never arrives.

**Fix**: `setImmediate(() => process.exit(0))` defers the exit by one event-loop iteration, giving the IPC channel time to flush. Belt-and-braces: `WorkerBackedSink.handleExit` also resolves the pending shutdownAck with `drained: 0` if the worker exits without acking, so the main thread cannot hang regardless of message-queue race.

**Rule**: in any worker_threads worker, any `postMessage` that the main thread is awaiting MUST be followed by `setImmediate` (or longer) before `process.exit`. Inline exit drops the message.

## 2026-05-04 — Phase 7 — Process-level signal handlers belong in `index.ts`, not `Room.onDispose`
Commit: Phase 7 SQLite persistence.

Initial design considered draining the persistence worker from `SectorRoom.onDispose()`. Rooms are per-instance (one per active sector); the DB worker is process-global. Tying the worker's lifetime to a room would mean spawning + draining once per room create/dispose — wasteful at minimum, broken at worst (room A's dispose draining room B's in-flight writes).

**Fix**: the worker is owned by the process. `src/server/index.ts:main()` calls `initWorker()` once at boot; `process.on('SIGINT'/'SIGTERM', shutdown)` drains it once at exit. `onDispose` only handles per-room cleanup (sim loop, physics worker terminate).

**Rule**: any process-global resource (DB worker, shared singletons, top-level connections) gets its lifecycle wired in `index.ts`. Per-room state stays in the room.

## 2026-05-04 — Phase 7 — Windows + pnpm/tsx wrapper swallows Ctrl+C; use HTTP shutdown for dev
Commit: Phase 7 SQLite persistence.

`pnpm dev:server` (and even `pnpm dev:server:nowatch`, which skips `tsx watch`) on Windows + PowerShell tears down the JS process on Ctrl+C before the SIGINT handler can complete a single async step. Confirmed by writing diagnostic lines synchronously to a file: only the first `[shutdown] received` line lands; the 10 s force-exit timer never fires; the process is gone within ~50 ms. Root cause is Windows' CTRL_C_EVENT broadcasting to the entire console process group — pnpm and/or tsx exit eagerly and abandon their child.

**Fix (production)**: SIGTERM on Linux/Fly.io works correctly — the existing handler runs, drains the persistence WAB, calls `gameServer.gracefullyShutdown()`, and `process.exit(0)`s cleanly. Test-covered by `WorkerBackedSink.test.ts` (mocked) and `dbWorker.integration.test.ts` (real worker).

**Fix (Windows dev)**: added `POST /dev/shutdown` (NODE_ENV-gated) that triggers the same `onSignal('HTTP_SHUTDOWN')` handler. Hit it with `Invoke-RestMethod -Method POST http://localhost:2567/dev/shutdown`. The drain runs end-to-end and the process exits cleanly.

**Rule**: do not rely on Ctrl+C in PowerShell to exercise shutdown handlers. Use the HTTP endpoint or trust the test coverage. Never workaround the wrapper chain (e.g. detached console processes) — production doesn't have this problem and the test coverage is already exhaustive.

## 2026-05-04 — Phase 8 sub-phase A — Snapshot schema versioning is the canonical "tear down all sectors" knob
Commit: Phase 8 sub-phase A.

The `game_snapshots` row produced by `saveSnapshot(sectorKey, payload)` carries an explicit `schemaVersion` field (defined in [src/server/rooms/SectorSnapshot.ts](../src/server/rooms/SectorSnapshot.ts) as `CURRENT_SCHEMA_VERSION`). On boot, `SectorRoom.hydrateFromSnapshot` reads the most recent row, parses it via `parseSnapshot`, and:
- discards rows whose `schemaVersion !== CURRENT_SCHEMA_VERSION` (logs a warn, falls through to fresh-spawn);
- discards rows older than 24 h (`SNAPSHOT_STALENESS_MS`);
- otherwise restores swarm health (positions are deterministic from config and are NOT restored — keeps the substrate simple and dodges entity-id-stability problems on shape changes).

**Bumping `CURRENT_SCHEMA_VERSION` is the canonical "tear down all sectors and reseed" knob.** When introducing a breaking sector-shape change: bump the version. All persisted snapshots become unloadable on next boot and sectors fresh-spawn from config. To preserve data across a bump, register a migration in `migrateSnapshot()` (currently throws by default — Phase 8 strategy is tear-down-on-change). See [docs/architecture/persistence-and-migrations.md](architecture/persistence-and-migrations.md) for the full pipeline.

## 2026-05-04 — Phase 8 sub-phase A — Galaxy graph hard-coded; bump CURRENT_SCHEMA_VERSION when re-shaping sectors
Commit: Phase 8 sub-phase A.

The galaxy graph lives at [src/core/galaxy/galaxy.ts](../src/core/galaxy/galaxy.ts) — a pure module exporting `GALAXY_SECTORS`, currently 7 sectors in a hexagonal sunflower. Both server and client consume it. The unit test enforces edge symmetry, no dangling neighbours, and that every outer is at axial-hex distance 1 from `sol-prime` — typos catch at `pnpm test`. To add or rewire sectors:
1. Edit `GALAXY_SECTORS` (axial coords, symmetric edges, asteroid config key, drone count).
2. If the change alters persisted swarm shape, bump `CURRENT_SCHEMA_VERSION` so old snapshots discard cleanly.
3. Run `pnpm test src/core/galaxy/galaxy.test.ts` to check structural invariants.
4. `pnpm dev:server` should log `galaxy room created sectorKey=...` × N for the new count.

Walkthrough: [docs/architecture/galaxy-graph.md](architecture/galaxy-graph.md). Future plans (SQLite-backed runtime-mutable graph, admin tooling, per-edge arrival points) are captured there.

## 2026-05-04 — Phase 8 sub-phase B — Vulnerable spool-up + two-TTL Limbo
Commit: Phase 8 sub-phase B.

The transit flow keeps the player's ship **in the source sector** during the 3-s spool. The orchestrator subscribes a one-shot `SHIP_DESTROYED` listener filtered by playerId; if it fires, transit aborts cleanly and the normal death path runs. This is intentional: it gives chasers a window to interrupt a fleeing target without inventing new gameplay. After the spool, `commitTransit` reads SAB pose (NOT Colyseus schema — schema is broadcast at 20 Hz, SAB is the 60 Hz ground truth), writes Limbo with the destination `sectorKey`, reserves a seat on the destination galaxy room, and sends `transit_state IN_TRANSIT` + `transit_ready` to the client. The client `consumeSeatReservation`s, the destination's `onJoin` consumes the Limbo entry, and the pilot reappears at the same `(x, y, vx, vy, angle, angvel, health, cooldown)`.

**Two-TTL Limbo**: the same `LimboStore` holds entries with `LIMBO_DISCONNECT_TTL_MS = 5 min` (browser tab close, network drop) AND `LIMBO_TRANSIT_TTL_MS = 30 s` (in-flight cross-sector hop). Schema row is identical; only `expires_at` differs. The destination's `onJoin` can `take` either; the `payload.sectorKey === this.sectorKey` guard ensures we only consume entries destined for THIS room. The `playerToTransitInFlight` set on `SectorRoom` prevents the source-room's `onLeave` (fired on `consumeSeatReservation`) from clobbering the destination-keyed entry with a source-keyed 5-min entry.

**Why pure Limbo, not Colyseus `allowReconnection`**: one path serves both same-sector reconnect and cross-sector transit. Trade-off: a same-sector tab-close-reopen does a fresh `joinOrCreate` instead of Colyseus's seat-locked reseat (slightly less ergonomic), but the simplification dominates and the design is forward-compatible with a future Redis-backed multi-VM Limbo without further refactoring.

## 2026-05-04 — Phase 8 sub-phase B — bindRoomHandlers refactor for ColyseusClient
Commit: Phase 8 sub-phase B.

`ColyseusClient.connect()` historically registered all `room.onMessage` handlers inline against `this.room`. Sub-phase B's transit flow needs to swap `this.room` mid-session (after `consumeSeatReservation`), so the handlers were extracted into a closure-local `bindRoomHandlers(room: Room): void`. The closure captures `storedPlayerId` / `callbacks` / `bwStats`; the body is otherwise unchanged. The initial join calls `bindRoomHandlers(this.room)`; the post-transit `transit_ready` handler calls it again on the destination room.

**Don't naively flag the room.onLeave callback as a disconnect during transit.** Mid-`consumeSeatReservation` the source room's WS is replaced and `onLeave` fires; if we set `connectionStatus = 'disconnected'` there, the HUD flickers a disconnect state for ~50 ms before the destination welcome rebinds. The handler now early-returns when `transitState === 'IN_TRANSIT' || 'SPOOLING'`, deferring connectionStatus updates to the destination's normal flow.

## 2026-05-04 — Phase 8 sub-phase A — Galaxy sectors tick when empty by design
Commit: Phase 8 sub-phase A.

`SectorRoom.update()` historically had `if (this.playerToSlot.size === 0 && this.swarmRegistry.size() === 0) return;` — a dual-zero short-circuit that saved CPU on rooms with no players AND no swarm. Phase 8 keeps this for engineering rooms but removes it for galaxy rooms (`sectorKey !== null`): the simulation step always runs so drones patrol, asteroids drift, and sleep transitions fire even when no player is connected. The world should feel like time has passed. Per-client broadcast work is gated separately on `clients.length > 0`, so empty galaxy rooms still skip the encode/broadcast cost. Phase 5e bench (500 entities at 0.24 ms/tick) gives plenty of headroom for 7 idle galaxy rooms.

## 2026-05-23 — Ship-Kinds — `applyTorqueImpulse` divides by moment of inertia, not mass

Ship-kinds rolled out with an "eased turn" implementation that wrote `body.applyTorqueImpulse(dω · body.mass())` per tick, capped at `turnAccel · dt`. With `turnAccel = 10` rad/s² this should produce ~0.167 rad/s of angvel change per tick. In practice the ship rotated ~4°/s — about 70× too slow.

Cause: Rapier's `applyTorqueImpulse(impulse)` integrates as `Δω = impulse / I` where `I` is the **moment of inertia**, not the translational mass. For a uniform disc collider of radius `r` and mass `m=1`, `I = 0.5 · m · r² = 72` for the Fighter's `r=12`. Multiplying by `mass()` (=1 by construction of our density formula) was a no-op when the intent was to multiply by `I` to cancel Rapier's `1/I` divide.

**Two fixes considered:**
1. Use `body.massProperties().principalAngularInertia` to get the real `I`. Correct, but adds an API call per tick and ties the controller to Rapier's mass-properties path.
2. Drop the easing entirely. Use `setAngvel(±maxAngvel)` while held and `setAngvel(0)` on release.

We took option 2. Top-down arcade cars don't actually need yaw easing — when you turn the wheel they respond. The "feel" comes from `linearDamping` + `lateralGrip`, not from yaw inertia. Bonus: per-tap rotation is now exactly `maxAngvel × duration`, which is what aim needs. See [docs/architecture/ship-physics-handling.md](architecture/ship-physics-handling.md) for the model.

**`angularDamping` is now 0** for player ship kinds — `applyInput` writes the angvel every tick, so Rapier's exponential decay never gets to act on it. Earlier tunings had `angularDamping = 8.0`, which was load-bearing for the eased-turn model but is dead code in the snap-turn model.

**What downstream phases need to know:**
- Any future ship-kind that needs eased turn must explicitly compute `I` and use option 1, OR introduce its own state machine for the angvel ramp. Mass-scaled torque-impulse is a trap.
- If we ever add per-kind `angularDamping > 0`, document why — the snap-turn model treats it as decoration.

## 2026-05-23 — Ship-Kinds — Swarm wire format v2 bumps record stride; old clients must hard-fail

Phase 6 added a `u8 shipKind` byte to each swarm-packet record so drones can render with the correct silhouette. The record went from 28 → 29 bytes; `SWARM_WIRE_VERSION` bumped 1 → 2.

A v1 client decoding a v2 packet would mis-stride every record after the first by 1 byte — entityIds would shift, poses would corrupt, asteroids would render as drones. The decoder hard-fails on `version !== SWARM_WIRE_VERSION` (drops the packet entirely) rather than guessing v1 layout from a v2 byte stream. **Never** add a fallback that tries to decode v2 with v1 strides.

The catalogue order in `SHIP_KINDS_LIST` is now part of the wire format: drone kinds encode as the index into that list. Reordering or removing a kind invalidates every in-flight v2 packet. Append-only is safe; deletions require another version bump. Test [tests/unit/shipKinds.test.ts](../tests/unit/shipKinds.test.ts) `catalogue order is fighter -> scout -> heavy (wire-format-stable)` pins the current order.

**Operationally**: a build with v2 server + v1 client tab silently shows nothing in the swarm channel. There's no in-band "please refresh" signaling — that would be a follow-up. For now, the decoder logging an `ignored swarm packet, version mismatch` warn is enough.


## 2026-05-09 — AI lockstep — Two correction paths fighting is worse than one wrong path

Chapter 2 of the network-feel work (chapter 1 was commit `31af74c`, the move of `AiController` to `src/core` so the client could run drone AI lockstep with the server). Chapter 2 closed the residual jitter the user reported as "two locations fighting over which is right and both winning."

The fix shipped in three structural commits (`1707261` Phase A wire-format v3 with angvel, `0642f75` Phase B per-drone snap diagnostic, `b59b523` Phase C drone reconcile anchor) plus one **load-bearing follow-up** (`d1e7ecf`) — and the follow-up is the lesson worth recording.

The initial Phase C added a snapshot-driven drone anchor: `SnapshotMessage.drones[]` slice ships in-interest drones at `snap.serverTick`, and `Reconciler.reconcile` re-anchors them before replay. That part worked structurally. **What broke it** was leaving the pre-existing binary-packet `setShipState` call in `syncSwarmIntoPredWorld` unchanged. Now there were two paths resetting drone state on the client at different cadences and to different targets:

  - snapshot path (20 Hz): seeds at `snap.serverTick`, replay advances by `currentTick − ackedTick` ticks → predWorld at `currentTick` (forward-extrapolated)
  - binary packet path (60 Hz): unconditionally `setShipState` to server pose at packet emit (≈ `serverTick`, behind `currentTick` by ~`leadTicks` worth of motion)

Every binary packet pulled predWorld backward by the same amount the snapshot path had just pulled it forward. The two paths cancelled. The mobile capture `2026-05-09T17-25-27-695Z-82ncsd` showed snap distance **TRIPLED** vs the pre-Phase-C baseline (3.5 → 15 u median, 18 → 39 u p99). The spring-offset render layer fired on every snap to smooth the residual, and at mobile RAF (~22 Hz) couldn't decay between them — the user saw rendered drone position alternating between two states every frame.

The fix (commit `d1e7ecf`): track which drones the snapshot anchored (`_droneSnapshotAnchored: Set<number>`, rebuilt each snapshot from `snap.drones[]`). In `syncSwarmIntoPredWorld`, for those drones, **skip both `setShipState` and the spring-offset capture**. Snapshot becomes the single source of truth; the binary packet still updates `mirror.swarm` (asteroid lerp source) but doesn't touch predWorld for in-interest drones. Out-of-interest drones fall through to the legacy path. Mobile capture `2026-05-09T17-52-07-928Z-qcub4y` after the fix: swarmSnapP99 9.92 u, swarmAngleP99 0.057 rad (~3.3°), swarmAngvelP99 0.013 rad/s. User reaction: "Holy fucking shit. Almost flawless. This is a huge milestone."

**The general rule**: one correction path per state surface. When you're adding a NEW correction path (snapshot anchor, schema sync, etc.) for state that already has an EXISTING correction path (binary packet, RPC, etc.), you must REMOVE or GATE the existing path. Don't run both.

**The diagnostic signature for this class of bug is distinctive**: per-event metrics get *worse* after a fix that "should help structurally," not better. If you see that pattern, look for two reset paths.

The TDD harness `tests/e2e/feel-test-lockstep.spec.ts` is the regression lock — its `swarmSnapP50 < 15` assertion will fail the moment a dual-correction-path bug reappears. Architecture walkthrough: [docs/architecture/ai-lockstep.md](architecture/ai-lockstep.md).

---

## 2026-05-13 — Phase 6b — Every collidable entity MUST be in predWorld (SECOND TIME this trap was hit)

Commit: `2c4aa5c` (Phase 6b lingering hulls). The user reported: "I cannot collide with them, or shoot them, I just fly through" — about lingering player hulls displayed in their sector.

**This is the same class of bug** Phase 4 hit with wrecks (commit `ca9c6df` "spawn wreck bodies in client predWorld for collision"). Two phases, same trap, same fix pattern. Time to capture the rule so it doesn't happen a third time.

### The contract

**Every entity the local ship can physically collide with — OR shoot via the local hitscan ray-test — must have a rigid body in the client's `predWorld` (the prediction physics world).** The render mirror (`mirror.ships`, `mirror.wrecks`, `mirror.lingeringShips`) is what the **renderer** reads. The render mirror is **NOT** what the prediction physics reads. The physics world is its own thing. Both must be populated for an entity to be both visible AND interactive.

If a new entity type only lives in the render mirror, then:

- The local ship passes straight through it (no `predWorld` body during `world.step()`).
- The local hitscan ray-test (which runs against `predWorld` bodies) finds nothing.
- Local projectile ghosts can't preview hits against it.

### The fix pattern (every time, same recipe)

1. Allocate a body-id namespace with a prefix that can't collide with playerId / wreck / etc. Phase 4 used `wreck-${id}`. Phase 6b used `linger-${id}`. Future: pick a unique prefix.
2. In the snapshot-pose handler for that entity type, lazily spawn the body the first time you see a pose: `predWorld.spawnShip(bodyId, x, y, kind)`. NB: **requires `kind` to be known** — defer spawn until kind arrives via the schema diff, or you build a default-fighter body with the wrong collision radius.
3. Every snapshot tick after spawn, `predWorld.setShipState(bodyId, { x, y, angle, vx, vy, angvel })` so the body tracks the authoritative pose.
4. On entity removal (cleared from `mirror.X`), `predWorld.despawnShip(bodyId)` to free the rigid body.
5. Track the spawned bodies in a `predXxxIds: Set<string>` so cleanup on room teardown / sector change can despawn them all.

### Server-side counterpart — projectile-sweep + hitscan iteration

When a new entity type can take damage, the server also needs to teach its hit-test loops to iterate it. Phase 6b had to add `lingeringSlots` iteration to both `advanceProjectiles` (the projectile sphere-sweep) and `handleFire` (the hitscan ray-test). The wreck flow has the same pattern via `wreckToSlot` iteration. **Adding a new collidable entity = three integration points server-side**: schema map, projectile sweep, hitscan ray.

Plus `applyDamage` must know how to route the targetId — Phase 6b added a direct `state.ships.get(targetId)` check before the playerId-based `getActiveShip` lookup, so a shipInstanceId-based targetId (used for lingering hulls) routes correctly.

### Why this is a recurring trap

When you add a new collidable entity type, you naturally think about (a) the server-side schema, (b) the wire format, (c) the render mirror. The predWorld registration is a **fourth thing** that's easy to forget because it's spatially in a different subsystem from the mirror. The renderer and predWorld both subscribe to per-frame updates, but the predWorld is the one that drives collision and local hit-testing.

### Look-here-first checklist for "I fly through this thing"

1. Is there a `mirror.X` for this entity? Good. Now is there a corresponding `predXIds: Set<string>` of spawned predWorld bodies?
2. Does the snapshot-pose handler call `predWorld.spawnShip(bodyId, ...)` lazily on first pose (with `kind` known)?
3. Does it call `predWorld.setShipState(bodyId, ...)` on every snapshot to keep the body in sync?
4. Does the cleanup branch call `predWorld.despawnShip(bodyId)` when the entity is removed?
5. Server-side: do `advanceProjectiles` and `handleFire` iterate the new entity's slot map?
6. Server-side: does `applyDamage` know how to route the new targetId form?

If any answer is no, the local player will fly through and the server may miss hits.

`src/client/CLAUDE.md` carries the rule in shorter form under the "Renderer Rules" section ("Every collidable entity must be in predWorld"). This was reworded from "Remote ships must be in predWorld" after this lesson — the old phrasing only covered the original case and didn't dissuade Phase 4 + Phase 6b from re-hitting it.

**Follow-up (Phase A3, 2026-05-13)**: the renderer-side half of this trap (lingering hull invisible because `if (!ship.kind) continue` skipped forever) is now covered by automated tests. The per-entity sprite-update decisions live in a pure module `src/client/render/spriteUpdateDecisions.ts` with unit-test + fast-check coverage of every branch. Adding a new entity type that surfaces in `RenderMirror` requires adding a corresponding `decideXxxSpriteAction` function with branch tests — the type-system contract makes the decision module the only path. The server-side half (snapshot routing) is harder to test in isolation; see the Phase A1 blocker note below.

---

## 2026-05-13 — Phase A1 — SectorRoom integration test harness (shipped after 5 layers of resolution)

Set up an end-to-end SectorRoom integration test that the Phase 6b "lingering hull invisible" bug class would have failed. The original goal — using `@colyseus/testing@0.16.3` — was abandoned partway through; the harness now bypasses `@colyseus/testing` entirely and drives the production stack directly via `new Server()` + raw `colyseus.js` client. Files:

- `tests/integration/sectorRoom/harness.ts` — boot-a-real-server factory
- `tests/integration/sectorRoom/lingering.test.ts` — Phase 6b regression locks (5 tests)
- `tests/integration/sectorRoom/sqliteStub.ts` — no-op `DatabaseSync`
- `vitest.integration.config.ts` — separate config (see #5 below)

**Blockers encountered, in order resolved:**

1. **Transitive `@colyseus/tools@0.17.19` mismatch**. A previous install of `@colyseus/testing@0.17` left tools 0.17 in the lock file. `@colyseus/testing@0.16.3`'s entry point imports tools, which imports `defineServer` from `@colyseus/core@0.17` — but we have 0.16.24. **Fix**: `pnpm add -D @colyseus/tools@^0.16.0`.

2. **`node:sqlite` import via the transitive chain**. `Database.ts` → `PersistenceWorker.ts` → `SectorRoom.ts`. Vite's resolver strips the `node:` prefix and fails to load `sqlite` as a bare module. **Fix**: `resolve.alias` `node:sqlite` to a no-op `sqliteStub.ts`. Integration tests stub the persistence layer at the `setPersistence` / `setLimboStore` / `setPlayerShipStore` seams anyway, so SQLite is never touched.

3. **Legacy `experimentalDecorators` not applied by esbuild**. Vitest's default esbuild transform emits TC39 stage-3 decorators with `Symbol.metadata`, incompatible with `@colyseus/schema@3.x`'s annotations. **Fix**: `esbuild.tsconfigRaw` in vitest.config with `experimentalDecorators: true, useDefineForClassFields: false`.

4. **tinypool worker-IPC serialization crash**. After all the above, `@colyseus/testing`'s `boot()` succeeded but vitest's reporter crashed with `TypeError: ERR_INVALID_ARG_TYPE` in `deserialize` — Colyseus's `registerGracefulShutdown` installs `process.on('uncaughtException')` which poisons tinypool's IPC during teardown. Tried `forks` and `threads` both — same failure mode. **Fix**: bypass `@colyseus/testing` entirely. Drive raw `new Server({ transport: new WebSocketTransport({...}) })` + `gameServer.listen(randomPort)` + `new Client('ws://localhost:port')` from `colyseus.js`. Nothing crosses the worker IPC boundary because server + client both live in the same node process as the test. Then pin `pool: 'threads'` with `singleThread: true, isolate: false` to keep Colyseus's global handlers out of the IPC path entirely.

5. **`pool: 'threads'` breaks `process.chdir()`-using tests**. Worker threads don't support `process.chdir()`. `src/server/routes/diagRouter.test.ts` does `process.chdir(tempDir)` in `beforeAll` to redirect a capture-dir module-load constant. Tried `poolMatchGlobs` to apply the threads pool only to integration tests, but the resulting cross-pool serialization triggers a separate `ERR_INVALID_ARG_TYPE` rejection in tinypool's child-process IPC even when the failing test is in the threads-only glob. **Fix**: split into two configs (`vitest.config.ts` and `vitest.integration.config.ts`) invoked by separate scripts. The main suite runs in default forks; the integration suite runs in single-thread threads. No cross-pool mixing.

**Additional discoveries (production-code semantics that bit the test):**

- **`assignPlayerId` rejects non-UUID join options**. `src/server/identity/PlayerIdentity.ts` validates the requested playerId against a UUID regex and returns a fresh `randomUUID()` on mismatch. Test playerIds like `'player-A'` are silently replaced. **Fix**: integration tests pre-generate `randomUUID()` values and assert against the same UUID end-to-end.

- **Sectors are "idle from birth"** — `IdleTracker.lastEventTick` defaults to `-Infinity`, so the first call to `isSectorIdle` returns true under any positive threshold. Snapshot broadcasts are gated on `!sectorIdle`, so a freshly-spawned stationary ship NEVER receives a snapshot until something moves. **Fix in tests**: send an `input` message with `thrust: true` to apply an impulse — the worker's pose update propagates back to `shipPoseCache`, the idle check sees motion, `noteSectorEvent` fires, `sectorIdle` flips false, broadcasts resume. The harness exposes `sendThrust(room)` as the canonical wake-up.

- **Galaxy rooms (`sectorKey` set) are `autoDispose: false`** so they persist across disconnect/reconnect. Tests use `beforeEach` (not `beforeAll`) to isolate per-test state — without isolation, lingering hulls from prior tests pollute later assertions.

**Harness API** (see `tests/integration/sectorRoom/harness.ts` for the canonical interface):
```ts
const harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true });
const client = await harness.connectAs(uuid, { shipKind: 'fighter' });
harness.sendThrust(client);                       // unidle the sector
const snap = await harness.waitForSnapshot(client, 3000);
const state = harness.getServerRoom()!.state;     // direct schema access
await harness.disconnectClient(client);
await harness.cleanup();
```

**Result**: 5/5 integration tests pass in ~2.5s wall-clock; the regression that took 4 smoke-test cycles to surface in Phase 6b would have failed test 5 ("after fresh-spawn, original ship lingers + new ship is active") in CI.

**For future entity types** (drones-as-targets / Phase 6c, slot-cap eviction / Phase 6d): add a `describe` block in `lingering.test.ts` per scenario. Avoid the temptation to create a generic "sector harness" with too-many parameters — copy-paste a tight `beforeEach + connectAs + assert + disconnect` block instead. Integration tests trade isolation for speed; per-test boot is acceptable.

---

## 2026-05-13 — Drawer perf paradigm + MUI sx-hoist rules

Commits: `9c04bbf`, `f7386a9`, `2aa7d4f`, `55ff74f`, `f81e129`

Drawer first-open dropped from **13.7 s → 1.22 s** across five fixes shipped during the 2026-05-13 marathon. Target was sub-500 ms; we haven't hit it (the 1.22 s floor is dominated by React reconciler + emotion `sx`-prop work on the first cold mount of GalaxyTab + ShipRosterPanel, plus main-thread contention from the Pixi tick). The work surfaces a UI perf paradigm worth recording.

### 1. Measurement-first ordering — pick the largest slice first

The CPU profile (`diag/drawer-lag-trace/cdp-perf.json`) showed `_recomputeSwarmSnapStats` was 2.3 s self-time, dominating every other cost in the lag window. Throttling that to 1 Hz (commit `9c04bbf`) was a one-line change that delivered the largest single-step win (13.7 → 3.07 s). The emotion/sx-prop slice was second-largest. The Modal cold-mount was third-largest. *In that order.* Don't optimise without measurement.

### 2. The MUI sx + emotion paradigm — hoist, memoise, memo()

Every inline `sx={{...}}` allocates a fresh object on every render. MUI's emotion engine then has to hash it (murmur2), deep-merge it, and run `styleFunctionSx2` against the theme — per allocation. A single drawer-open showed ~6 s of emotion + sx work across all the chip/button/box renders in profile.

Rules (commit `55ff74f`, see [src/client/layout/Drawer/AdvancedDrawer.tsx](../src/client/layout/Drawer/AdvancedDrawer.tsx) lines 40–105 for the canonical example):

- **Hoist static `sx` to module-level consts.** Name them by purpose: `HEADER_SX`, `CARD_SX`, `RAIL_BTN_ACTIVE_SX`. Stable identity across renders → emotion cache hit, no per-render restyling.
- **Use `useMemo` for sx that depends on props/state.** Same caching benefit; just gated by deps.
- **`useCallback` for handlers** that get passed to memoised children. Stable prop identity is what keeps `React.memo` alive.
- **`React.memo` on per-item components** in lists (e.g. tab buttons in a rail). Without it, parent re-renders cascade. With it, the children render only when their own props change.
- **`useMemo` for derived JSX elements** (e.g. `active.node` in AdvancedDrawer). If the parent re-renders and the JSX element is rebuilt, React's reconciler treats it as a new element and unmounts/remounts the subtree — wiping the perf wins.

The pattern compounds: a single button in a 4-item rail unrolls to ~20 emotion hashes per render in the naive form. With the paradigm applied, those hashes happen once at module load.

### 3. `keepMounted` policy flip — the historic objection is now narrow

Pre-2026-05-13 the Drawer was `keepMounted: false` because the historic concern was: tab content (`ConnectionDiagnostics`, `DevOverlay`, `LogPanel`) subscribes to snapshot-rate state and would re-render at ~17 Hz if mounted-but-invisible, starving the Pixi RAF loop.

The 2026-05-13 measurement showed Modal **cold-mount** was the dominant first-open cost (commit `2aa7d4f`): pre-mounting drops CLICK→VISIBLE from ~13.7 s to ~1.22 s. We flipped `keepMounted: true` and narrowed the historic objection to its actual surface: snapshot-rate subscribers in hidden tabs MUST gate on `drawerTab === '<id>' && isDrawerOpen`. The cost is paid once at page-load; the hidden-tab cost is zero by gate.

`SlideProps.mountOnEnter: false` is also set (commit `f81e129`) so MUI's Slide doesn't defer child mount on first open. With `keepMounted` on the Modal AND `mountOnEnter: false` on the Slide, the children render at page-load.

### 4. Pixi viewport `eventMode` + `features.globalMove` — known fix per pixijs/pixijs#6515

Commit `f7386a9`: in `PixiRenderer.ts`, set `viewport.eventMode = 'none'` and `features.globalMove = false`. The viewport tree is gameplay-only — no per-sprite hit-test needed on every native pointer event. globalMove dispatches the move event to every interactive child each native frame; switching it off skips the traversal. Pixi v8 ships globalMove on by default for completeness, but for our gameplay subtree it's pure overhead.

### 5. Abandoned approaches — do not retry

The following were explored on 2026-05-13 and ruled out:

- **MutationObserver-wrapped visibility waits.** Obscured the actual signal; Playwright's `expect(locator).toBeVisible()` is the contract. If it can't find the element, the element isn't there — wrap doesn't fix that.
- **Custom `page.evaluate`-based clicks for UX steps.** Dodges the perf wall but breaks the user-experience contract the test is meant to verify. Setup steps (auth, drawer-open) MAY use Zustand setters; UX steps (the actual flow under test) MUST be real clicks.
- **Generous timeouts to "make the test pass".** Timeouts are signals, not solutions. A 30 s wait for a 16.67 ms target frame means something is fundamentally wrong; bumping to 60 s doesn't fix it.
- **`keepMounted: false` + `mountOnEnter: true`.** This WAS the slow path. Don't re-evaluate it — the win is measured and reproducible.

### 6. What's still unsolved (carry forward)

- **<500 ms drawer click→visible target.** Floor is 1.22 s. Open hypotheses (handoff doc priority order): Pixi tick starves Playwright's CDP; MUI internal `<Transition appear>` defers mount; pre-mount GalaxyTab outside the Drawer entirely.
- **`tests/e2e/drawer-galaxy-overview-spawn.spec.ts` still failing.** Times out at `[data-testid="galaxy-tab-show-map"]` not visible within 30 s. Next evidence-led step: verify `drawer-panel-galaxy` is in DOM at page-load BEFORE the drawer click (proves whether keepMounted is doing what we think).
- **`tabVisible` gate audit needed.** `DebugTab.tsx`, `ConnectionDiagnostics.tsx`, `DevOverlay.tsx`, `LogPanel.tsx` — each should be gated. Patch any unconditional snapshot-rate subscription before further perf measurement.

See `docs/HANDOFF-drawer-perf-2026-05-13.md` for the as-of-end-of-session record, including measurement table and hypothesis ordering.

## 2026-05-15 — Warp — world-anchor warp centre must flip game→Pixi Y (and a debugging-discipline lesson)

Smoke-test report: "the warp effect doesn't appear correctly over the ship's location"; after a first wrong fix: "Fail. I spawned in and it was off screen to the bottom right... I just saw a pulse appear from that direction."

**Real root cause.** A `{kind:'world'}` warp anchor carries GAME-space coords — `App.tsx` reads them straight from `mirror.ships`, which is game-space and **Y-up** (the same source the HUD grid readout uses). The renderer's `world` container is Pixi-space, **Y-down**: every entity is drawn `sprite.y = -ship.y` and the camera follows the already-flipped sprite. The warp projection passed `+worldY` straight into `world.toGlobal`, so the ripple rendered at the **vertical mirror** of the ship — offset `2·shipY·scale`. X is never flipped, so only Y was wrong; at a non-zero spawn Y the pulse flew off the bottom of the screen ("bottom right" = Y-mirror + spawn-X/pre-reconcile offset). The sandbox looked perfect because it only ever used screen-space / `null` anchors, which never touch the world projection and so never the flip.

Fix: `resolveWarpFilterCenter` (pure, exported from `PixiRenderer.ts` beside `shouldDetachWarpVisual`) negates Y for the `world` branch — `projectWorld(worldX, -worldY)` — exactly the `-ship.y` flip every sprite already gets. `screen` / `null` anchors pass through untouched. Locked by `PixiRenderer.warpCenter.test.ts` (3 world-anchor cases fail pre-fix, screen/null guards stay green).

**Superseded theory — do NOT re-apply.** An intermediate fix multiplied the centre by `renderer.resolution`, theorising that `ShockwaveFilter`/`ZoomBlurFilter` `uCenter / uInputSize.xy` needs physical px on HiDPI. That shader read is real, but the conclusion was wrong: the renderer's screen frame already matches the filter's `uInputSize` frame, so **no resolution rescale is needed**. The decisive evidence was on-device, not reasoning: the user had explicitly confirmed the sandbox screen-centre warp was pixel-correct on their actual DPR-3 phone *before* any DPR change. A `× resolution` would have broken that. The `resolution` param was removed entirely.

**Debugging-discipline lesson (the expensive part).** Two fixes shipped on shader/Pixi-internals reasoning before the third (correct) one. What broke the loop was re-reading the *user's own words* as ground truth: "sandbox was basically perfect on my phone" + "off-screen bottom-right on spawn" together point unambiguously at a Y-only, world-anchor-only error — i.e. the game→Pixi flip — and rule out a symmetric DPR scale. Rule: **when a renderer bug reproduces only on-device, prefer a fix derived from concrete on-device observations over one derived from engine-internals theory.** Engine-internals reasoning is a hypothesis generator, not evidence; an on-device "it looked perfect here" is evidence. Also: a HiDPI-only symptom does NOT automatically mean "missing `× resolution`" — frame conventions (Y-up vs Y-down, game vs Pixi) produce identical "only wrong on the phone" smoke reports because origin offsets only become visible once you move away from spawn.

Carry-forward rule: **any game-space coordinate handed to the renderer's `world`/scene graph must flip Y (`-y`)** — sprites, beams, mount offsets, halo arrows, and now the warp centre all obey `pixiY = -gameY`. Screen-space and world-unit-distance maths (e.g. the flash range check, in world units relative to `camera.center`) are frame-agnostic and need no flip.

## 2026-05-15 — Warp — an effect anchored to a moving entity must TRACK it, not capture a point once

Follow-up smoke-test after the Y-flip fix: "did the effect at the point when I started charging instead of where I actually was". Diagnostic `2026-05-15T22-08-40-272Z-s3b9l8` proved it numerically: `warp_mode_change` (spool start) at client ts 16895 with the ship at ≈(2974,1779); by curtain (ts 20492, ~3.6 s later) the ship had flown to ≈(3460,2013) — **~539 u away**. The warp centre was captured ONCE in `App.tsx` (`mirror.ships.get(localId)` → a frozen `{kind:'world'}` point) at spool-start, so the spool→climax→burst played where charging began while the player flew off.

Root cause class: **a visual effect whose anchor is a moving entity must re-resolve that entity's live position every frame for the effect's whole lifetime — never snapshot the position at trigger time.** A one-shot capture is only correct for a genuinely point-anchored effect (e.g. a remote ship that has already despawned: mark where it left from).

The user also flagged the first cut (`{kind:'localShip'}`) as a symptom fix: *"isn't this a symptom fix — what if a remote or bot ship is warping?"* — correct. The principled shape is an **entity-id anchor** (`{kind:'entity', entityId}`) the renderer re-resolves via `sprites.get(entityId)` every frame. Id-agnostic: local, remote and bot ships resolve through one path, no special-case. `localShip` was deleted, not kept as an alias. `{kind:'world'}` now means *only* "a fixed point with no live entity to track" (remote warp-OUT, ship already gone — `pendingWarpEvents`).

Why this matters beyond warp: any future effect that "sticks to" a ship (shields, charge-up auras, tractor beams, death throes) has the same trap. Anchor by entity id + resolve live; don't pass a captured `{x,y}`. Locked by `PixiRenderer.warpCenter.test.ts` (the entity cases assert per-frame re-resolution and id-agnosticism; reverting to a frozen value re-fails them).

Open follow-up (NOT yet fixed): the user also reported "a bit of lag". The capture shows 4 `raf_gap`s (116–183 ms) all clustered at the transit room-swap boundary (ts 20321–20869, 25961) — transient handoff cost, not steady-state — plus a ~29 ms mean frame during the spool window (16895–20492). That window is exactly when the full warp filter chain (stacked `ShockwaveFilter` ×N + `ZoomBlurFilter` + `BloomFilter`, all fullscreen) is active on a DPR≈2.6 mobile GPU; the every-micro-cell grid labels added the same day (`computeGridLabels`, O(n²) `Text` over the padded window) compound it. Not yet attributed/fixed — candidate mitigations: lower filter `quality`/count on mobile, shorten the spool, or pool the grid-label `Text` instead of create/destroy on pan. Do NOT ship a blind fix; get a capture that isolates filter-on vs labels-on. **[RESOLVED 2026-05-16 — see next entry: it was none of these; the lag was arrival prediction drift.]**

## 2026-05-16 — Warp — the warp-out "lag" was arrival prediction drift; `resetPredictionState`'s "fresh-connect seed" was a lie for the spatial body

The 2026-05-15 "bit of lag" follow-up above generated **three** plausible theories — filter fill, grid-label `Text` churn, room-swap mechanics. **All three were wrong.** They were killed, in order, by *data, not argument*: same-device sandbox A/B refuted filters (user: "lag free on mobile" — on-device evidence falsifies a whole theory class); F1 per-frame sub-cost markers showed <2.5 ms CPU through the stall (refuted grid/CPU); cross-clock correlation via `clientEpochMs` put the stall ~6.5 s *after* the room-swap completed (refuted room-swap). The honest move at that point was **not a fourth guess** — it was to instrument the black box (F-transit-instrument: gated discrete `transit_mark` lifecycle markers + a bounded `transit_frame` burst across engage→leave→seat-consume→first-state→`resetPredictionState`→first-snapshot-reconcile→curtain-down→post-reveal). One on-device capture (`2026-05-16T11-59-43-103Z-tl56wa`) then named the step in one read: `first_snapshot` `driftUnits` **210 / 380 / 87**.

**Root cause.** `resetPredictionState()` (called once, from the `transit_ready` handler) carries a doc comment promising the destination's first snapshot "is treated like a fresh-connect seed". That was true for the RTT/timing state it visibly re-creates (welford, lookahead, drop-detector, anchor — the 2026-05-09 pollution fix) and **silently false for the spatial body**: it never despawned the local `predWorld` ship body and never dropped the `Reconciler`. The `transit_ready` mirror-cleanup loop *preserves* the local ship, so at the destination `tryInitPredWorld` early-returned on `predWorld.hasShip(localId)` and the body arrived still at the **source-sector pose**. The destination's first `handleSnapshot` reconciled that stale body against the arrival pose (configurable-arrival / SAB-clamped, hundreds of units away) ⇒ the reconciler saw the entire source→destination delta as "drift" and lerped it out over ~1.3 s post-curtain. That lerp *is* the "lag" — choppy 33–144 ms frames with `raf_gap`s to 344 ms while the correction plays. Intermittency = how far the arrival point landed from the pre-transit pose (configurable-arrival makes it vary — hence 210 one warp, 87 another).

Fix: `resetPredictionState()` now also despawns the local predWorld body and nulls the `Reconciler`, so the destination's first state-diff / snapshot reseeds via the existing `tryInitPredWorld` path **at the authoritative arrival pose** (which rebuilds the Reconciler). `tickPhysics` + `handleSnapshot` already guard `!this.reconciler` (the pre-first-welcome state), so this re-enters a well-tested state rather than inventing one. One ownership site; no second correction path. Test-first per Invariant #13: `ColyseusClient.transitArrivalDrift.test.ts` drives the real seed→reset→reseed→first-snapshot sequence on a real `ColyseusGameClient` + real `PhysicsWorld` and asserts first-arrival `reconciler.lastDrift < 5` — RED at 384 u pre-fix, GREEN ~0 post-fix, re-fails on revert.

**Carry-forward lessons.**
1. **A `reset()`/`clear()` that claims a clean slate must be audited against EVERY piece of state on its surface, not just the fields it enumerates.** The comment said "fresh-connect seed"; the code reset 9 timing fields and silently inherited the spatial body + reconciler. A doc comment is an intention, not a guarantee — diff it against reality. The 2026-05-09 fix to *this same method* (for the *timing* pollution) created false confidence it was already complete.
2. **When successive evidence-backed hypotheses all falsify, stop theorising and instrument the black box.** Three wrong theories cost real cycles; the resolution came the moment a CLIENT-ts marker existed at the actual failure point. "No log events near the stall" was itself the finding — an instrumentation gap, not an absence of cause. (Reinforces the 2026-05-15 "on-device evidence over engine-internals theory" lesson and the user's "more logging, more tests, more instrumentation, that's how we fix this.")
3. **Prediction-seed bugs masquerade as render/perf bugs.** A large one-shot reconcile correction is visually indistinguishable from a frame-rate hitch on a phone. Before blaming the GPU/filters/labels for post-transit jank, check `first_snapshot` drift.

## 2026-05-16 — Warp (Phase G) — the WarpScreen never re-showed on consecutive transits: the SAME "comment promises a re-seed the code only does on another path" class — and Bug A was a *consequence* of Bug B

Two user smoke-test reports were filed as separate warp bugs: (A) "double arrival flash" on an inter-sector transit, (B) the WarpScreen status text shows on the first warp but never on the 2nd+. They turned out to be **one root cause + a coupling**.

**Root cause (Bug B), third instance of the 2026-05-09 / 7829d04 class.** `store.ts setPhase`'s comment claimed it "re-arms the WarpScreen — every entry into 'game' (initial join, ship-swap arrival, **transit arrival**)". It only re-armed on a *phase change* (`prev.phase !== 'game'`). A pure inter-sector transit keeps `phase==='game'` the whole time (only the Colyseus room hot-swaps), so `setPhase` returned a bare `{ phase }` and **never re-armed** — `useGameReady()` stayed stuck-true, `WarpScreen.visible` stayed `0`, and the load-bearing 5 s minimum-display floor (`joinMinimumElapsed`, armed by a `useEffect(…, [])` that only runs on GameSurface *mount* — which a pure transit doesn't trigger) never re-ran. This is *exactly* the 7829d04 defect class (a comment promising a re-seed the code only performs on a different path) — the **third** time the transit lifecycle has shipped this same shape (2026-05-09 welford pollution → 7829d04 spatial body → this). The transit path is a serial offender; treat every "reset on X" comment there as guilty until diffed against the pure-transit path.

**The coupling — Bug A was downstream of Bug B.** `loading = !gameReady || transitState IN_TRANSIT/ARRIVED`. The SPOOLING→IN_TRANSIT `setWarpMode(false)` spool-climax burst was *designed* to be hidden behind a simultaneous curtain rise (an author comment said so). But because Bug B left `gameReady` stuck-true, `!gameReady` was false, so `loading` only went true via the explicit `transitState==='IN_TRANSIT'` term — a beat *after* the burst fired. Player saw burst#1 (spool-exit) **and** flash#2 (curtain-drop `triggerWarpIn`) ≈ 200-500 ms apart = "double flash". Fixing Bug B (re-arm → `gameReady` false at `transit_ready` → `!gameReady` raises the curtain *at* `transit_ready`, before the IN_TRANSIT burst) masks burst#1 → single arrival flash. **Bug A required no dedicated code change.** Lesson: when two smoke-reported visual bugs live in the same lifecycle, map the shared state machine *before* fixing either — the fix for one is often the other, and "fixing" them independently would have stacked a redundant patch.

**The fix + a plan-vs-implementation refinement worth recording.** One consolidated `rearmJoinReadiness()` store action (clears `firstSnapshotApplied` + `joinMinimumElapsed`, bumps a monotone `joinGeneration`), invoked from the `transit_ready` handler as a sibling line to `resetPredictionState()` — the UI-readiness analogue of the one spatial-seed ownership site. The 5 s timer effect is re-keyed `useEffect(…, [joinGeneration])` so it re-runs per committed transit (the literal `setTimeout(…,5000)` is unchanged — the floor is not weakened, it now re-runs instead of never). The approved plan's B-2b step proposed also resetting `rendererFirstFrameRendered` and gating its re-latch on `mirror.ships.has(localId)`. **Implementation falsified that step:** the `transit_ready` mirror-cleanup loop *preserves* the local ship entry (only remote ships are dropped), so that gate would re-latch instantly; and more fundamentally, resetting `rendererFirstFrameRendered` on a transit is *semantically false* — the renderer is continuously painting across a transit (it is never recreated; GPU-init lag is an initial-join-only concern, handled by `setPhase` which remounts GameSurface). Correct minimal design: `rearmJoinReadiness` resets **2** flags, `setPhase` resets **3** — they legitimately differ, so DRY shares only the overlap (`commonReadinessRearm`), not the divergent flag. This *removed* an entire risky App.tsx `firstFramePixiLogged` surgery the plan had flagged as its highest-nuance step (R6). **Carry-forward: a plan derived from reading is a hypothesis; when an implementation discovery (here: "mirror cleanup preserves the local entry") contradicts a plan step, simplify toward the *semantically truthful* state — do not force symmetry for its own sake.**

Test-first per Invariant #13, at the level the bug lives (store + component + wiring): `store.rearmJoinReadiness.test.ts`, `WarpScreen.transit.test.tsx` (drives two consecutive simulated transits — the literal user complaint — + a 4-vs-5 gate-drift lock: WarpScreen now calls `useGameReady()` directly, a prior local 4-gate copy had silently dropped `firstSnapshotApplied`), `ColyseusClient.transitRearmReadiness.test.ts` (the reset *group* — reverting 7829d04 OR the new sibling line re-fails it). All RED pre-fix, GREEN post-fix.

## 2026-05-16 (later) — Warp (Phase G3) — the "Bug A is masked, no code change needed" conclusion was itself theory; on-device falsified it → Option A

The entry above states Bug A "required no dedicated code change" — fixing Bug B's curtain timing would mask the spool-exit burst → single flash. That was an over-confident *theoretical* conclusion (and the user had earlier picked the matching "keep the climax, mask it" option via AskUserQuestion — also without device evidence). **First on-device smoke test falsified it.** Post-G1 the curtain is *always* up before the IN_TRANSIT `setWarpMode(false)` burst, so that climax is now *always* occluded — never a visible climax — AND the ~200 ms curtain-rise tween vs the fast room-swap let it BLEED through: the user saw "a flash while the cover is on", then a 1–3 s opaque hold (the 5 s floor), then the curtain drop + the real `triggerWarpIn` flash. A reordered double-flash with a blackout between — arguably worse than the original.

Fix (G3, Option A): the burst now fires from exactly ONE site — the arrival reveal (`triggerWarpIn`). `setWarpMode(false)` fades the filter chain out only. Both `fireBurst()` call-sites defer to a pure `warpEventFiresBurst(event)` policy (extracted beside `shouldDetachWarpVisual`, the established "make a PixiRenderer warp decision unit-lockable without a Pixi app" pattern), regression-locked by `PixiRenderer.warpBurst.test.ts` (RED pre-fix: helper absent; GREEN post).

**Carry-forward lessons.**
1. **An effect you "mask" instead of remove is debt that the device collects.** Option B kept a burst whose only post-condition was "fires invisibly under a curtain" — i.e. pure cost, zero benefit, plus a leak surface (the imperfect-opacity bleed). When a fix's premise is "the user won't see X because Y hides it", that's a theory about rendering/timing — verify on-device or prefer deleting X. (Reinforces 2026-05-15 "on-device evidence beats engine-internals theory" and the user's standing "automated repro first, on-device falsifies whole theory classes".)
2. **A design decision taken via a question is still a hypothesis until the device confirms it.** Option B was an explicit user choice — but made from a verbal description, not the running build. Treat pre-implementation design picks the same as code-read hypotheses: not done until on-device. Re-surfacing the choice with the on-device evidence (B falsified → A) was correct, not churn.
3. **"No code change needed" is a claim that needs a test too.** The G1/G2 locks asserted call *ordering*; none asserted "exactly one burst per transit", which is why the wrong-but-passing state shipped — the classic Invariant-#13 "locked the wrong assertion / level" trap. The new policy lock closes it.
