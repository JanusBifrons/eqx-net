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
| Remote ship display delay | INTERP_DELAY_MS = 100ms | 100ms ✅ |

---

## What would make this feel "flawless"

1. **Collision corrections consistently < 2u** — the main remaining gap. Fixed in current pass by correcting obstacle temporal frame. Residual comes from other ships changing asteroid velocities between snapshots.

2. **Server sending collision events** (Phase 4 scope) — when a collision happens server-side, broadcast a lightweight `{type:'collision', ids:[...], vPost:...}` message. Client applies the velocity change immediately rather than waiting for the next snapshot (50ms). Residual correction drops to near-zero.

3. **Shorter adaptive lerp for large corrections** — a 40u collision correction over 300ms looks like a slow glide. Consider snapping in 100ms instead. (Currently at 18 frames = 300ms for > 20u corrections.)

4. **Reduce INTERP_DELAY_MS to 50ms** — once snapshot jitter is confirmed stable at < 20ms (it is), the 100ms display buffer is twice as large as needed. Cutting to 50ms halves the visual lag of remote ships.

---

## How to read the dev overlay

- **RTT**: half the round-trip time (ms). At 350ms RTT, ticksAhead ≈ 21.
- **drift**: position delta between prediction and server at last reconcile. Should be 0 when coasting, small spikes during collisions.
- **corrections**: count of snapshots where drift > 0.05u. Most come from asteroid collisions.
- **ticksAhead**: how many ticks the client is running ahead. Stable at ~18–22 for 300–360ms RTT.
- **rollingCorrRate**: correction rate over the last 10 snapshots (0–1). > 0.20 sustained indicates a prediction bug.
