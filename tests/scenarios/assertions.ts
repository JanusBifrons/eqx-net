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

// ---------------------------------------------------------------------------
// Drawn-motion counters (netcode gap smoothing plan, section 9.1).
//
// Input is one object's drawn pose and true pose, one entry per rendered
// frame, stamped with SIMULATED time (never wall-clock). The counters judge
// how the drawn track deviates from the truth: snaps, freezes, backward steps
// and lateness.
// ---------------------------------------------------------------------------

/** One rendered frame: simulated time plus the drawn and the true position. */
export interface MotionFrame {
  /** Simulated (game) time of the frame, in ms. */
  atMs: number;
  drawnX: number;
  drawnY: number;
  trueX: number;
  trueY: number;
}

export interface MotionCounterOptions {
  /** A frame is a snap when the drawn step exceeds the true step by more than this (world units). */
  snapToleranceU?: number;
  /** True speed (u/s) above which a still drawn pose counts as frozen and a reversed one as backward. */
  movingSpeedUPerS?: number;
  /** Drawn steps at or below this length (world units) count as "did not move". */
  stillEpsilonU?: number;
  /** How far (ms of simulated time) lateness search looks back and forward along the true track. */
  latenessWindowMs?: number;
  /** Frames before this simulated time are not counted (they still serve as true-track history). */
  ignoreFirstMs?: number;
}

export interface MotionCounters {
  snaps: number;
  /** Largest snap: drawn step minus true step, world units. */
  largestSnapU: number;
  /** Sum of all snap sizes, world units. */
  totalSnapU: number;
  freezeFrames: number;
  backwardSteps: number;
  /** Mean lateness over all frames, ms of simulated time (negative = ahead of truth). */
  meanLatenessMs: number;
  /** Largest lateness over all frames, ms of simulated time. */
  maxLatenessMs: number;
}

export const MOTION_SNAP_TOLERANCE_U = 2;
export const MOTION_MOVING_SPEED_U_PER_S = 30;
export const MOTION_STILL_EPSILON_U = 1e-3;
export const MOTION_LATENESS_WINDOW_MS = 2000;

/** Distance-squared tie margin when picking the true-track point closest to the drawn pose. */
const LATENESS_TIE_EPSILON_SQ = 1e-9;

/**
 * Simulated time at which the true track passes closest to the drawn pose of
 * frame `i`, searching segments within `windowMs` either side. Nearer-in-time
 * segments win ties, so a drawn pose on a stationary truth reads as on time.
 */
function closestTrueTimeMs(frames: ReadonlyArray<MotionFrame>, i: number, windowMs: number): number {
  const f = frames[i]!;
  let bestDistSq = Infinity;
  let bestT = f.atMs;
  let bestAbsLate = Infinity;
  for (let s = 0; s + 1 < frames.length; s++) {
    const a = frames[s]!;
    const b = frames[s + 1]!;
    if (b.atMs < f.atMs - windowMs || a.atMs > f.atMs + windowMs) continue;
    const sx = b.trueX - a.trueX;
    const sy = b.trueY - a.trueY;
    const lenSq = sx * sx + sy * sy;
    let u = 0;
    if (lenSq > 0) {
      u = ((f.drawnX - a.trueX) * sx + (f.drawnY - a.trueY) * sy) / lenSq;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;
    }
    const px = a.trueX + sx * u - f.drawnX;
    const py = a.trueY + sy * u - f.drawnY;
    const distSq = px * px + py * py;
    // On a stationary segment any point is equally close; take the end nearest the frame time.
    const t = lenSq > 0 ? a.atMs + (b.atMs - a.atMs) * u : Math.min(Math.max(f.atMs, a.atMs), b.atMs);
    const absLate = Math.abs(f.atMs - t);
    if (
      distSq < bestDistSq - LATENESS_TIE_EPSILON_SQ ||
      (distSq <= bestDistSq + LATENESS_TIE_EPSILON_SQ && absLate < bestAbsLate)
    ) {
      bestDistSq = distSq;
      bestT = t;
      bestAbsLate = absLate;
    }
  }
  return bestT;
}

/**
 * Count how a drawn track deviates from the true track, frame by frame
 * (plan section 9.1):
 * - snap: the drawn step is longer than the true step plus `snapToleranceU`;
 *   its size is the excess (drawn step minus true step).
 * - freeze frame: the drawn pose does not move while true speed exceeds
 *   `movingSpeedUPerS`.
 * - backward step: while the truth moves, the drawn step points against the
 *   true direction.
 * - lateness: simulated ms between the frame and the time the truth was
 *   closest to the drawn pose.
 */
export function countMotionArtefacts(
  frames: ReadonlyArray<MotionFrame>,
  options: MotionCounterOptions = {},
): MotionCounters {
  const snapTol = options.snapToleranceU ?? MOTION_SNAP_TOLERANCE_U;
  const movingSpeed = options.movingSpeedUPerS ?? MOTION_MOVING_SPEED_U_PER_S;
  const stillEps = options.stillEpsilonU ?? MOTION_STILL_EPSILON_U;
  const windowMs = options.latenessWindowMs ?? MOTION_LATENESS_WINDOW_MS;
  const ignoreFirstMs = options.ignoreFirstMs ?? 0;

  const out: MotionCounters = {
    snaps: 0,
    largestSnapU: 0,
    totalSnapU: 0,
    freezeFrames: 0,
    backwardSteps: 0,
    meanLatenessMs: 0,
    maxLatenessMs: 0,
  };
  let latenessSum = 0;
  let counted = 0;
  let maxLate = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.atMs < ignoreFirstMs) continue;
    counted++;
    const late = frames[i]!.atMs - closestTrueTimeMs(frames, i, windowMs);
    latenessSum += late;
    if (late > maxLate) maxLate = late;
    if (i === 0 || frames[i - 1]!.atMs < ignoreFirstMs) continue;

    const prev = frames[i - 1]!;
    const cur = frames[i]!;
    const dtMs = cur.atMs - prev.atMs;
    const dx = cur.drawnX - prev.drawnX;
    const dy = cur.drawnY - prev.drawnY;
    const tx = cur.trueX - prev.trueX;
    const ty = cur.trueY - prev.trueY;
    const drawnStep = Math.hypot(dx, dy);
    const trueStep = Math.hypot(tx, ty);
    const trueSpeed = dtMs > 0 ? (trueStep * 1000) / dtMs : 0;

    const excess = drawnStep - trueStep;
    if (excess > snapTol) {
      out.snaps++;
      out.totalSnapU += excess;
      if (excess > out.largestSnapU) out.largestSnapU = excess;
    }
    if (trueSpeed > movingSpeed) {
      if (drawnStep <= stillEps) out.freezeFrames++;
      else if ((dx * tx + dy * ty) / trueStep < -stillEps) out.backwardSteps++;
    }
  }
  if (counted === 0) return out;
  out.meanLatenessMs = latenessSum / counted;
  out.maxLatenessMs = maxLate;
  return out;
}
