/**
 * Per-snapshot RTT Welford + lookahead update.
 *
 * Stage 4 jitter-aware lookahead: Welford-track per-snapshot RTT
 * (mean + σ) and size the prediction window to `mean + 2σ`. Multi-
 * tick target jumps ramp via the spring controller; small changes
 * snap directly.
 *
 * Three hotfixes layered on top — read the comments inside the
 * function before changing thresholds:
 *
 *   #1 (2026-05-08) — clamp single samples at `RTT_SAMPLE_CLAMP_MS`
 *     so a Pattern A 572 ms inbound gap can't blow up σ.
 *
 *   #3 (2026-05-08) — skip the Welford push entirely when the
 *     snapshot interval is outside the steady-state cadence band
 *     [35, 75] ms — those samples are part of a burst-recovery
 *     cluster or a gap and their lastRtt is contaminated.
 *
 *   #5 (2026-05-09) — strip the gate-induced server-side hold time
 *     (`leadTicks × FIXED_MS`) from the RTT sample before pushing
 *     into Welford. Without this the gate's "hold input X until sim
 *     tick reaches X" delay folds into the RTT estimate and
 *     creates a positive feedback loop: bigger leadTicks → longer
 *     hold → bigger Welford mean → bigger leadTicks → saturation.
 *     Mobile cap 2026-05-09T09-31-30-823Z-n3n9jx caught `rttMs`
 *     saturating at 200-870 ms with actual Wi-Fi RTT ~30 ms.
 */

import { welfordPush, welfordMean, welfordStdDev, type WelfordState } from '@core/math/Welford';
import {
  computeDesiredLead,
  updateLookahead,
  type LookaheadController,
} from './lookaheadController';
import {
  RTT_SAMPLE_CLAMP_MS,
  STEADY_STATE_INTERVAL_MIN_MS,
  STEADY_STATE_INTERVAL_MAX_MS,
} from './predictionTuning';
import type { Reconciler } from '@core/prediction/Reconciler';
import type { PredictionStats } from './predictionStats';

const FIXED_MS = 1000 / 60;

export interface RttLookaheadCtx {
  reconciler: Reconciler | null;
  stats: PredictionStats;
  rttWelford: WelfordState;
  lookaheadCtrl: LookaheadController;
  leadTicks: number;
  lastFrameMs: number;
}

/**
 * Returns the new leadTicks value (caller assigns to this.leadTicks
 * since the field lives on ColyseusClient).
 */
export function updateRttAndLookahead(
  intervalMs: number,
  ctx: RttLookaheadCtx,
): number {
  const isGapRelatedRtt =
    intervalMs > 0 &&
    (intervalMs < STEADY_STATE_INTERVAL_MIN_MS || intervalMs > STEADY_STATE_INTERVAL_MAX_MS);
  if (!ctx.reconciler || ctx.reconciler.lastRtt <= 0 || isGapRelatedRtt) {
    return ctx.leadTicks;
  }
  const networkRtt = Math.max(0, ctx.reconciler.lastRtt - ctx.leadTicks * FIXED_MS);
  const rttSample = Math.min(networkRtt, RTT_SAMPLE_CLAMP_MS);
  welfordPush(ctx.rttWelford, rttSample);
  const mean = welfordMean(ctx.rttWelford);
  const stdDev = welfordStdDev(ctx.rttWelford);
  const desiredLead = computeDesiredLead(mean, stdDev);
  const newLeadTicks = updateLookahead(ctx.lookaheadCtrl, desiredLead, ctx.lastFrameMs);
  ctx.stats.rttMeanMs = mean;
  ctx.stats.rttStdDevMs = stdDev;
  return newLeadTicks;
}
