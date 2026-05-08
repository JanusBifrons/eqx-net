/**
 * Assertion helpers for the scenario harness — Stage 4.5.
 *
 * Each helper returns a `{ passed, violation? }` object so failures can
 * report the *first* observation that broke the property — much more
 * useful than a generic "expected X" assertion message.
 */
import type { Observation } from './types';

export interface AssertionResult {
  passed: boolean;
  violation?: Observation;
  message?: string;
}

/**
 * Assert `ticksAhead >= min` for every observation, ignoring the warmup
 * period. The classic Stage 4 hotfix #2 property: prediction window
 * should never collapse to zero or negative.
 */
export function ticksAheadNeverBelow(
  observations: ReadonlyArray<Observation>,
  min: number,
  ignoreFirstMs = 1000,
): AssertionResult {
  for (const o of observations) {
    if (o.atMs < ignoreFirstMs) continue;
    if (o.event !== 'snapshot') continue;
    if (o.ticksAhead < min) {
      return {
        passed: false,
        violation: o,
        message: `ticksAhead = ${o.ticksAhead} at t=${o.atMs}ms (min=${min})`,
      };
    }
  }
  return { passed: true };
}

/**
 * Assert Welford σ stays bounded. The Stage 4 hotfix #1 property: RTT
 * sample clamping should keep σ from exploding under outliers.
 */
export function welfordStdDevBoundedBy(
  observations: ReadonlyArray<Observation>,
  maxMs: number,
  ignoreFirstMs = 500,
): AssertionResult {
  for (const o of observations) {
    if (o.atMs < ignoreFirstMs) continue;
    if (o.rttStdDev > maxMs) {
      return {
        passed: false,
        violation: o,
        message: `welford σ = ${o.rttStdDev.toFixed(1)}ms at t=${o.atMs}ms (max=${maxMs}ms)`,
      };
    }
  }
  return { passed: true };
}

/**
 * Assert Welford running mean never drifts above `maxMs`. Catches the
 * post-2026-05-08-second-diagnostic case where Pattern A spikes inflate
 * the mean (even with the σ-clamp in place) because clamped samples are
 * still added to the mean. The fix — gating the Welford push on
 * `dropDetector.dropCount === 0` — is verified by this assertion.
 */
export function rttMeanAlwaysBelow(
  observations: ReadonlyArray<Observation>,
  maxMs: number,
  ignoreFirstMs = 500,
): AssertionResult {
  for (const o of observations) {
    if (o.atMs < ignoreFirstMs) continue;
    if (o.rttMean > maxMs) {
      return {
        passed: false,
        violation: o,
        message: `rttMean = ${o.rttMean.toFixed(1)}ms at t=${o.atMs}ms (max=${maxMs}ms)`,
      };
    }
  }
  return { passed: true };
}

/**
 * Assert leadTicks stays within bounds. Useful for catching saturation at
 * the cap (= broken feel) or runaway-high values.
 */
export function leadTicksWithinRange(
  observations: ReadonlyArray<Observation>,
  minTicks: number,
  maxTicks: number,
  ignoreFirstMs = 500,
): AssertionResult {
  for (const o of observations) {
    if (o.atMs < ignoreFirstMs) continue;
    if (o.leadTicks < minTicks || o.leadTicks > maxTicks) {
      return {
        passed: false,
        violation: o,
        message: `leadTicks = ${o.leadTicks} at t=${o.atMs}ms (range [${minTicks}, ${maxTicks}])`,
      };
    }
  }
  return { passed: true };
}

/** Count the number of starvation-recovery snaps that fired during the run. */
export function starvationSnapCount(observations: ReadonlyArray<Observation>): number {
  return observations.filter((o) => o.starvationSnapTriggered).length;
}

/** Pretty-print the last few observations around an `atMs` for diagnostics. */
export function describeWindow(
  observations: ReadonlyArray<Observation>,
  centerAtMs: number,
  windowMs = 500,
): string {
  const lo = centerAtMs - windowMs / 2;
  const hi = centerAtMs + windowMs / 2;
  const lines = ['atMs    | event    | inTick | ackTick | ahead | leadT | rttMean | rttStd  | starv'];
  for (const o of observations) {
    if (o.atMs < lo || o.atMs > hi) continue;
    lines.push(
      [
        o.atMs.toFixed(0).padStart(7),
        o.event.padEnd(8),
        String(o.inputTick).padStart(6),
        String(o.ackedTick).padStart(7),
        String(o.ticksAhead).padStart(5),
        String(o.leadTicks).padStart(5),
        o.rttMean.toFixed(1).padStart(7),
        o.rttStdDev.toFixed(1).padStart(7),
        o.starvationSnapTriggered ? '✓' : ' ',
      ].join(' | '),
    );
  }
  return lines.join('\n');
}
