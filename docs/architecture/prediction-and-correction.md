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

## What this does *not* fix

- **Server-side prediction errors.** If the server's authoritative state is itself wrong (bug in `applyInput` server-side, mis-applied collision, mis-counted impulse), the spring will still smoothly show whatever wrong correction the server demands. The spring is a presentation layer, not a correctness check.
- **Network-buffering spikes.** A 500 ms inbound-snapshot gap (see `docs/LESSONS.md` Pattern A) makes the *next* correction larger because the client has predicted forward longer; the spring still settles it within ~125 ms, but the correction's amplitude is the network's fault, not the spring's.
- **Server CPU saturation.** When the server's tick rate drops (TiDi room with 4000 entities; see `docs/LESSONS.md` Pattern B), corrections come slower because *snapshots* come slower; the spring has nothing to compensate at that layer.

Stages 4 (adaptive jitter handling) and 6 (packet-loss resilience) of the network-feel roadmap address those concerns at the appropriate layers.

## Telemetry

`Reconciler.lerpHalfLifeMs` is public-readable (was `lerpTotalFrames` in Stage 0); `ColyseusClient` plumbs it into the existing `'correction'` log entry. The end-to-end spec [tests/e2e/feel-tuning.spec.ts](../../tests/e2e/feel-tuning.spec.ts) reads the log entries and asserts every queued correction's halfLife is ≤ 25 ms — verifying the production reconcile path picks half-lives within bounds.
