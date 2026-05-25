/**
 * Pure tuning constants + the remote-offset spring half-life helper for
 * the client prediction path. Extracted from the monolithic
 * `ColyseusClient.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 17 prep).
 *
 * All values here are READ-ONLY tuning numbers (or a pure decision over
 * them). Anything that participates in the `IPredictionState.reset()`
 * cluster (predWorld, reconciler, RTT sampler, correctionSmoothing,
 * inputTickRecovery) stays in `ColyseusClient.ts` until the full
 * commit-17 extraction lands.
 */

/** Position drift below this is float32-serialisation noise. */
export const NOISE_THRESHOLD = 0.05;
/** Angle drift below this is float32-serialisation noise (~0.057°). */
export const ANGLE_NOISE_THRESHOLD = 0.001;

/** Termination thresholds for remote-ship offset springs. Match the
 *  Reconciler's SPRING_POS_END / SPRING_VEL_END_MS so visual recovery
 *  ends consistently across local- and remote-ship offsets. */
export const REMOTE_SPRING_POS_END = 0.05; // matches LERP_THRESHOLD
export const REMOTE_SPRING_VEL_END_MS = 0.05; // 50 u/s

/** Stage 3 — maximum forward-prediction ticks per remote, per snapshot.
 *  At 60 Hz that's ~133 ms of speculative integration. A long network
 *  stall can leave `inputTick - serverTick` arbitrarily large, but we
 *  only speculate the remote's input for this many ticks beyond
 *  serverTick — additional ticks integrate the remote with damping
 *  only (pre-Stage-3 behaviour) so visible runaway speculation is
 *  bounded. Reset on every snapshot. */
export const STAGE_3_MAX_LOOKAHEAD_TICKS = 8;

/** Stage 4 hotfix — clamp on RTT samples fed into the Welford state
 *  driving leadTicks. `Reconciler.lastRtt` is contaminated by snapshot-
 *  delay (it's `now - ackedRec.sentAt`, not the true TCP RTT), so a
 *  500 ms inbound network gap can push σ past 200 ms and saturate the
 *  prediction window at the 30-tick cap. Clamping samples at 250 ms
 *  bounds σ even under Pattern A spikes; real-world high-RTT clients
 *  (international, cellular) routinely measure 100–250 ms, so the
 *  clamp doesn't penalise them. See `docs/LESSONS.md` for the
 *  diagnostic. */
export const RTT_SAMPLE_CLAMP_MS = 250;

/** Stage 4 hotfix #3 (2026-05-08 third diagnostic) — gate the Welford
 *  RTT push on snapshot `intervalMs` being inside the steady-state
 *  cadence band. Server broadcasts every 3 server ticks (50 ms nominal
 *  at 60 Hz); real wall-clock jitter spreads this to roughly [35, 75] ms.
 *  Outside that range, the snapshot is part of a Pattern A gap (huge
 *  interval) or a burst-recovery cluster (tiny interval) — its
 *  `Reconciler.lastRtt` is contaminated by snapshot-delay even after
 *  the σ-clamp, so it inflates the running mean. Gating the push lets
 *  Welford track only clean samples; mean stays near live RTT and
 *  leadTicks stays sized for combat. See `docs/LESSONS.md`. */
export const STEADY_STATE_INTERVAL_MIN_MS = 35;
export const STEADY_STATE_INTERVAL_MAX_MS = 75;

/** Spring half-life for remote-ship offset decay (Stage 1).
 *  Aligned with `Reconciler.halfLifeForDrift` so remote-ship and local-ship
 *  visual recovery are in lockstep — sub-pixel drifts settle imperceptibly
 *  fast (~75 ms total wall-clock); everything above the noise floor settles
 *  in ~125 ms. Pre-Stage-1 used a frame counter; Stage 1 took dtMs and
 *  applies a critically-damped spring so the recovery is frame-rate
 *  independent and reads as "alive". */
export function remoteOffsetHalfLifeForDrift(drift: number): number {
  if (drift < 0.5) return 12;
  return 25;
}
