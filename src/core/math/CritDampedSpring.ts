/**
 * Critically-damped spring step (analytical closed-form).
 *
 * A critically-damped spring approaches its target without overshoot, with
 * velocity smoothly carrying through. Compared to a linear or polynomial
 * decay (Stage 0's ease-out shape), the spring reads as "alive" — the
 * smoothing operator has memory of recent motion rather than just the
 * current offset.
 *
 * The closed-form analytical step is exact and frame-rate independent: a
 * 200 ms total run stepped at dt=8 ms (120 Hz) and at dt=33 ms (30 Hz)
 * produce identical end states to floating-point precision. This matters
 * because the renderer runs at the device's actual rAF cadence which can
 * vary mid-session — ProMotion 120 Hz fallback to 60 Hz on iOS Safari,
 * Android battery throttling to 15 Hz. A frame-rate-coupled integrator
 * would visibly jitter at those transitions.
 *
 * `halfLifeMs` is the user-facing time for the offset to halve when
 * starting from rest (v₀ = 0). The internal angular frequency `ω` is
 * derived so that `x(halfLife) / x(0) = 0.5` for the critically-damped
 * solution — this gives the parameter its colloquial physical meaning
 * rather than the standard `ω = ln(2) / halfLife` (which would make the
 * spring's actual halfLife about 5× longer than the parameter's name).
 *
 * Mutation rather than return: hot-path callers (renderer, reconciler)
 * step springs every frame and shouldn't allocate.
 */

/** K such that (1 + K) · exp(-K) = 0.5.
 *  Numerical solution; precision sufficient for game-feel work. */
const HALF_LIFE_K = 1.6783469900166614;

export interface SpringState {
  /** Current state value. */
  x: number;
  /** Current velocity (rate of change of x per ms). */
  v: number;
}

/**
 * Advance the spring by `dtMs` toward `target`. Mutates `state.x` and
 * `state.v` in place.
 */
export function springStep(
  state: SpringState,
  target: number,
  halfLifeMs: number,
  dtMs: number,
): void {
  if (halfLifeMs <= 0 || dtMs <= 0) return;
  const omega = HALF_LIFE_K / halfLifeMs;
  const offset = state.x - target;
  const expDecay = Math.exp(-omega * dtMs);
  // Critical-damping closed-form solution:
  //   ε(t) = (ε₀ + (v₀ + ω·ε₀)·t) · exp(-ω·t)
  //   v(t) = (v₀ - ω·(v₀ + ω·ε₀)·t) · exp(-ω·t)
  // where ε is offset = state.x - target, and ω = K / halfLife.
  const newOffset = (offset + (state.v + omega * offset) * dtMs) * expDecay;
  const newVel = (state.v - omega * (state.v + omega * offset) * dtMs) * expDecay;
  state.x = newOffset + target;
  state.v = newVel;
}
