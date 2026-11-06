/**
 * Fly-by judder lock (user, 2026-11-05: "The ship is jittering around
 * everywhere like crazy in the clip"). Simulates `tickPhysics`' wall-clock
 * anchored stepping under a 60 Hz display whose frames jitter by ±1 ms
 * against the 60 Hz tick grid (so frames run 0, 1 or 2 ticks), and draws
 * the ship the way `updateMirror` does: last state + velocity × min(cap,
 * now − stamp). Measured from the tick's DUE time the drawn motion is
 * smooth; measured from the processing time (the old stamp) it step-stalls.
 */
import { describe, expect, it } from 'vitest';
import { DEAD_RECKON_BACK_MS, DEAD_RECKON_CAP_MS, tickBoundaryDueMs , slewTickDue } from './renderTickPhase';

const F = 1000 / 60;
const V = 200; // u/s, constant cruise

/** `workMs(f)`: this frame's snapshot work before tickPhysics reads the clock;
 *  `drawAt`: render at the frame timestamp, or at the clock after the work. */
function simulate(stamp: 'due' | 'processed', cap: number, workMs: (f: number) => number = () => 0, drawAt: 'frame' | 'clock' = 'clock'): { worst: number; steps: Set<number> } {
  const anchorPerf = 0, anchorTick = 1000, lead = 6;
  let inputTick = anchorTick + lead;
  let x = 0; // state at boundary inputTick
  let stampMs = tickBoundaryDueMs(anchorPerf, anchorTick, lead, inputTick, F);
  let prevDrawn = NaN;
  let worst = 0;
  const steps = new Set<number>();
  // Display frames ~ every 16.667 ms with a 0.37 ms phase offset and ±1 ms jitter.
  for (let f = 1; f < 2000; f++) {
    const now = f * F + 0.37 + Math.sin(f * 1.7) * 1.0;
    const clockAtPhysics = now + workMs(f);
    const target = anchorTick + Math.floor((clockAtPhysics - anchorPerf) / F) + lead;
    let n = 0;
    while (inputTick < target && n < 4) {
      inputTick++; n++;
      x += V * (F / 1000);
      stampMs = stamp === 'due' ? tickBoundaryDueMs(anchorPerf, anchorTick, lead, inputTick, F) : clockAtPhysics;
    }
    steps.add(n);
    const at = drawAt === 'frame' ? now : clockAtPhysics + 0.5;
    const lo = drawAt === 'frame' ? -DEAD_RECKON_BACK_MS : 0;
    const drawn = x + V * (Math.max(lo, Math.min(cap, at - stampMs)) / 1000);
    if (!Number.isNaN(prevDrawn)) {
      const prevNow = (f - 1) * F + 0.37 + Math.sin((f - 1) * 1.7) * 1.0;
      const ideal = V * ((now - prevNow) / 1000);
      worst = Math.max(worst, Math.abs((drawn - prevDrawn) - ideal) / (V * F / 1000));
    }
    prevDrawn = drawn;
  }
  return { worst, steps };
}

describe('local ship dead-reckon is measured from the tick due time', () => {
  it('frames really do run 0, 1 and 2 ticks in this schedule', () => {
    const s = simulate('due', DEAD_RECKON_CAP_MS).steps;
    expect(s.has(0) && s.has(1) && s.has(2)).toBe(true);
  });

  it('from the due time, each frame moves by its real elapsed time (within 1 % of a tick)', () => {
    expect(simulate('due', DEAD_RECKON_CAP_MS).worst).toBeLessThan(0.01);
  });

  it('the old processing-time stamp step-stalls by most of a tick (the bug)', () => {
    expect(simulate('processed', 32).worst).toBeGreaterThan(0.5);
  });


  // Snapshot work before the physics step varies frame to frame (more near
  // capitals: more entities and turret angles to apply).
  const work = (f: number): number => 3 + 3 * Math.sin(f * 0.9) * Math.cos(f * 2.3);

  it('with varying frame work, drawing at the frame timestamp stays smooth', () => {
    expect(simulate('due', DEAD_RECKON_CAP_MS, work, 'frame').worst).toBeLessThan(0.01);
  });

  it('with varying frame work, drawing at the clock after the work wobbles (the near-capital residue)', () => {
    expect(simulate('due', DEAD_RECKON_CAP_MS, work, 'clock').worst).toBeGreaterThan(0.15);
  });
});

/**
 * Bug (round 3 / Phase 0 clips, 2026-11-06): about one take in two the local
 * ship lurched a tick (~4.5 u) and eased back over ~100 ms. A late snapshot
 * (100-166 ms gap under capital-scene server load) moves the EWMA clock anchor
 * by ~alpha x gap = ~16 ms; the drawn pose dead-reckons from a due time built
 * on that anchor, so the network timing moved the drawn ship by a whole tick.
 * The render due time must advance one tick per tick and only SLEW toward the
 * anchor's value.
 */
describe('slewTickDue: the drawn pose does not inherit anchor steps', () => {
  const F = 1000 / 60;
  it('a one-tick anchor step moves the render due time by at most the slew', () => {
    let due = 1000;
    // Steady: the target advances exactly one tick per tick.
    for (let i = 1; i <= 10; i++) due = slewTickDue(due, 1000 + i * F, F, 0.5, 200);
    expect(due).toBeCloseTo(1000 + 10 * F, 6);
    // The anchor jumps a whole tick late: target = next + F.
    const before = due;
    due = slewTickDue(due, before + F + F, F, 0.5, 200);
    expect(due - before).toBeCloseTo(F + 0.5, 6);
  });

  it('closes a sustained offset gradually, and snaps a stall-sized one', () => {
    let due = 0;
    let target = 0;
    for (let i = 0; i < 40; i++) { target += F; due = slewTickDue(due, target + 10, F, 0.5, 200); }
    expect(Math.abs(due - (target + 10))).toBeLessThan(0.5 + 1e-9); // 10 ms closed in 20 ticks
    expect(slewTickDue(0, 0 + F + 500, F, 0.5, 200)).toBe(F + 500); // > 200 ms: snap
  });
});
