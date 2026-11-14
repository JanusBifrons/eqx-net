# Prediction and Correction — Local Visual Lerp

The client runs ahead of server time so that input feels instant; whenever the server sends an authoritative snapshot the client has to **reconcile** its predicted state against what the server actually decided. When the two disagree by more than the noise floor, the difference is shown as a *visual* correction lerp — a render-time offset that decays toward zero — so the user sees a smooth nudge rather than a hard teleport.

This document covers **what the lerp looks like** and **why** it works the way it does. For the broader prediction architecture (input ring buffer, replay, server-authoritative reconciliation) see [src/core/prediction/Reconciler.ts](../../src/core/prediction/Reconciler.ts) and [docs/FEEL_GOALS.md](../FEEL_GOALS.md).

## Two layers, two springs

| Layer | Owns | Spring math |
|---|---|---|
| Local ship | `Reconciler.lerpOffset / lerpAngleOffset` | 3 axes (x, y, angle) of `SpringState` |
| Remote ships | `ColyseusClient._remoteShipOffsets` | 2 axes (x, y) of `SpringState` per remote ship |

Both layers use the same primitive: the closed-form critically-damped spring step from [src/core/math/CritDampedSpring.ts](../../src/core/math/CritDampedSpring.ts). Both pick their `halfLifeMs` from the same drift-magnitude function (12 ms sub-pixel, 25 ms standard), so local and remote visual recovery move in lockstep.

## Why critical damping (and not a polynomial ease-out)

Stage 0 of the network-feel roadmap (commits `4a31b7d` / `b8a6ee0`) used a frame-counted ratio² ease-out — a polynomial decay tied to render-frame indices. That works at a steady 60 Hz, but on devices where rAF cadence varies mid-session it gets visibly wrong:

- **ProMotion 120 Hz fallback to 60 Hz on iOS Safari** — same lerp lasts twice as long when displayed; a "100 ms" correction becomes a "200 ms" glide.
- **Android battery-throttled rAF (~15 Hz observed in `diag/captures/2026-05-08T12-01-30-847Z-omekg0.json`)** — a "6-frame lerp" runs for 400 ms instead of 100 ms.

Stage 1 replaced the ease-out with a **critically-damped spring** stepped by the analytical closed-form solution

```
ε(t) = (ε₀ + (v₀ + ω·ε₀)·t) · exp(-ω·t)
v(t) = (v₀ - ω·(v₀ + ω·ε₀)·t) · exp(-ω·t)
```

with ω = K / halfLifeMs and K = 1.6783… chosen so `x(halfLife)/x(0) = 0.5` for v₀ = 0 (the colloquial physical meaning of "half-life"). The closed-form is *exact* — stepping with dt = 8 ms vs dt = 33 ms produces identical end states to floating-point precision. There is no integration scheme, no dt-coupling, no chance of mid-session drift between the visible lerp time and wall-clock time.

The spring's other properties:

- **Critically damped** ⟹ no overshoot. Under-damped (= bouncy) would visibly ring after a correction; over-damped (= sluggish) would feel like syrup.
- **Velocity carries through.** Unlike a polynomial decay, the spring has memory of its motion in `state.v`, so it reads as a physical object settling rather than an exponential decay. This is the "alive" quality referred to in the Stage 1 commit messages.
- **Mutates in place.** `springStep(state, target, halfLifeMs, dtMs)` is a hot-path call (renderer × O(remote-ships) × 3 axes per frame) and pre-allocates nothing.

## Half-life selection

```
halfLifeForDrift(drift):
  drift < 0.5u  →  12 ms       (sub-pixel; ~75 ms total settle)
  else          →  25 ms       (~125 ms total settle)
```

Both `Reconciler.halfLifeForDrift` and `ColyseusClient.remoteOffsetHalfLifeForDrift` use these same values. The selection is keyed on *drift magnitude* (how far off the prediction was), not on velocity or speed of motion — the *amplitude* of the visible correction varies with drift, the *settling time* doesn't. Result: a 30 u drift and a 5 u drift both finish settling at roughly the same wall-clock instant, just with different visible amplitudes.

