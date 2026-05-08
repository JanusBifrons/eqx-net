/**
 * Stage 3 of the network-feel roadmap. Pure-function hysteresis +
 * lookahead-cap guard for remote-entity forward-prediction.
 *
 * The forward-prediction loop assumes the remote ship's `lastInput`
 * persists across the prediction window. That assumption fails when
 * the remote player is rapidly changing inputs (e.g. dogfight
 * jinking) — predictions diverge from reality, the reconciler shows
 * larger and larger corrections, and the perceived feel is *worse*
 * than no prediction at all. The guard detects this pattern via a
 * sliding window of recent correction magnitudes and falls back to
 * the pre-Stage-3 behaviour (no forward-prediction; remote sits at
 * server-tick pose) for the offending entity until inputs stabilise.
 *
 * The lookahead cap is a separate safety: even when forward-
 * prediction is enabled, never extrapolate more than N ticks beyond
 * the snapshot — a long network stall would otherwise produce
 * runaway speculative motion.
 */
import { describe, it, expect } from 'vitest';
import {
  createRemotePredictionGuard,
  recordRemoteCorrection,
  shouldForwardPredict,
  capLookahead,
  type RemotePredictionGuard,
} from './remotePredictionGuard.js';

function makeGuard(opts?: {
  driftThresholdU?: number;
  windowSize?: number;
  maxLookaheadTicks?: number;
}): RemotePredictionGuard {
  return createRemotePredictionGuard(opts);
}

describe('remotePredictionGuard', () => {
  it('Cycle 4: forward-prediction enabled by default for new remotes', () => {
    const g = makeGuard();
    expect(shouldForwardPredict(g, 'someone')).toBe(true);
  });

  it('Cycle 4: 3 consecutive corrections > threshold disables forward-prediction', () => {
    const g = makeGuard({ driftThresholdU: 5, windowSize: 3 });
    recordRemoteCorrection(g, 'p1', 6);
    expect(shouldForwardPredict(g, 'p1')).toBe(true); // 1 over
    recordRemoteCorrection(g, 'p1', 7);
    expect(shouldForwardPredict(g, 'p1')).toBe(true); // 2 over
    recordRemoteCorrection(g, 'p1', 8);
    expect(shouldForwardPredict(g, 'p1')).toBe(false); // 3 over → disabled
  });

  it('Cycle 4: a single below-threshold correction breaks the disable streak', () => {
    const g = makeGuard({ driftThresholdU: 5, windowSize: 3 });
    recordRemoteCorrection(g, 'p1', 6);
    recordRemoteCorrection(g, 'p1', 7);
    recordRemoteCorrection(g, 'p1', 2); // resets the over-streak
    expect(shouldForwardPredict(g, 'p1')).toBe(true);
  });

  it('Cycle 5: 3 consecutive below-threshold corrections re-enable forward-prediction', () => {
    const g = makeGuard({ driftThresholdU: 5, windowSize: 3 });
    // First disable.
    recordRemoteCorrection(g, 'p1', 6);
    recordRemoteCorrection(g, 'p1', 7);
    recordRemoteCorrection(g, 'p1', 8);
    expect(shouldForwardPredict(g, 'p1')).toBe(false);
    // Now stabilise: 3 consecutive small corrections.
    recordRemoteCorrection(g, 'p1', 1);
    expect(shouldForwardPredict(g, 'p1')).toBe(false); // 1 under
    recordRemoteCorrection(g, 'p1', 2);
    expect(shouldForwardPredict(g, 'p1')).toBe(false); // 2 under
    recordRemoteCorrection(g, 'p1', 0.5);
    expect(shouldForwardPredict(g, 'p1')).toBe(true); // 3 under → re-enabled
  });

  it('Cycle 5: an over-threshold correction during recovery resets the under-streak', () => {
    const g = makeGuard({ driftThresholdU: 5, windowSize: 3 });
    // Disable.
    for (let i = 0; i < 3; i++) recordRemoteCorrection(g, 'p1', 10);
    expect(shouldForwardPredict(g, 'p1')).toBe(false);
    // Two under, then one over.
    recordRemoteCorrection(g, 'p1', 1);
    recordRemoteCorrection(g, 'p1', 1);
    recordRemoteCorrection(g, 'p1', 8); // over → resets under-streak
    expect(shouldForwardPredict(g, 'p1')).toBe(false);
    // Need 3 fresh-under to recover.
    recordRemoteCorrection(g, 'p1', 1);
    recordRemoteCorrection(g, 'p1', 1);
    recordRemoteCorrection(g, 'p1', 1);
    expect(shouldForwardPredict(g, 'p1')).toBe(true);
  });

  it('Cycle 4-5: each remote tracks independently', () => {
    const g = makeGuard({ driftThresholdU: 5, windowSize: 3 });
    for (let i = 0; i < 3; i++) recordRemoteCorrection(g, 'p1', 10);
    expect(shouldForwardPredict(g, 'p1')).toBe(false);
    expect(shouldForwardPredict(g, 'p2')).toBe(true);
  });

  it('Cycle 6: lookahead cap clamps at maxLookaheadTicks', () => {
    expect(capLookahead(0, 8)).toBe(0);
    expect(capLookahead(5, 8)).toBe(5);
    expect(capLookahead(8, 8)).toBe(8);
    expect(capLookahead(20, 8)).toBe(8);
    expect(capLookahead(-3, 8)).toBe(0); // negative: no forward prediction
  });
});
