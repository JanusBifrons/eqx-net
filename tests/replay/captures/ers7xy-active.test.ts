/**
 * Regression lock — `ers7xy` on-device capture (2026-05-20T22-47-58Z).
 *
 * Sibling to vg9hon-idle.test.ts but for the active-combat session.
 * Capture's on-device final ticksAhead = 327 (~5.4 s of prediction
 * lead). Active player input (joystick + fire) plus drone combat plus
 * mobile-network bufferbloat — the dominant scenario in the "worse
 * than ever" report. rafP50Ms = 88.8 (~11 fps), indicating the main
 * thread was saturated by per-snapshot replay cost.
 *
 * Same contract structure as vg9hon-idle.test.ts — see that file's
 * header for the rationale.
 *
 * Current state (post-fix, 2026-05-21):
 *   - FAITHFULNESS: locked at EXPECTED_REPLAY_TICKS_AHEAD = 58 (post-fix
 *     replay; was 327 on-device pre-fix). The cap holds inputTick just
 *     under 60 above ackedTick in steady-state spiral conditions.
 *   - USER CONTRACT: all PASS (assertTicksAheadBounded green; the others
 *     are vacuous on this pre-Phase-A capture).
 *   - Whole test GREEN. Locks the spiral cap (plan: spiral-fix Phase 2).
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-20T22-47-58-606Z-ers7xy';

/**
 * Replayed ticksAhead through the FIXED code (plan: spiral-fix, Phase 2.5,
 * 2026-05-21). Original on-device value was 327 (pre-fix). After the cap
 * landed, the harness replaying this capture produces 58 (just under the
 * 60-tick cap). If a future fix changes prediction logic, re-record.
 */
const EXPECTED_REPLAY_TICKS_AHEAD = 58;

describe('replay lock — ers7xy active-combat spiral', () => {
  it('FAITHFULNESS: replay reproduces post-fix ticksAhead within ±5', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      Math.abs(trace.finalStats.ticksAhead - EXPECTED_REPLAY_TICKS_AHEAD),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, expected ${EXPECTED_REPLAY_TICKS_AHEAD} (post-fix cap)`,
    ).toBeLessThanOrEqual(5);
  });

  it('USER CONTRACT — no teleport', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertNoTeleport(trace);
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  it('USER CONTRACT — input flow maintained (vacuous on pre-Phase-A captures)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertInputFlowMaintained(trace);
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });

  it('USER CONTRACT — ticksAhead bounded (spiral fix locked, plan: spiral-fix Phase 2)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertTicksAheadBounded(trace, { maxFinalTicks: 60 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });
});
