/**
 * Regression lock — `2q0jxw` mobile RAF-jitter capture (2026-05-21T16-04-16Z).
 *
 * The first capture taken with the spiral fix (`2790b0d`) already shipped.
 * User played 62 s on phone, reported "jittery as hell, constant
 * stop-start-stop-start" — the spiral was masking a distinct render-pipeline
 * jitter. With the spiral cap holding inputTick close to ackedTick
 * (ticksAhead=24 stable), per-RAF rendered-pose deltas spike to 100+ u when
 * a slow RAF coincides with a catch-up burst.
 *
 * Session final state (from the tail of `snapshots.ndjson`,
 * `session.json` has `hasFinalized: true`):
 *   - ticksAhead = 24
 *   - rttMs ≈ 403
 *   - intervalMs ≈ 70.2
 *   - maxDriftUnits = 110
 *   - 30 corrections / 22 angle corrections / 742 snapshots
 *
 * Capture diagnostics:
 *   - 4948 rafTick events; 58% have stepsThisFrame=0; dominant non-zero
 *     pattern is stepsThisFrame=4 capped=true.
 *   - Mobile RAF fires 3-87 Hz erratically (elapsedMs samples: 199.9,
 *     288.9, 11.5, 110.9, 133.3).
 *   - Worst per-RAF rendered jerk on baseline: 137 u over 8.9 ms.
 *
 * What this lock is targeting: per-RAF rendered-pose deltas. The 30 u
 * threshold IS strict for mobile RAF jitter — a true 30 u/frame ceiling
 * may not be achievable without architectural changes (see
 * `memory/render-jitter-candidate-b-failed.md`). The render-jitter-fix
 * plan's current attempt (lerp-dt cap) targets the LERP-ABSORPTION
 * component of the per-RAF jerk; if that alone clears the lock, we ship;
 * if not, the measured improvement informs the next step.
 *
 * Faithfulness expectation: spiral fix is shipped on the capture's code
 * version, so harness ticksAhead closely matches the on-device 24.
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-21T16-04-16Z-2q0jxw';

const EXPECTED_REPLAY_TICKS_AHEAD = 24;

describe('replay lock — 2q0jxw mobile RAF jitter', () => {
  it('FAITHFULNESS: replay reproduces on-device ticksAhead within ±5', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      Math.abs(trace.finalStats.ticksAhead - EXPECTED_REPLAY_TICKS_AHEAD),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, expected ${EXPECTED_REPLAY_TICKS_AHEAD}.`,
    ).toBeLessThanOrEqual(5);
  });

  it('USER CONTRACT — ticksAhead stays bounded (spiral fix still works)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertTicksAheadBounded(trace, { maxFinalTicks: 60 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  // Target assertion for the render-jitter fix. RED on `2790b0d` baseline
  // (54 violations, worst 137 u over 8.9 ms). Should turn GREEN — or at
  // least drop dramatically in violation count + worst-case magnitude —
  // after the lerp-dt cap lands in the next commit.
  it('USER CONTRACT — no teleport in rendered pose stream', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertNoTeleport(trace, { maxDeltaUnits: 30 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  // Mobile-RAF-rate constraint: ~28 Hz tail < 30/s threshold. Same
  // pattern as 1kwv1z. Not what this fix targets.
  it.fails('USER CONTRACT — input flow maintained (mobile-RAF-rate constraint — expected-fail)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertInputFlowMaintained(trace);
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });
});
