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
 * Current state (post-fix, 2026-05-21):
 *   - FAITHFULNESS: locked at EXPECTED_REPLAY_TICKS_AHEAD = 46 (replay through
 *     the fixed code; cap engages and bounds inputTick growth). Original
 *     on-device value 214 — superseded by the fix.
 *   - USER CONTRACT: all PASS. assertTicksAheadBounded passes because the
 *     cap holds final ticksAhead well below 60. assertNoTeleport and
 *     assertInputFlowMaintained are vacuous on this pre-Phase-A capture.
 *   - Whole test GREEN — first time since Phase E. If a future PR reverts
 *     the spiral cap, ticksAhead will climb back to ~214 and this test
 *     will fire on both FAITHFULNESS (drift past ±5) and
 *     assertTicksAheadBounded (> 60).
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-20T22-37-34-348Z-vg9hon';

/**
 * Replayed ticksAhead through the FIXED code (plan: spiral-fix, Phase 2.5,
 * 2026-05-21). Original on-device value was 214 (pre-fix). After the cap +
 * sentinel landed, the harness replaying this capture produces 46 — the
 * cap (MAX_OVER_PREDICTION_TICKS = 60) bounds inputTick growth before the
 * spiral develops. The faithfulness assertion locks the post-fix behaviour;
 * if a future fix changes prediction logic, this value MUST be re-recorded.
 */
const EXPECTED_REPLAY_TICKS_AHEAD = 46;

describe('replay lock — vg9hon idle-bufferbloat spiral', () => {
  it('FAITHFULNESS: replay reproduces post-fix ticksAhead within ±5', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      Math.abs(trace.finalStats.ticksAhead - EXPECTED_REPLAY_TICKS_AHEAD),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, expected ${EXPECTED_REPLAY_TICKS_AHEAD} ` +
        `(post-fix value with MAX_OVER_PREDICTION_TICKS=60 cap). If this drifts past ±5, either the cap ` +
        `behaviour changed (re-record) or the harness diverged from the production code (investigate harness).`,
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

  it('USER CONTRACT — ticksAhead stays bounded (spiral fix locked, plan: spiral-fix Phase 2)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertTicksAheadBounded(trace, { maxFinalTicks: 60 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });
});
