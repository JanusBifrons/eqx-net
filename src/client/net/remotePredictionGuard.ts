/**
 * Hysteresis + lookahead cap for remote-entity forward-prediction —
 * Stage 3 of the network-feel roadmap.
 *
 * Forward-prediction works well when a remote ship's input is stable
 * across the prediction window: hold-thrust, hold-turn dogfight runs
 * are exactly what `lastInput` was designed for. It works *poorly*
 * when the remote pilot is jinking — input vector changes faster than
 * snapshots arrive, so the prediction extrapolates the wrong intent
 * for half a snapshot interval, and reconciliation produces large
 * corrections.
 *
 * The guard tracks each remote's recent correction magnitudes:
 *
 *   - **Disable** forward-prediction when N consecutive corrections
 *     exceed the drift threshold (default: 3 corrections > 5 u).
 *   - **Re-enable** when N consecutive fresh corrections fall below
 *     the threshold (default: 3 corrections < 5 u).
 *
 * Both directions use a *fresh* streak — a single boundary-crossing
 * correction resets the streak counter. This produces sticky
 * hysteresis: the guard doesn't oscillate at the boundary even when
 * the underlying drift signal is noisy near 5 u.
 *
 * The lookahead cap is independent: even when forward-prediction is
 * enabled, never extrapolate more than `maxLookaheadTicks` ticks
 * beyond the snapshot. A long network stall (≥ 8 ticks behind)
 * otherwise produces visible runaway speculation.
 *
 * Pure module — no Rapier, no Colyseus, no I/O. Tested against
 * synthetic correction sequences in remotePredictionGuard.test.ts.
 */

export interface RemotePredictionGuard {
  driftThresholdU: number;
  windowSize: number;
  /** Per-remote streak of consecutive corrections currently *over* the
   *  threshold. Resets to 0 on any below-threshold correction. */
  overStreak: Map<string, number>;
  /** Per-remote streak of consecutive corrections currently *under* the
   *  threshold. Resets to 0 on any above-threshold correction. */
  underStreak: Map<string, number>;
  /** Per-remote forward-prediction state. Default true (enabled);
   *  flipped to false on overStreak >= windowSize, back to true on
   *  underStreak >= windowSize while disabled. */
  enabled: Map<string, boolean>;
}

export function createRemotePredictionGuard(opts?: {
  driftThresholdU?: number;
  windowSize?: number;
  maxLookaheadTicks?: number;
}): RemotePredictionGuard {
  return {
    driftThresholdU: opts?.driftThresholdU ?? 5,
    windowSize: opts?.windowSize ?? 3,
    overStreak: new Map(),
    underStreak: new Map(),
    enabled: new Map(),
  };
}

/** Record the latest reconcile-correction magnitude for a remote. Updates
 *  the over/under streaks and may flip the enabled state. */
export function recordRemoteCorrection(
  guard: RemotePredictionGuard,
  remoteId: string,
  driftU: number,
): void {
  if (driftU > guard.driftThresholdU) {
    const next = (guard.overStreak.get(remoteId) ?? 0) + 1;
    guard.overStreak.set(remoteId, next);
    guard.underStreak.set(remoteId, 0);
    if (next >= guard.windowSize) {
      guard.enabled.set(remoteId, false);
    }
  } else {
    const next = (guard.underStreak.get(remoteId) ?? 0) + 1;
    guard.underStreak.set(remoteId, next);
    guard.overStreak.set(remoteId, 0);
    // Re-enable only if previously disabled — sticky default-enabled
    // state means we don't write to the map for new remotes.
    if (next >= guard.windowSize && guard.enabled.get(remoteId) === false) {
      guard.enabled.set(remoteId, true);
    }
  }
}

/** Should the caller forward-predict this remote? Default true (new
 *  remotes are predicted optimistically). */
export function shouldForwardPredict(
  guard: RemotePredictionGuard,
  remoteId: string,
): boolean {
  return guard.enabled.get(remoteId) ?? true;
}

/** Clamp a desired lookahead-tick count to `[0, maxTicks]`. Negative
 *  inputs (snapshot ahead of inputTick — degenerate but possible
 *  during clock-anchor drift) collapse to zero. */
export function capLookahead(desired: number, maxTicks: number): number {
  if (desired <= 0) return 0;
  if (desired >= maxTicks) return maxTicks;
  return desired;
}
