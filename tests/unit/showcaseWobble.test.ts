/**
 * The showcase wobble gate (review 2026-11-07): a take whose local ship jumps
 * on screen (prediction corrections) is flagged, a steady one passes, and a
 * shot with no local ship in view is not scored. Calibrated on real takes:
 * capital-guns-fighter measured 0.88 px/frame in its jittery window, a good
 * round-2 take 0.10-0.16.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { wobbleFromCsv, wobbleProblem, netProblem, poseHealth, poseProblem } from '../../showcase/wobble';
import { netDelta } from '../../showcase/recorder';

const HEAD = 'f,t,dt,shipX,shipY,sdx,sdy,bgdx,bgdy,bgN,bgSpread,greenN';
function csv(n: number, sdx: (i: number) => number, green = 40): string {
  const rows = [HEAD];
  for (let i = 0; i < n; i++) rows.push([i, (i * 1000) / 60, 16.7, 960, 540, sdx(i).toFixed(3), '0', '0', '0', 20, 0, green].join(','));
  return rows.join('\n');
}

describe('showcase wobble gate', () => {
  it('a steady ship passes', () => {
    const w = wobbleFromCsv(csv(600, () => 0.02));
    expect(w.p99Px).toBeLessThan(0.05);
    expect(wobbleProblem(w)).toBeNull();
  });

  it('a ship jumping back and forth for a second is flagged', () => {
    const w = wobbleFromCsv(csv(600, (i) => (i > 300 && i < 360 ? (i % 2 ? 4 : -4) : 0)));
    expect(w.spikes).toBeGreaterThan(5);
    expect(wobbleProblem(w)).toMatch(/ship jitter/);
    expect(w.firstSpikeMs).toBeGreaterThan(4000);
  });

  it('a smooth glide (camera easing) is not jitter', () => {
    const w = wobbleFromCsv(csv(600, (i) => Math.sin(i / 60) * 3));
    expect(wobbleProblem(w)).toBeNull();
  });

  it('no local ship in view: not scored', () => {
    expect(wobbleProblem(wobbleFromCsv(csv(600, (i) => (i % 2 ? 2 : -2), 0)))).toBeNull();
  });

  it('the reference good take passes (when present)', () => {
    const f = 'diag/_clip-jitter/good-round2.csv';
    if (!existsSync(f)) return;
    expect(wobbleProblem(wobbleFromCsv(readFileSync(f, 'utf8')))).toBeNull();
  });
});

describe('server pace gate', () => {
  it('flags a take recorded on a server running behind wall-clock', () => {
    expect(netProblem({ serverHz: 25.1, corrections: 17, snapshots: 19 })).toMatch(/server behind: 25.1 Hz/);
    expect(netProblem({ serverHz: 59.8, corrections: 0, snapshots: 120 })).toBeNull();
    expect(netProblem(null)).toBeNull();
  });

  it('derives server Hz and corrections from two samples', () => {
    const a = { t: 1000, serverTick: 600, corrections: 4, snapshots: 10 };
    const b = { t: 3000, serverTick: 720, corrections: 5, snapshots: 50 };
    expect(netDelta(a, b)).toEqual({ serverHz: 60, corrections: 1, snapshots: 40 });
    expect(netDelta(null, b)).toBeNull();
    expect(netDelta(a, { ...b, snapshots: 10 })).toBeNull(); // no snapshots applied
  });
});

describe('pose-trace gate (what the game drew, frame by frame)', () => {
  // rows [t, meX, meY, meA, bigX, bigY, bigA, lerpX, lerpY, inputTick, frameTimeMs, tickDueMs, physX, physY, physVx, physVy]
  const flight = (n: number, edit?: (i: number, r: number[]) => void): number[][] => {
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) {
      const x = i * 3; // 180 u/s at one tick per frame
      const r = [i * 16.7, x, 0, 0, 0, 0, 0, 0, 0, 100 + i, i * 16.7, i * 16.7, x, 0, 180, 0];
      edit?.(i, r);
      rows.push(r);
    }
    return rows;
  };

  it('a steady flight passes', () => {
    const h = poseHealth(flight(120));
    expect(h).toMatchObject({ corrections: 0, tickJumps: 0 });
    expect(poseProblem(h)).toBeNull();
  });

  it('flags a one-tick jump (the 2026-11-07 ack bug signature)', () => {
    // From frame 60 the physics state sits one tick (3 u) ahead.
    const h = poseHealth(flight(120, (i, r) => { if (i >= 60 && i < 70) r[12]! += 3; }));
    expect(h!.tickJumps).toBe(2); // the jump in and the jump back
    expect(poseProblem(h)).toMatch(/tick jumps from 1.0 s/);
  });

  it('flags a take with more than a couple of corrections', () => {
    const h = poseHealth(flight(120, (i, r) => { if (i % 30 === 10) r[7] = 2; }));
    expect(h!.corrections).toBe(4);
    expect(poseProblem(h)).toMatch(/prediction corrections: 4/);
  });

  it('a warp drop-out (speed changes in one tick) is not a tick jump', () => {
    // Cruising at 20,000 u/s (333 u a tick), then dropping on the target at 150 u/s.
    const h = poseHealth(flight(120, (i, r) => {
      if (i >= 40 && i < 80) { r[12] = 3 * 40 + (i - 40) * 333; r[14] = 20_000; }
      if (i >= 80) { r[12] = 3 * 40 + 40 * 333 + (i - 80) * 2.5; r[14] = 150; }
    }));
    expect(h!.tickJumps).toBe(0);
  });
});

