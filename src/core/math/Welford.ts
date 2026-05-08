/**
 * Welford's online mean + variance algorithm.
 *
 * Computes a stream's running mean and (Bessel-corrected sample) variance
 * with a single pass, O(1) memory, and substantially better numerical
 * stability than the naïve `Σx² - (Σx)²/n` formulation. The pairwise update
 *
 *     δ      = x − mean
 *     mean  += δ / n
 *     δ_post = x − mean
 *     M2    += δ × δ_post
 *
 * keeps M2 bounded regardless of stream magnitude, so a multi-hour RTT
 * stream doesn't slowly poison its own jitter estimate the way `Σx²` would.
 *
 * Stage 4 of the network-feel roadmap uses this to drive a `mean + 2σ`
 * lookahead estimate in the client's input clock — the EWMA-only formula
 * pre-Stage-4 didn't track jitter, so unstable links under-buffered by
 * design.
 *
 * Pure module — no I/O, no allocation per sample, fully unit-testable.
 */

/** Reset the Welford state every N samples. The pairwise update is stable
 *  in theory, but float drift over hundreds of thousands of samples can
 *  accumulate; periodic re-init bounds residual drift to a single window's
 *  worth. The current mean is preserved as the new seed (so callers see
 *  no discontinuity in the reported estimate); M2 starts fresh. */
const DEFAULT_RESET_EVERY = 600;

export interface WelfordState {
  n: number;
  mean: number;
  /** Sum of squared deviations from the current mean. variance = M2 / (n-1). */
  M2: number;
  /** Reset window — when n hits this value, re-initialise to the current
   *  mean as a single-sample seed and start over. */
  resetEvery: number;
}

export function createWelford(opts?: { resetEvery?: number }): WelfordState {
  return {
    n: 0,
    mean: 0,
    M2: 0,
    resetEvery: opts?.resetEvery ?? DEFAULT_RESET_EVERY,
  };
}

/** Push a sample into the stream. Mutates `state` in place — hot-path
 *  callers (60 Hz RTT updates) shouldn't allocate. */
export function welfordPush(state: WelfordState, x: number): void {
  // Periodic reset preserves the current mean (so the caller-visible
  // estimate doesn't jump) but starts variance accumulation fresh.
  if (state.n >= state.resetEvery) {
    state.n = 1;
    state.M2 = 0;
    // mean is preserved.
  }
  state.n += 1;
  const delta = x - state.mean;
  state.mean += delta / state.n;
  const delta2 = x - state.mean;
  state.M2 += delta * delta2;
}

export function welfordMean(state: WelfordState): number {
  return state.mean;
}

/** Bessel-corrected sample variance. Returns 0 for n ≤ 1 (insufficient data). */
export function welfordVariance(state: WelfordState): number {
  if (state.n < 2) return 0;
  return state.M2 / (state.n - 1);
}

export function welfordStdDev(state: WelfordState): number {
  return Math.sqrt(welfordVariance(state));
}