The 25 ms half-life was picked deliberately to keep total settle (offset back below `LERP_THRESHOLD` = 0.05 u) under ~125 ms — close to Stage 0's 100 ms cap, retaining the feel-roadmap's "decisive" quality while gaining the spring benefits. Earlier suggestions of 40–110 ms half-life were 2–5× slower than Stage 0 by analytical comparison; this would have been a perceptible feel regression. See `plans/network-feel-roadmap.md` Decision Log entry 2026-05-08 for the math.

## Termination

The spring ends when both position and velocity fall below their respective thresholds:

```
SPRING_POS_END        = 0.05 u    (= LERP_THRESHOLD, the noise floor)
SPRING_VEL_END_MS     = 0.05 u/ms (= 50 u/s, below ship speeds)
SPRING_ANGLE_END      = 0.001 rad (= ANGLE_LERP_THRESHOLD)
SPRING_ANGVEL_END_MS  = 0.001 rad/ms
```

Threshold-based termination is preferred over a fixed timer because it gives the lerp a physically meaningful end condition: small initial drifts end almost immediately (the spring's residual is below the noise floor on the first frame), large initial drifts take proportionally longer. A fixed timer would either cut off large corrections too early (visible "twitch" at the cut point) or hold small corrections open after they're done.

## Adaptive lookahead (Stage 4)

Pre-Stage-4 the prediction-window size (`leadTicks`) was an EWMA-smoothed function of RTT mean only:

```
desiredLead = max(3, min(20, round(rtt / 33)))
leadTicks   = round(leadTicks * 0.85 + desiredLead * 0.15)
```

This works for stable links but **under-buffers** unstable ones — when jitter spikes exceed the prediction window the input loop visibly catches up in chunks. Stage 4 splits the controller into two pure modules:

1. **`Welford` ([src/core/math/Welford.ts](../../src/core/math/Welford.ts))** — single-pass online mean + variance, with a 600-sample reset window so float drift is bounded over multi-hour sessions.
2. **`lookaheadController` ([src/client/net/lookaheadController.ts](../../src/client/net/lookaheadController.ts))** — replaces the EWMA. `desiredLead = clamp(ceil((mean + 2σ) / 16.67 ms), 3, 30)`. The `2σ` band statistically covers ~97.5% of jitter spikes; the 3-tick floor ensures even a zero-RTT loopback has a prediction window.

Multi-tick target jumps ramp via Stage 1's `CritDampedSpring` (100 ms half-life ≈ 200 ms total settle); ≤1-tick changes snap directly to avoid perpetual half-tick spring oscillation on per-snapshot integer noise. Frame-rate independent: the closed-form spring step gives identical results at 8 ms vs 33 ms cadence.

## Snapshot drop detection + adaptive interp delay (Stage 4)

The swarm-interp buffer's pre-Stage-4 floor was driven only by the EWMA of inter-arrival times. When the wire drops snapshots, that EWMA goes UP (intervals look longer) but only after a few snapshots, and the buffer can briefly run out of bracketing arrivals — visible as a sprite freeze + recovery glitch.

[`snapshotDropDetector`](../../src/client/net/snapshotDropDetector.ts) tracks per-snapshot serverTick deltas in a sliding 10-snapshot window. A delta > 3 indicates dropped snapshots; the recent count is converted via `computeInterpBiasMs(droppedCount) = min(droppedCount × 16.67 ms, 200 ms)` and added to `setSwarmDisplayDelayMs`. Bias decays naturally as drops age out of the window.

Out-of-order / duplicate / backwards ticks are silently ignored — they're not "drops" in any meaningful sense.

## What this layer does *not* fix

- **Server-side prediction errors.** If the server's authoritative state is itself wrong (bug in `applyInput` server-side, mis-applied collision, mis-counted impulse), the spring will still smoothly show whatever wrong correction the server demands. The spring is a presentation layer, not a correctness check.
- **Multi-second network freezes.** Stage 4's `2σ` lookahead protects against jitter, not catastrophic stalls. A 2 s buffer expansion would feel like input lag — the cap at 30 ticks (500 ms) deliberately doesn't try.
- **Server CPU saturation.** When the server's tick rate drops (TiDi room with 4000 entities; see `docs/LESSONS.md` Pattern B), corrections come slower because *snapshots* come slower; the spring has nothing to compensate at that layer.

Stage 6 (packet-loss resilience) of the network-feel roadmap addresses sustained-loss recovery at the appropriate layer.

## Telemetry

`Reconciler.lerpHalfLifeMs` is public-readable (was `lerpTotalFrames` in Stage 0); `ColyseusClient` plumbs it into the existing `'correction'` log entry. The end-to-end spec [tests/e2e/feel-tuning.spec.ts](../../tests/e2e/feel-tuning.spec.ts) reads the log entries and asserts every queued correction's halfLife is ≤ 25 ms — verifying the production reconcile path picks half-lives within bounds.

Stage 4 added three public-readable fields to `PredictionStats`: `rttMeanMs` (Welford running mean), `rttStdDevMs` (Welford σ), and `droppedSnapshotsRecent` (sliding-window drop count). The next user diagnostic capture surfaces these for inspection alongside the existing RTT/jitter metrics.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **Pre-welcome guard in `syncMirror()`.** Colyseus delivers the initial state patch (`onStateChange`) BEFORE the welcome message sets `mirror.localPlayerId`. During this window, `localPlayerId` is `null` and the `playerId !== localId` guard evaluates to `true` for ALL ships — including the joining player's own ship. Any predWorld spawn in the remote-ship branch MUST be gated with `localId !== null` to prevent the local ship from being spawned as a remote body. If it is, `tryInitPredWorld()` finds `hasShip(localId) === true` and exits early without creating the Reconciler, breaking all physics. `tryInitPredWorld()` retrospectively spawns any remote ships that were seen before `localId` was set.

- **Prediction** (Phase 3): the client predicts its own ship by stepping the same `src/core/physics/World` the server uses, then reconciles against authoritative snapshots. Drift ≥ `LERP_THRESHOLD` (0.05 u position / 0.001 rad angle, just above float32 noise) triggers a visual lerp; lerp duration scales with magnitude (3–18 frames). Remote ships interpolated with a 100 ms display-delay buffer.

- **Wall-clock-anchored input loop** (Phase 5 / sub-phase A): `tickPhysics()` derives `targetTick` from `(now − welcomePerfNow) / 16.6667` rather than running a free accumulator with a frame-cap. This is essential on mobile: any main-thread block (touch dispatch, scroll, GPU hiccup) that previously discarded elapsed time beyond 5 frames now produces at most a brief catch-up window — `inputTick` always represents real wall-clock time, so `serverTick` and `inputTick` cannot drift apart. Per-RAF catch-up is capped at `MAX_CATCH_UP_TICKS = 4` to amortise CPU after a long pause. If you re-introduce an accumulator-with-cap, you re-introduce the 30–60 % mobile `corr` regression. **A backlog over `STALL_SKIP_TICKS` (30 ticks, 0.5 s) is a STALL and is skipped (`skipStalledBacklog`), not replayed** — the loading curtain (tickPhysics is skipped while it's up), a background tab. Replaying it at 4 ticks a frame ran the client ~2.5× ahead of the server for tens of seconds and reconciled it back every snapshot (20 Hz ship judder after a long curtain; LESSONS 2026-11-05). Lock: `tests/e2e/loading-catchup.spec.ts`.

- **Ghost projectiles** (Phase 4): on fire input, immediately spawn a client-only sprite (`GhostManager` in `src/client/combat/GhostProjectile.ts`). On `hit_ack` arrival, call `ghostManager.resolve(clientShotId, hit)` to fade the ghost. TTL 500 ms — if no `hit_ack` arrives, ghost fades automatically. Ghosts never declare destruction server-side.

- **Ghost mirror cleanup**: `GhostManager.update(out)` MUST `out.delete(id)` for any ghost it removes from its internal map (expired or resolved), not just delete from the internal map. `ColyseusClient.syncProjectiles()` deliberately preserves entries with `isGhost: true` during snapshot reconciliation so client-side ghosts survive a server snapshot that doesn't yet know about them — but that means the ghost manager is the **only** code path that can clean up ghost entries from `mirror.projectiles`. If you ever see laser bolts "stuck" at the spawn point or duplicate static sprites alongside the moving one, this contract has been broken. Regression test: [combat/GhostProjectile.test.ts](../../src/client/combat/GhostProjectile.test.ts).

- **Fire input**: `Keyboard.fire` is a one-shot boolean. `read()` returns `fire: this.firePending` and immediately clears `firePending = false`. The keydown handler sets `firePending` only when `!e.repeat` — no hold-fire. `tickPhysics()` calls `sendFire(tick)` when `fire` is true, then the field is already cleared.

- **Forward direction for fire ray**: same as thrust — `(-sin(angle), cos(angle))`. Ray origin offset 20 units ahead of ship centre to avoid self-hit.

- **Sector handoff resets prediction state.** The `transit_ready` handler hot-swaps the room's WebSocket via `consumeSeatReservation` but reuses the same `ColyseusGameClient` instance. Any state that contributes to the prediction window — Welford RTT (`_rttWelford`), the spring-smoothed `LookaheadController` (`_lookaheadCtrl`), the snapshot drop detector (`_dropDetector`), the clock anchor (`_anchorInitialised` / `clockAnchorServerTick`), the rolling interval/correction buffers, `leadTicks`, the `Reconciler` instance, AND the local `predWorld` ship body — MUST be re-initialised in `resetPredictionState()` on transit. Surviving state is poisoned by the 5+ s warp gap: clamped-but-still-pushed RTT samples drift the welford mean up, `mean + 2σ` saturates the 30-tick `CEILING_TICKS`, and the client predicts ~600 ms ahead for tens of seconds post-arrival (visible as `srvTick − ackedTick` locked at ~−37, 60–70 % correction rate, ship rendered far from server-authoritative position). **The spatial body is part of this state (2026-05-16).** The `transit_ready` mirror-cleanup loop preserves the local ship, so before this fix `tryInitPredWorld` early-returned on `predWorld.hasShip(localId)` at the destination and the body arrived still at the SOURCE pose; the first destination `handleSnapshot` then reconciled the full source→destination delta as "drift" (210-380 u on-device, diag `2026-05-16T11-59-43-103Z-tl56wa`), which the reconciler lerped out over ~1.3 s post-curtain — the warp-out jank. `resetPredictionState()` now despawns the local predWorld body and nulls the `Reconciler` so the destination's first state-diff / snapshot reseeds it at the AUTHORITATIVE arrival pose (one ownership site; no second correction path — Invariant #12 philosophy). `tickPhysics` + `handleSnapshot` already guard `!this.reconciler` (the pre-first-welcome state), so this re-enters a well-tested state rather than inventing one. Adding new prediction-window-feeding state? Either reset it here or comment why it's safe to inherit. See [docs/LESSONS.md](../../docs/LESSONS.md) 2026-05-09 + 2026-05-16 entries. Lock tests: [net/ColyseusClient.resetPredictionState.test.ts](../../src/client/net/ColyseusClient.resetPredictionState.test.ts) + [net/ColyseusClient.transitArrivalDrift.test.ts](../../src/client/net/ColyseusClient.transitArrivalDrift.test.ts). **UI-readiness analogue (Phase G, 2026-05-16).** The same `transit_ready` handler ALSO re-arms the WarpScreen join-readiness as a sibling line — `useUIStore.getState().rearmJoinReadiness()` — clearing `firstSnapshotApplied` + `joinMinimumElapsed` and bumping `joinGeneration` (which re-runs the App.tsx 5 s minimum-display timer; a pure transit doesn't remount GameSurface so its `[]`-dep effect would never otherwise re-arm). `setPhase`'s comment claimed it re-armed "every entry into 'game' incl. transit arrival" but a pure inter-sector transit keeps `phase==='game'` so it never fired — the *same* "comment promises a re-seed the code only does on another path" defect class as the spatial bug above. `rendererFirstFrameRendered` is deliberately NOT re-armed on transit (the renderer stays live across a transit; GPU-init lag is an initial-join-only concern handled by `setPhase`, which remounts GameSurface — so `setPhase` resets 3 flags, `rearmJoinReadiness` resets 2). One ownership site; sibling to `resetPredictionState` (not folded in — SRP). This also collapses the "double arrival flash" (Bug A): `!gameReady` now raises the load curtain at `transit_ready`, before the IN_TRANSIT spool-exit `setWarpMode(false)` burst, masking it so only the single arrival-reveal flash is seen. `WarpScreen` now calls `useGameReady()` directly (killing a 4-vs-5 gate drift). Lock tests: [state/store.rearmJoinReadiness.test.ts](../../src/client/state/store.rearmJoinReadiness.test.ts) + [components/WarpScreen.transit.test.tsx](../../src/client/components/WarpScreen.transit.test.tsx) + [net/ColyseusClient.transitRearmReadiness.test.ts](../../src/client/net/ColyseusClient.transitRearmReadiness.test.ts).

### Input Throttling Discipline (2026-05-06)

The client may suppress redundant input sends ONLY when both the current and previously-sent input states are **fully idle** (every control bit false). Any held key — thrust, turn, boost — must be re-sent every tick, with an additional 250 ms heartbeat in idle to keep the server's session alive.

Why narrowed to all-idle: when a held input has been throttled, the server's worker re-applies the held state each tick under its synthesised-ack contract (see [src/core/CLAUDE.md](../../src/core/CLAUDE.md) → Input Queue Contract). When the client THEN sends a state change at a tick higher than the synthesised ack, the worker's max-tick-clamp jumps the ack past the intermediate ticks — silently skipping a physics step that the client's local prediction DID apply. On a fast-moving ship this surfaces as a ~8 unit drift per state-change event, with `corr` rate sticking around 20–30 %. Restricting throttling to all-idle frames is safe because held all-idle adds zero impulse — the server skipping a tick is physically equivalent.

**Rule:** any future per-tick stream that adds throttling needs the same audit: when the held state is "active" (changes physics), the server's queue must stay populated. See `docs/LESSONS.md` 2026-05-06 follow-up for the full incident.

## History

Moved from `src/client/CLAUDE.md`: why the rule is what it is, with the measurements behind it.

- **Internal work-loop cap (originally 2026-05-22 at 15 ms; lowered to 10 ms 2026-05-24, mobile-perf-reconciliation-review).** The `App.tsx` RAF loop early-returns when `deltaMs < DEFAULT_MIN_FRAME_INTERVAL_MS` (10.0 ms in [perf/frameRateCap.ts](../../src/client/perf/frameRateCap.ts)), so the simulation+mirror+postMessage work cadence is capped to prevent 120 Hz devices from doing 2× the work for zero perceptual gain (physics is fixed 60 Hz per the wall-clock anchor above; render is `every-2nd-RAF`-throttled to the worker). **Historical rationale + value drift**: the cap was originally 15 ms (captures `q4wtht` 90 Hz vs `d3cprl` 60 Hz, 2026-05-21, showed 86× more `raf_gap > 100 ms` stalls at 90 Hz with `snapshot_applied` 70 % slower — per-RAF allocation pressure triggered a thermal-cascade spiral). That value deliberately throttled 90 Hz devices to ~45 fps processed. Probe 1 on capture `3vzz3q` (2026-05-24) measured per-RAF work at ~1 ms median with ~14 ms headroom every RAF, so the original allocation-pressure concern no longer binds. The 45 fps penalty on 90 Hz devices was instead the dominant source of user-felt unplayability (capture `4qm14l`'s `device_info_calibration` confirmed 90 Hz native; `rafTick.elapsedMs` 97 % at 22 ms == the cap throttling every other RAF). The value moved to **10 ms** so 90 Hz devices process every RAF (~90 fps) while 120 Hz devices still get throttled to ~60 fps. **Do not** raise `DEFAULT_MIN_FRAME_INTERVAL_MS` above ~11 ms (would re-introduce the 45 fps throttle on 90 Hz devices — the bug this fixed) or drop it below ~8.3 ms (would cease to bind 120 Hz devices). The cap caller MUST NOT update `lastFrameTime` on a skipped RAF — otherwise the next RAF's `deltaMs` resets to ~0 and the cap never engages; this rule is enforced by the `App.tsx` loop's early-return-before-`lastFrameTime = now` ordering. The replay harness drives `tickPhysics` directly via `MockClock` and never enters the RAF loop, so this cap is invisible to deterministic tests; device-grounded validation lives in [tests/unit/frameRateCap.realCapture.test.ts](../../tests/unit/frameRateCap.realCapture.test.ts), which reads the captured `device_info_calibration` and proves the cap behaviour against the user's actual measured native rate. Synthetic-cadence lock: [tests/unit/frameRateCap.test.ts](../../tests/unit/frameRateCap.test.ts). **Runtime override**: `?fpscap=N` (Probe 3) overrides the constant for A/B testing — `?fpscap=15` reverts to old behaviour, `?fpscap=0` removes the cap entirely. Override logs `fps_cap_override` once at session start.
