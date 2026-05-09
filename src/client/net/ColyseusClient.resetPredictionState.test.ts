/**
 * Regression test for the 2026-05-09 sector-handoff prediction-pollution bug.
 *
 * Symptom captured in `diag/captures/2026-05-09T07-49-57-470Z-81numi/`:
 * after warping between sectors, every snapshot reports
 * `srvTick − ackedTick = −37` (steady, for the entire 5.2 s capture
 * window), 67 % of snapshots produce a significant correction, and the
 * local ship visibly renders ~600 ms ahead of authoritative server state.
 * The clean-baseline capture from later in the same session
 * (`2026-05-09T07-51-26-622Z-wc5fm0`) stabilises at offset −15.
 *
 * Root cause: `_rttWelford`, `_lookaheadCtrl`, `_dropDetector`,
 * `_anchorInitialised`, `lastSnapshotAt`, and the rolling EWMA buffers
 * were declared `readonly` and survived the `consumeSeatReservation`
 * room hot-swap unchanged. The 5+ s transit gap polluted the welford
 * RTT stream (some samples filtered by Stage 4 hotfix #3, others
 * clamped to 250 ms by hotfix #1 and pushed anyway), the running mean
 * drifted up, `mean + 2σ` saturated the 30-tick `CEILING_TICKS` cap in
 * `lookaheadController`, and `leadTicks` stayed pinned at the cap for
 * tens of seconds post-arrival.
 *
 * Fix: `resetPredictionState()` is invoked from the `transit_ready`
 * handler after `room.leave(true)` and before `consumeSeatReservation`.
 * It re-creates the welford / lookahead / drop-detector state, clears
 * the rolling buffers, lowers `_anchorInitialised` so the next
 * snapshot seeds the clock anchor instead of EWMA-smoothing it, and
 * zeroes `reconciler.lastRtt` so the first post-transit welford push
 * doesn't seed off the pre-transit value.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { welfordPush, welfordMean } from '../../core/math/Welford.js';

// The reset method is private. Rather than weakening the public API,
// we reach in via a narrow structural cast so the test exercises the
// production code path verbatim. If a future refactor renames the
// fields, this test should fail to compile — that's the point.
type Internals = {
  _rttWelford: { n: number; mean: number; M2: number; resetEvery: number };
  _lookaheadCtrl: { state: { x: number; v: number } };
  _dropDetector: { lastTick: number; recent: number[]; dropCount: number; windowSize: number };
  leadTicks: number;
  _anchorInitialised: boolean;
  lastSnapshotAt: number;
  _recentIntervals: number[];
  _recentCorrFlags: number[];
  _intervalEwma: number;
  reconciler: { lastRtt: number } | null;
  resetPredictionState: () => void;
};

function asInternals(c: ColyseusGameClient): Internals {
  return c as unknown as Internals;
}

describe('ColyseusGameClient.resetPredictionState', () => {
  it('zeroes welford state polluted by pre-transit gap samples', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);

    // Simulate the post-transit-gap pollution: seven 250 ms samples (the
    // RTT_SAMPLE_CLAMP_MS value from the Stage 4 hotfix #1 path) push the
    // welford mean up to 250 ms exactly. With the bug present, this
    // mean would survive the next sector handoff and drive `leadTicks`
    // into saturation on every fresh room.
    for (let i = 0; i < 7; i++) welfordPush(internals._rttWelford, 250);
    expect(welfordMean(internals._rttWelford)).toBeCloseTo(250, 5);
    expect(internals._rttWelford.n).toBe(7);

    internals.resetPredictionState();

    expect(internals._rttWelford.n).toBe(0);
    expect(internals._rttWelford.mean).toBe(0);
    expect(internals._rttWelford.M2).toBe(0);
  });

  it('rewinds lookahead, drop detector, anchor flags, and rolling buffers', () => {
    const client = new ColyseusGameClient();
    const internals = asInternals(client);

    // Seed the polluted state we'd expect to see at the moment of transit.
    internals._lookaheadCtrl.state.x = 30; // saturated at CEILING_TICKS
    internals._lookaheadCtrl.state.v = 5;
    internals._dropDetector.lastTick = 12345;
    internals._dropDetector.recent.push(2, 1, 0);
    internals._dropDetector.dropCount = 3;
    internals.leadTicks = 30;
    internals._anchorInitialised = true;
    internals.lastSnapshotAt = 9999;
    internals._recentIntervals.push(50, 60, 70);
    internals._recentCorrFlags.push(1, 0, 1);
    internals._intervalEwma = 175;

    internals.resetPredictionState();

    expect(internals._lookaheadCtrl.state.x).toBe(6);
    expect(internals._lookaheadCtrl.state.v).toBe(0);
    expect(internals._dropDetector.lastTick).toBe(-1);
    expect(internals._dropDetector.recent).toEqual([]);
    expect(internals._dropDetector.dropCount).toBe(0);
    expect(internals.leadTicks).toBe(6);
    expect(internals._anchorInitialised).toBe(false);
    expect(internals.lastSnapshotAt).toBe(0);
    expect(internals._recentIntervals).toEqual([]);
    expect(internals._recentCorrFlags).toEqual([]);
    expect(internals._intervalEwma).toBe(0);
  });

  it('zeroes reconciler.lastRtt when the reconciler is bound', () => {
    // The first post-transit welford push (line 1082 of ColyseusGameClient)
    // reads `this.reconciler.lastRtt` from the *previous* reconcile call.
    // Without resetting it, the very first push after the room handoff
    // re-injects the pre-transit RTT — re-poisoning the welford we just
    // re-created. Lock that down.
    const client = new ColyseusGameClient();
    const internals = asInternals(client);

    internals.reconciler = { lastRtt: 5000 };
    internals.resetPredictionState();
    expect(internals.reconciler.lastRtt).toBe(0);
  });

  it('is a no-op on the reconciler field when no reconciler is bound', () => {
    // Pre-welcome (before the first snapshot binds the reconciler) the
    // field is null. The reset must not throw.
    const client = new ColyseusGameClient();
    const internals = asInternals(client);

    expect(internals.reconciler).toBeNull();
    expect(() => internals.resetPredictionState()).not.toThrow();
    expect(internals.reconciler).toBeNull();
  });
});
