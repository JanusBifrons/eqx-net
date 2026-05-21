/**
 * Regression lock — `1kwv1z` phone streaming capture (2026-05-21T14-21-46Z).
 *
 * The first regression lock built on a `?autocapture=1` streaming
 * session. User opened the game on their phone with the streaming
 * flag, played for ~100 seconds on real mobile network, and the
 * client streamed ~22 k events to disk automatically. No manual
 * capture button press; if the tab had crashed, the data was
 * already on the server.
 *
 * Session final state (read from the tail of `snapshots.ndjson` —
 * the session is unfinalized so no `summary.json` exists; the
 * loader at `captureLoader.ts` doesn't need it):
 *   - ticksAhead = 155 (~2.6 s of prediction lead)
 *   - rttMs ≈ 3974 ms
 *   - intervalMs ≈ 340 ms
 *   - maxDriftUnits = 412
 *   - 344 corrections / 999 snapshots = 34 % correction rate
 *
 * On-device experience: "janky → unplayable".
 *
 * What makes this lock different from `vg9hon-idle` and `ers7xy-active`:
 *
 *  - **Phase-A-enriched capture.** Unlike the pre-Phase-A predecessors,
 *    this capture contains the new `input_intent` and
 *    `local_pose_rendered` tags emitted by `?autocapture=1`. That
 *    means `assertInputFlowMaintained` is NON-VACUOUS here — and it
 *    FAILS because the harness reproduces a real input-starvation
 *    window in the 79–80 s range (only 24 inputSent events during a
 *    held-input second). A future reader debugging this FAIL must
 *    NOT mistake it for a Phase-A schema gap — it is the genuine
 *    spiral symptom.
 *
 *  - **Unfinalized streaming capture.** `session.json` has
 *    `hasFinalized: false` and no `summary.json` was written
 *    (pagehide / beforeunload never fired before the session was
 *    inspected). The loader handles this fine (verified in
 *    `captureLoader.test.ts` mid-stream tolerance, commit `654009d`).
 *    The `ON_DEVICE_TICKS_AHEAD = 155` value is read from the LAST
 *    `snapshot` line in `snapshots.ndjson`, not from `summary.json`.
 *
 *  - **Worst RTT/jitter of the three locks.** rttMs ≈ 3974 at the
 *    tail vs ~177 (vg9hon) and ~similar for ers7xy. If faithfulness
 *    drifts on a CI/dev box to Δ > 5, the first debug step is
 *    bumping tolerance to ±10 (a mobile-RTT artefact, not a harness
 *    break). Do not chase a phantom regression.
 *
 *  - **6e4d9c2-regression guard.** The `assertInputFlowMaintained`
 *    contract is the explicit anti-regression for the reverted
 *    inputTick-cap bug (`6e4d9c2`) where the catch-up-loop cap
 *    starved the keyboard read for 27 s. If a future fix re-introduces
 *    that bug class — the cap engages and the loop exits without
 *    emitting an `inputSent` — this contract fires on the very next
 *    harness replay.
 *
 * Current state (2026-05-21):
 *   - FAITHFULNESS: PASS — harness reproduces ticksAhead within ±5.
 *   - USER CONTRACT — no teleport: FAIL (86.3u jump at inputTick=5297 over 11.3 ms).
 *   - USER CONTRACT — input flow: FAIL (held-input window 79–80 s saw only 24 inputSent).
 *   - USER CONTRACT — ticksAhead bounded: FAIL (155 > 60).
 *   - The whole test FAILS until the spiral fix lands. Same intentional pattern as the two predecessors.
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-21T14-21-46Z-1kwv1z';

const ON_DEVICE_TICKS_AHEAD = 155;

describe('replay lock — 1kwv1z phone streaming spiral', () => {
  it('FAITHFULNESS: harness reproduces on-device ticksAhead within ±5', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      Math.abs(trace.finalStats.ticksAhead - ON_DEVICE_TICKS_AHEAD),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, on-device was ${ON_DEVICE_TICKS_AHEAD}. ` +
        `If this drifts past ±5 on a particular host, bump to ±10 — mobile-RTT artefact, not a harness break.`,
    ).toBeLessThanOrEqual(5);
  });

  it('USER CONTRACT — no teleport (FAILS until spiral fix lands)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertNoTeleport(trace);
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  it('USER CONTRACT — input flow maintained under held inputs (FAILS until spiral fix lands; also guards 6e4d9c2-class regression)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertInputFlowMaintained(trace);
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  it('USER CONTRACT — ticksAhead stays bounded (FAILS until spiral fix lands)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertTicksAheadBounded(trace, { maxFinalTicks: 60 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });
});
