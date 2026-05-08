# EQX Peri — Prediction Feel Goals

## What the system is doing and why

EQX Peri uses **client-side prediction**: the client runs a full physics simulation ahead of the server so that inputs feel instant. The server is the authority; the client is a preview.

```
         ackedTick          serverTick      inputTick (you are here)
              │                  │                  │
server: ──────●──────────────────●                  │
client: ────────────────────────────────────────────●
              │←── ticksAhead (~20 ticks, ~333ms) ──│
```

- **Orange ghost** = server's authoritative position at `serverTick` (the past)
- **Your ship** = client's predicted position at `inputTick` (the future)
- **The gap is intentional.** Without it, every input would feel delayed by half your RTT (~165ms). With it, inputs are instant.

---

## What "perfect" looks like for each scenario

### 1. Idle / coasting (no inputs)
**Goal**: zero drift. The physics is deterministic — if both sides run the same simulation from the same state, they agree exactly.

**Current state**: ✅ achieved. Idle drift is 0.000 units.

**The visual gap remains**: even at 0 drift, the ghost is behind by `velocity × ticksAhead × dt`. At 30 u/s and 20 ticks ahead: ~10 units. This is not lag — it's the prediction window.

### 2. Thrust / rotation (active inputs)
**Goal**: < 15% correction rate over any 5-second window. The remaining ~10% are asteroid collision events (correct server-side physics), not prediction errors.

**Current state**: ✅ achieved. W-thrust correction rate ≈ 8–14% (collision-induced).

### 3. Collisions
**Goal**: client predicts the collision locally (instant bounce visible to you) with a correction magnitude small enough that the server adjustment is imperceptible (< 2 units).

**Current state**: ⚠️ partially achieved. The client does simulate collisions in its local physics world, but there was a temporal mismatch: obstacles were being reset to `serverTick` position after each snapshot while the ship stayed at `inputTick` (20 ticks ahead). This caused collision detection to run with the ship and obstacles out of sync by ~333ms of movement, producing corrections of 5–30 units.

**Fix shipped**: obstacles are now extrapolated forward to `inputTick` position after each snapshot, so ship and asteroid exist in the same moment in time for collision detection.

### 4. Remote ships
**Goal**: smooth 100ms display-delay, no freezing during packet gaps.

**Current state**: ✅ achieved. Dead-reckoning fills 100ms gaps; angle wraps correctly through 0/2π.

---

## What cannot be "1:1"

"Server and client position are the same" would require 0ms RTT. That is physically impossible on any real network.

The correct measure is:
- **Drift** (does the server agree with where the client thinks it is?) — should be near-zero
- **Correction magnitude** (when the server disagrees, how far off?) — should be < 2u for normal movement, < 10u for collisions
- **Correction frequency** (how often does the server disagree?) — should be near-zero except during collisions

---

## Known ceilings with the current architecture

| Scenario | Best achievable | Current |
|---|---|---|
| Idle drift | 0 units | 0 units ✅ |
| Thrust correction rate | ~0% (only collision events) | ~10% ✅ |
| Collision correction magnitude | < 2u (obstacle velocity constant) | 5–30u before fix, improving |
| Collision correction, velocity changed by another ship | Unavoidable until next snapshot (50ms) | Accepted |
| Remote ship display delay | DISPLAY_DELAY_MS = 50ms (post Stage 0) | 50ms ✅ |
| Lerp duration on large drift | 100ms (post Stage 0) | 100ms ✅ |

---

## What would make this feel "flawless"

1. **Collision corrections consistently < 2u** — the main remaining gap. Partially fixed by correcting obstacle temporal frame. Residual comes from other ships changing asteroid velocities between snapshots; fully resolved by Stage 2 of the network-feel roadmap (server-broadcast collision events).

2. **Server sending collision events** — Stage 2 of the network-feel roadmap. When a collision happens server-side, broadcast a lightweight `collision_resolved { aId, bId, vA, vB, impulse, tick }` message. Client applies the velocity change immediately rather than waiting for the next snapshot (50 ms). Residual correction drops to near-zero. See `plans/network-feel-roadmap.md`.

3. ✅ **Shorter adaptive lerp for large corrections** — done in Stage 0 of the network-feel roadmap (2026-05-08). The 18-frame / 300 ms tier was capped at 6 frames / 100 ms for any drift above the sub-pixel tier, and a quadratic ease-out shape replaced the linear decay. Verified end-to-end by `tests/e2e/feel-tuning.spec.ts`: 73 corrections observed under thrust-into-drone-ring, max queued lerp duration = 6 frames, max drift in window = 80 u.

