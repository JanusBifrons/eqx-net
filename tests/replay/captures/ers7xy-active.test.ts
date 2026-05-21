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
 * Current state (2026-05-21):
 *   - FAITHFULNESS: PASS — harness reproduces ticksAhead within ±5.
 *   - USER CONTRACT: FAIL on assertTicksAheadBounded (no fix yet).
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
} from '../userContracts';

const CAPTURE_PATH = 'diag/captures/2026-05-20T22-47-58-606Z-ers7xy';

const ON_DEVICE_TICKS_AHEAD = 327;

describe('replay lock — ers7xy active-combat spiral', () => {
  it('FAITHFULNESS: harness reproduces on-device ticksAhead within ±5', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    expect(
      Math.abs(trace.finalStats.ticksAhead - ON_DEVICE_TICKS_AHEAD),
      `harness ticksAhead=${trace.finalStats.ticksAhead}, on-device was ${ON_DEVICE_TICKS_AHEAD}`,
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

  it('USER CONTRACT — ticksAhead bounded (FAILS until spiral fix lands)', async () => {
    const trace = await replayCapture(CAPTURE_PATH);
    const r = assertTicksAheadBounded(trace, { maxFinalTicks: 60 });
    expect(r.pass, r.violations.map((v) => v.detail).join('\n')).toBe(true);
  });
});
