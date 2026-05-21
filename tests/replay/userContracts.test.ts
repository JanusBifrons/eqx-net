/**
 * Self-test for the user-contract assertions. Synthetic ReplayTraces
 * cover passing + failing cases for each contract — proves the
 * assertions actually catch what they claim to catch.
 *
 * Plan: capture-driven replay infra, Phase D (2026-05-21).
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoTeleport,
  assertInputFlowMaintained,
  assertTicksAheadBounded,
  assertGroundTruthMatch,
  assertFramePacingSmooth,
} from './userContracts';
import type { ReplayTrace, RenderedPoseSample, InputSample } from './ReplayTrace';

function emptyTrace(): ReplayTrace {
  return {
    source: { path: 'synthetic', playerId: 'p1' },
    renderedPoses: [],
    capturedRenderedPoses: [],
    predictedPoses: [],
    inputSent: [],
    inputs: [],
    groundTruth: [],
    finalStats: {
      snapshotCount: 0,
      significantCorrectionCount: 0,
      ticksAhead: 0,
      maxDriftUnits: 0,
      rollingCorrRate: 0,
    },
    events: [],
  };
}

const FRAME_MS = 1000 / 60;

function renderedSample(
  i: number,
  x: number,
  y: number,
  angle = 0,
): RenderedPoseSample {
  return {
    atMs: i * FRAME_MS,
    inputTick: 1000 + i,
    x,
    y,
    angle,
    lerpOffsetX: 0,
    lerpOffsetY: 0,
    lerpAngleOffset: 0,
  };
}

describe('assertNoTeleport', () => {
  it('passes on a smooth glide (each frame moves ≤ max envelope)', () => {
    const t = emptyTrace();
    for (let i = 0; i < 100; i++) t.renderedPoses.push(renderedSample(i, i * 5, 0));
    const r = assertNoTeleport(t);
    expect(r.pass).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('FAILS on a teleport (single 100-unit jump between adjacent frames)', () => {
    const t = emptyTrace();
    for (let i = 0; i < 10; i++) t.renderedPoses.push(renderedSample(i, i, 0));
    t.renderedPoses.push(renderedSample(10, 200, 0)); // 191u jump
    for (let i = 11; i < 20; i++) t.renderedPoses.push(renderedSample(i, 200 + (i - 10), 0));
    const r = assertNoTeleport(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.kind).toBe('teleport');
    expect(r.violations[0]!.detail).toContain('frame-to-frame position delta');
  });

  it('does not flag wide RAF gaps (focus loss / long pause)', () => {
    // Two samples 100ms apart — too long for the "consecutive frame"
    // window. Should NOT be flagged even though dist is large.
    const t = emptyTrace();
    t.renderedPoses.push({ ...renderedSample(0, 0, 0) });
    t.renderedPoses.push({ ...renderedSample(0, 100, 0), atMs: 200 }); // 200ms apart
    const r = assertNoTeleport(t);
    expect(r.pass).toBe(true);
  });

  it('respects maxDeltaUnits override', () => {
    const t = emptyTrace();
    for (let i = 0; i < 5; i++) t.renderedPoses.push(renderedSample(i, i * 10, 0)); // 10u per frame
    const strict = assertNoTeleport(t, { maxDeltaUnits: 5 });
    expect(strict.pass).toBe(false);
    const lenient = assertNoTeleport(t, { maxDeltaUnits: 50 });
    expect(lenient.pass).toBe(true);
  });
});

describe('assertInputFlowMaintained', () => {
  function inputSample(atMs: number, held: boolean): InputSample {
    return {
      atMs,
      tick: Math.floor(atMs / FRAME_MS),
      thrust: held,
      turnLeft: false,
      turnRight: false,
      boost: false,
      reverse: false,
      fireHeld: false,
    };
  }

  it('passes when held window has dense inputSent', () => {
    const t = emptyTrace();
    // 2 seconds of held thrust at 60 Hz
    for (let i = 0; i < 120; i++) {
      const ms = i * FRAME_MS;
      t.inputs.push(inputSample(ms, true));
      t.inputSent.push({ atMs: ms, tick: 1000 + i, thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false });
    }
    const r = assertInputFlowMaintained(t);
    expect(r.pass).toBe(true);
  });

  it('FAILS when held window has zero inputSent for >1s (the cap-fix bug)', () => {
    const t = emptyTrace();
    // 2 seconds of held thrust at 60 Hz but NO inputSent events
    for (let i = 0; i < 120; i++) {
      const ms = i * FRAME_MS;
      t.inputs.push(inputSample(ms, true));
      // Intentionally no inputSent push — simulates the cap-fix stall.
    }
    const r = assertInputFlowMaintained(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.kind).toBe('input_starvation');
    expect(r.violations[0]!.detail).toContain('held-input window');
  });

  it('passes vacuously on pre-Phase-A captures (no input_intent stream)', () => {
    const t = emptyTrace();
    const r = assertInputFlowMaintained(t);
    expect(r.pass).toBe(true);
  });

  it('ignores idle (all-false) windows even when inputSent is sparse', () => {
    const t = emptyTrace();
    for (let i = 0; i < 120; i++) {
      const ms = i * FRAME_MS;
      t.inputs.push(inputSample(ms, false));
      // Production throttles idle → 4 Hz heartbeat; this assertion
      // shouldn't flag that.
    }
    const r = assertInputFlowMaintained(t);
    expect(r.pass).toBe(true);
  });
});

describe('assertTicksAheadBounded', () => {
  it('passes when final ticksAhead is reasonable', () => {
    const t = emptyTrace();
    t.finalStats.ticksAhead = 15;
    const r = assertTicksAheadBounded(t);
    expect(r.pass).toBe(true);
  });

  it('FAILS when final ticksAhead > maxFinalTicks', () => {
    const t = emptyTrace();
    t.finalStats.ticksAhead = 327; // the ers7xy on-device number
    const r = assertTicksAheadBounded(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.kind).toBe('ticksAhead_unbounded');
    expect(r.violations[0]!.detail).toContain('s into the future'); // 327 * 16.67 ≈ 5.4-5.5s
  });

  it('respects maxFinalTicks override', () => {
    const t = emptyTrace();
    t.finalStats.ticksAhead = 100;
    expect(assertTicksAheadBounded(t, { maxFinalTicks: 50 }).pass).toBe(false);
    expect(assertTicksAheadBounded(t, { maxFinalTicks: 200 }).pass).toBe(true);
  });
});

describe('assertGroundTruthMatch', () => {
  it('passes when replayed matches captured within tolerance', () => {
    const t = emptyTrace();
    t.groundTruth.push({
      atMs: 1000,
      capturedInputTick: 100,
      captured: { x: 50, y: 50, angle: 0 },
      replayed: { x: 50.1, y: 50.1, angle: 0 },
      deltaX: 0.1,
      deltaY: 0.1,
      deltaAngle: 0,
    });
    const r = assertGroundTruthMatch(t);
    expect(r.pass).toBe(true);
  });

  it('FAILS when replayed diverges from captured beyond tolerance', () => {
    const t = emptyTrace();
    t.groundTruth.push({
      atMs: 1000,
      capturedInputTick: 100,
      captured: { x: 50, y: 50, angle: 0 },
      replayed: { x: 100, y: 100, angle: 0 },
      deltaX: 50,
      deltaY: 50,
      deltaAngle: 0,
    });
    const r = assertGroundTruthMatch(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.kind).toBe('ground_truth_diverged');
  });

  it('FAILS with `no_ground_truth` when groundTruth array is empty', () => {
    const t = emptyTrace();
    const r = assertGroundTruthMatch(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.kind).toBe('no_ground_truth');
  });
});

describe('assertFramePacingSmooth', () => {
  function capturedSample(i: number, x: number, y: number): RenderedPoseSample {
    return {
      atMs: i * FRAME_MS,
      inputTick: 1000 + i,
      x, y,
      angle: 0,
      lerpOffsetX: 0,
      lerpOffsetY: 0,
      lerpAngleOffset: 0,
    };
  }

  it('passes on smooth motion (each frame advances)', () => {
    const t = emptyTrace();
    for (let i = 0; i < 100; i++) t.capturedRenderedPoses.push(capturedSample(i, i, 0));
    const r = assertFramePacingSmooth(t);
    expect(r.pass).toBe(true);
  });

  it('passes on a 3-frame hold (default threshold maxConsecutive=3)', () => {
    const t = emptyTrace();
    // 3-frame run of identical pose, then advance.
    for (let i = 0; i < 3; i++) t.capturedRenderedPoses.push(capturedSample(i, 100, 100));
    for (let i = 3; i < 10; i++) t.capturedRenderedPoses.push(capturedSample(i, 100 + i, 100));
    const r = assertFramePacingSmooth(t);
    expect(r.pass).toBe(true);
  });

  it('FAILS on a 4-frame hold (above threshold=3)', () => {
    const t = emptyTrace();
    for (let i = 0; i < 4; i++) t.capturedRenderedPoses.push(capturedSample(i, 100, 100));
    for (let i = 4; i < 10; i++) t.capturedRenderedPoses.push(capturedSample(i, 100 + i, 100));
    const r = assertFramePacingSmooth(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.kind).toBe('frame_hold');
    expect(r.violations[0]!.detail).toContain('4 consecutive frames');
  });

  it('honors a custom threshold', () => {
    const t = emptyTrace();
    // 5-frame run, threshold raised to 10 → passes.
    for (let i = 0; i < 5; i++) t.capturedRenderedPoses.push(capturedSample(i, 100, 100));
    for (let i = 5; i < 20; i++) t.capturedRenderedPoses.push(capturedSample(i, 100 + i, 100));
    const r = assertFramePacingSmooth(t, { maxConsecutiveSameRender: 10 });
    expect(r.pass).toBe(true);
  });

  it('catches a tail-run hold (last frames frozen)', () => {
    const t = emptyTrace();
    for (let i = 0; i < 5; i++) t.capturedRenderedPoses.push(capturedSample(i, i, 0));
    // Final 8 frames all identical.
    for (let i = 5; i < 13; i++) t.capturedRenderedPoses.push(capturedSample(i, 5, 0));
    const r = assertFramePacingSmooth(t);
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.detail).toContain('tail');
  });

  it('vacuously satisfied when capturedRenderedPoses is empty (pre-Phase-A capture)', () => {
    const t = emptyTrace();
    const r = assertFramePacingSmooth(t);
    expect(r.pass).toBe(true);
    expect(r.violations.length).toBe(0);
  });

  it('reads from `renderedPoses` when useCapturedStream=false', () => {
    const t = emptyTrace();
    for (let i = 0; i < 5; i++) t.renderedPoses.push(renderedSample(i, 100, 100));
    const r = assertFramePacingSmooth(t, { useCapturedStream: false });
    expect(r.pass).toBe(false);
    expect(r.violations[0]!.detail).toContain('5 consecutive frames');
  });
});