4. ✅ **Reduce INTERP_DELAY_MS to 50 ms** — done in Stage 0 of the network-feel roadmap (2026-05-08). Floor halved (100 → 50 ms), adaptive ceiling tightened (350 → 200 ms) since measured snapshot jitter has been stable < 20 ms.

---

## Measured after Stage 0 (network-feel roadmap, 2026-05-08)

Constant + shape changes:

| Symbol | File | Before | After |
|---|---|---|---|
| `lerpFramesForDrift` largest tier (Reconciler) | `src/core/prediction/Reconciler.ts` | 18 frames (300 ms) | 6 frames (100 ms) |
| `lerpFramesForDrift` cascade (ColyseusClient remote-ship) | `src/client/net/ColyseusClient.ts` | 6 / 10 / 14 frames | 6 frames (uniform) |
| `Reconciler.advanceLerp` ratio | `src/core/prediction/Reconciler.ts` | linear `framesLeft / total` | ease-out quadratic `(framesLeft / total)²` |
| `ColyseusClient` remote-ship offset ratio | `src/client/net/ColyseusClient.ts` | linear | ease-out quadratic |
| `DISPLAY_DELAY_MS` | `src/client/net/swarmInterpolation.ts` | 100 ms | 50 ms |
| `ADAPTIVE_DELAY_CEILING_MS` | `src/client/net/swarmInterpolation.ts` | 350 ms | 200 ms |

Tier-2 acceptance: `tests/e2e/feel-tuning.spec.ts` — 73 corrections observed during a 3 s thrust into the legacy `sector` drone ring, max queued lerp = **6 frames** (cap 6), max drift in window = 80 u.

Telemetry surface added: `Reconciler.lerpTotalFrames` is now public-readable; `ColyseusClient`'s 'correction' log entry carries the value.

---

## Measured after Stage 1 (network-feel roadmap, 2026-05-08)

Stage 1 replaced the Stage 0 frame-counter + ratio² ease-out with a critically-damped spring (analytical closed-form). See `docs/architecture/prediction-and-correction.md` for the full picture.

| Symbol | File | Before (Stage 0) | After (Stage 1) |
|---|---|---|---|
| `lerpFramesForDrift` (Reconciler) | `src/core/prediction/Reconciler.ts` | 3 / 6 frames (frame-counter) | `halfLifeForDrift` 12 / 25 ms (spring) |
| `lerpFramesForDrift` (ColyseusClient) | `src/client/net/ColyseusClient.ts` | 6 frames (frame-counter) | `remoteOffsetHalfLifeForDrift` 12 / 25 ms (spring) |
| `Reconciler.advanceLerp` shape | `src/core/prediction/Reconciler.ts` | quadratic ratio² (frame-rate coupled) | analytical critically-damped spring (frame-rate independent) |
| `Reconciler.advanceLerp` signature | `src/core/prediction/Reconciler.ts` | `()` — implicit "one frame" | `(dtMs)` — caller passes actual frame delta |
| Termination | both files | `framesLeft <= 0` (timer) | both `|x| < LERP_THRESHOLD` AND `|v| < 50 u/s` (threshold-based) |
| Telemetry log payload | `ColyseusClient` `'correction'` event | `lerpTotalFrames: number` | `lerpHalfLifeMs: number` |
| New module | `src/core/math/CritDampedSpring.ts` | — | analytical step + 4 property tests |

Tier-2 acceptance: `tests/e2e/feel-tuning.spec.ts` re-run under Stage 1 — 37 corrections observed during a 3 s thrust into the legacy `sector` drone ring, **max queued halfLife = 25 ms (cap 25)**, max drift in window = 27 u.

Bench (`benchmarks/spring.bench.ts`): single `springStep` call ~285 ns; amortized cost in the realistic case (100 parallel springs / frame, matches local + 32 remote × 3 axes) is **~117 ns/spring**, well under the 200 ns target. Single `Math.exp` call dominates; no further optimisation needed.

Frame-rate independence: `CritDampedSpring.test.ts` cycle 3 asserts dt = 8 ms vs dt = 33 ms across the same total wall-clock produce identical end states. Reconciler integration test asserts the same property through the full call path.

---

## How to read the dev overlay

- **RTT**: half the round-trip time (ms). At 350ms RTT, ticksAhead ≈ 21.
- **drift**: position delta between prediction and server at last reconcile. Should be 0 when coasting, small spikes during collisions.
- **corrections**: count of snapshots where drift > 0.05u. Most come from asteroid collisions.
- **ticksAhead**: how many ticks the client is running ahead. Stable at ~18–22 for 300–360ms RTT.
- **rollingCorrRate**: correction rate over the last 10 snapshots (0–1). > 0.20 sustained indicates a prediction bug.
