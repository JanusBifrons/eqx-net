/**
 * Regression lock — `vg9hon` on-device capture (2026-05-20T22-37-34Z).
 *
 * Plan: capture-driven replay infra, Phase E (2026-05-21).
 *
 * The capture: phone, idle player (no inputs), Sol-Prime, 30-second
 * session. User reported on-device experience as "worse than ever"
 * with sustained prediction-spiral. Captured `data-pred-stats` showed
 * final ticksAhead = 214 (~3.6 s of prediction lead).
 *
 * Why this test exists — TWO contracts, both load-bearing:
 *
 *  1. FAITHFULNESS (always must pass): the harness's replay of this
 *     capture through the REAL `ColyseusGameClient` must reproduce
 *     the on-device `ticksAhead` value within ±5. If it doesn't, the
 *     harness has diverged from reality and CANNOT be trusted as a
 *     surrogate for on-device behaviour. A fix that passes the user
 *     contracts but breaks this assertion means the harness is broken,
 *     not the production code — investigate the harness BEFORE
 *     trusting any spiral-fix verdict.
 *
 *  2. USER CONTRACT (currently fails, future fixes must pass): the
 *     full suite of `assertX` user contracts must all return PASS.
 *     Today they fail on `assertTicksAheadBounded` because the spiral
 *     is real and unfixed. When a real spiral fix lands in Phase F,
 *     this assertion turns GREEN — without falsifying any other
 *     assertion (no teleport, no input starvation).
 *
 * The vg9hon capture predates Phase A's enriched capture format, so
 * `input_intent` / `local_pose_rendered` are absent. This means:
 *   - assertInputFlowMaintained is VACUOUS (no held-input windows
 *     detected). Doesn't fire. Future fresh captures will exercise it.
 *   - assertGroundTruthMatch is N/A here (no captured local_pose_rendered).
 *     Future fresh captures will validate harness faithfulness more
 *     finely.
 *
 * Current state (2026-05-21):
 *   - FAITHFULNESS: PASS — harness reproduces on-device ticksAhead=214.
 *   - USER CONTRACT: FAIL on assertTicksAheadBounded (spiral exists,
 *     no fix yet).
 *   - The whole test FAILS until Phase F lands a real spiral fix.
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-20T22-37-34-348Z-vg9hon';

/** On-device final ticksAhead, read from the capture's `summary.json`. */
const ON_DEVICE_TICKS_AHEAD = 214;

describe('replay lock — vg9hon idle-bufferbloat spiral', () => {
  it('FAITHFULNESS: harness reproduces on-device ticksAhead within ±5', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      Math.abs(trace.finalStats.ticksAhead - ON_DEVICE_TICKS_AHEAD),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, on-device was ${ON_DEVICE_TICKS_AHEAD}. ` +
        `If this fails, the harness no longer reproduces real-device prediction state and CANNOT be trusted ` +
        `as a surrogate for on-device behaviour. Investigate the harness BEFORE any production-code claims.`,
    ).toBeLessThanOrEqual(5);
  });

  it('USER CONTRACT — no teleport in rendered pose stream', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertNoTeleport(trace);
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  it('USER CONTRACT — input flow maintained under held inputs (vacuous on pre-Phase-A captures)', async () => {
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
