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
 *
 *   #6 (2026-11-21) — the sample is the server-measured input path, not
 *     `lastRtt`. With the held-ack rule the ack for tick X arrives `lead`
 *     ticks after X was sent whether X reached the server in time or not,
 *     so `lastRtt − lead` was ~0 on every link and the lead sat on its
 *     3-tick floor (phone over a tunnel, capture fxc3y2: ticksAhead p50 3
 *     on a ~100 ms link; late inputs → heading corrections of exactly
 *     N × turn-per-tick, the "jitters left to right" report). The server
 *     reports each pilot's input margin (`inputLeadMargin`) and the sample
 *     is `inputPathTicks(lead, margin)`: independent of the lead, so no
 *     feedback loop (#5's concern), and it sees real lateness. `lastRtt`
 *     stays as telemetry only. Lock: `lateInputLead.test.ts`.
 */

import { inputPathTicks } from '@core/physics/inputQueue';
import { welfordPush, welfordMean, welfordStdDev, type WelfordState } from '@core/math/Welford';
import {
  CEILING_TICKS,
  computeDesiredLead,
  updateLookahead,
  type LookaheadController,
} from './lookaheadController';
import {
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
  /** The snapshot's `inputMargin` (game ticks): claimed tick minus server
   *  tick when the server got this pilot's latest input. Absent = no input
   *  since the last snapshot; the lead keeps its value. */
  inputMargin: number | undefined;
  /** Sector game speed: the margin is game ticks, `leadTicks` wall ticks. */
  timeScale: number;
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
  if (!ctx.reconciler || ctx.inputMargin === undefined || isGapRelatedRtt) {
    return ctx.leadTicks;
  }
  // The input path in wall ms: how far ahead an input must be sent to reach
  // the server before its tick, from the server-measured margin (#6 above).
  const scale = ctx.timeScale > 0 ? ctx.timeScale : 1;
  const pathTicks = inputPathTicks(ctx.leadTicks * scale, ctx.inputMargin) / scale;
  // Clamp at the controller ceiling, not RTT_SAMPLE_CLAMP_MS: that 250 ms clamp
  // bounded the contaminated lastRtt and would cap the lead at 15 ticks here.
  const rttSample = Math.min(Math.max(0, pathTicks), CEILING_TICKS) * FIXED_MS;
  welfordPush(ctx.rttWelford, rttSample);
  const mean = welfordMean(ctx.rttWelford);
  const stdDev = welfordStdDev(ctx.rttWelford);
  const desiredLead = computeDesiredLead(mean, stdDev);
  const newLeadTicks = updateLookahead(ctx.lookaheadCtrl, desiredLead, ctx.lastFrameMs);
  ctx.stats.rttMeanMs = mean;
  ctx.stats.rttStdDevMs = stdDev;
  return newLeadTicks;
}
