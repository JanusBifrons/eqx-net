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
 * Faithfulness: the on-device lead (24) cannot be replayed since the lead is
 * sized from the server's `inputMargin`, which this capture predates (see
 * the PRE-MARGIN check below).
 */
import { describe, it, expect } from 'vitest';
import { replayCapture, HARNESS_START_LEAD_TICKS, leadHeldWithoutMargin } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
  assertFramePacingSmooth,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-21T16-04-16Z-2q0jxw';

describe('replay lock — 2q0jxw mobile RAF jitter', () => {
  // The on-device ticksAhead (24) was sized by the lastRtt sample, which is
  // blind under the held-input ack. The lead is now sized from the server's
  // snapshot `inputMargin`, which this capture predates and which can't be
  // rebuilt from it: its rttMs is that same blind lastRtt, and its server tick
  // rate drifts 27 ms per snapshot against the phone clock. The old ±5 check
  // against 24 needs a capture recorded with `inputMargin`.
  it.todo('FAITHFULNESS: replay reproduces on-device ticksAhead (needs a post-inputMargin capture)');

  it('PRE-MARGIN CAPTURE: nothing but the server margin moves the lead', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      leadHeldWithoutMargin(trace.finalStats.ticksAhead),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, start lead ${HARNESS_START_LEAD_TICKS}: ` +
        `the lead moved with no inputMargin in the capture.`,
    ).toBe(true);
  });

  it('USER CONTRACT — ticksAhead stays bounded (spiral fix still works)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertTicksAheadBounded(trace, { maxFinalTicks: 60 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  // FIXED by S2b-1 (#1138, carried correction offset continuity). This was
  // an `it.fails` marker: on the `2790b0d` baseline assertNoTeleport fired
  // 54x (worst 137 u over 8.9 ms, near inputTick=5673). Each new correction
  // reset the render offset to the raw drift and dropped the offset still
  // easing from the previous correction, so the drawn pose (physics +
  // offset) stepped whenever corrections landed close together. The
  // Reconciler now carries the remaining offset into the new one and takes
  // the half-life from max(|carried offset|, raw drift), and the replayed
  // rendered pose stays under the 30 u per-RAF ceiling. Reverting that
  // Reconciler change makes this test fail again.
  //
  // This contract does not cover the user's "stop-start" perception: ~58 %
  // of mobile RAFs fire without advancing physics, so 3-5 consecutive RAFs
  // render the same pose, then 1 RAF jumps forward. Per-RAF deltas during
  // those holds are zero, so a 30 u threshold does not see them. The
  // frame-pacing contract below locks that separately.
  it('USER CONTRACT — no teleport (fixed by S2b-1 offset continuity, #1138)', async () => {
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

  // Documents the user-perceived "stop-start" pattern from the
  // ON-DEVICE capture. The on-device `local_pose_rendered` stream
  // shows 81 runs > 3 frames of identical pose (clustered in 4-10
  // frame holds = the rapid alternation the user perceives as
  // jitter). This is HISTORICAL data, frozen at capture time. A
  // future capture taken AFTER the fix would have fewer holds, and
  // that future capture's lock would flip this to GREEN.
  //
  // The harness's re-rendering CAN'T validate the fix here: the
  // harness's predWorld drifts in velocity over 60 s of combat
  // play (no drone/projectile state to drive collisions), so its
  // dead-reckon term is 0 even when on-device velocity was non-zero.
  // Direct validation of the dead-reckon logic lives in
  // `src/client/net/ColyseusClient.deadReckon.test.ts`.
  it.fails('USER CONTRACT — frame pacing smooth (ON-DEVICE — documents user complaint; can\'t change without new capture)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertFramePacingSmooth(trace, { maxConsecutiveSameRender: 3 });
    expect(r.pass, r.violations.slice(0, 5).map((v) => v.detail).join('\n')).toBe(true);
  });
});
