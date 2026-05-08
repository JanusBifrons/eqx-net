/**
 * Stage 4 of the network-feel roadmap. Computes the client's input-clock
 * `leadTicks` from observed RTT mean + jitter (σ), and ramps the value
 * smoothly across multi-tick changes so the input loop doesn't visibly
 * yank `targetTick` around.
 *
 * Pre-Stage-4 the formula was `desiredLead = max(3, min(20, round(rtt /
 * 33)))` — RTT mean only, EWMA-smoothed at α=0.15. That under-buffers
 * unstable links (jitter spikes exceed the prediction window, causing
 * input-loop catch-up stutter) and overcorrects abrupt RTT changes (the
 * EWMA's trailing window means a real handover-driven RTT shift takes
 * 5+ snapshots to stabilise).
 *
 * Stage 4 splits these concerns:
 *
 *   1. **`computeDesiredLead(rttMean, rttStdDev)`** — pure: returns the
 *      target lookahead in ticks. Formula is `ceil((mean + 2σ) / FIXED_MS)
 *      + small floor`, clamped to `[FLOOR_TICKS, CEILING_TICKS]`. The
 *      `2σ` band statistically covers ~97.5% of jitter spikes.
 *
 *   2. **`updateLookahead(ctrl, target, dtMs)`** — stateful: snaps for
 *      ≤ 1-tick changes, spring-smooths for larger jumps. Uses
 *      `CritDampedSpring` so the math is frame-rate independent. Returns
 *      the rounded integer tick count for the input loop.
 *
 * Pure module — no I/O, no Reconciler dependency, fully unit-testable.
 */
import { springStep, type SpringState } from '../../core/math/CritDampedSpring.js';

const FIXED_MS = 1000 / 60;

/** Minimum lookahead — at least one frame's prediction window even on a
 *  zero-RTT loopback. Stops `targetTick === inputTick` edge cases that
 *  would briefly run the client in lockstep with the server (no input
 *  prediction = visible RTT lag on every keypress). */
const FLOOR_TICKS = 3;
/** Maximum lookahead — past 30 ticks (500 ms) the prediction is so far
 *  ahead of authoritative state that any meaningful drift would already
 *  be unrecoverable; further extension just speculates wider. */
const CEILING_TICKS = 30;
/** Spring half-life for lookahead transitions — 100 ms gives ~200 ms
 *  total settle, which is fast enough to track real RTT shifts (e.g.
 *  cellular handover) and slow enough to not visibly jerk on noise. */
const LOOKAHEAD_HALF_LIFE_MS = 100;
/** Below this absolute change, snap directly without the spring. Avoids
 *  the spring continually re-anchoring on natural per-snapshot tick noise. */
const SNAP_THRESHOLD_TICKS = 1;

export interface LookaheadController {
  /** Internal float-valued spring state. The exposed leadTicks is the
   *  rounded integer of `state.x`. */
  state: SpringState;
}

export function createLookaheadController(initialLeadTicks: number): LookaheadController {
  return {
    state: { x: initialLeadTicks, v: 0 },
  };
}

/**
 * Compute the desired lookahead for a given RTT mean + std-dev (both in
 * milliseconds). `mean + 2σ` covers the upper-jitter tail; the result is
 * clamped to `[FLOOR_TICKS, CEILING_TICKS]` so a zero-RTT client still
 * has a 3-tick prediction window and a catastrophic RTT doesn't speculate
 * past 30 ticks.
 */
export function computeDesiredLead(rttMeanMs: number, rttStdDevMs: number): number {
  const bufferMs = rttMeanMs + 2 * rttStdDevMs;
  const ticks = Math.ceil(bufferMs / FIXED_MS);
  if (ticks < FLOOR_TICKS) return FLOOR_TICKS;
  if (ticks > CEILING_TICKS) return CEILING_TICKS;
  return ticks;
}

/**
 * Step the controller toward `targetLeadTicks` by `dtMs` of wall-clock.
 * Returns the integer leadTicks the input loop should use this frame.
 *
 * For small (≤ 1-tick) changes, snaps the internal state to the target
 * so per-snapshot integer rounding doesn't create a perpetual half-tick
 * spring oscillation. For larger jumps, applies the critically-damped
 * spring step from Stage 1 — frame-rate independent, monotonic approach.
 */
export function updateLookahead(
  ctrl: LookaheadController,
  targetLeadTicks: number,
  dtMs: number,
): number {
  const diff = Math.abs(targetLeadTicks - ctrl.state.x);
  if (diff <= SNAP_THRESHOLD_TICKS) {
    // Snap. Zero velocity so a future ramp starts from rest.
    ctrl.state.x = targetLeadTicks;
    ctrl.state.v = 0;
  } else {
    springStep(ctrl.state, targetLeadTicks, LOOKAHEAD_HALF_LIFE_MS, dtMs);
  }
  return Math.round(ctrl.state.x);
}
