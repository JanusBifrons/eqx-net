import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  SHELL_POS_QUANTUM,
  SHELL_VEL_QUANTUM,
  quantiseShellPos,
  quantiseShellSpawn,
  quantiseShellVel,
  shellPoseAt,
  shellSegmentInView,
  type ShellPoseMut,
  type ShellSpawnMut,
} from './shellFlight.js';

/** Independent oracle: Liang–Barsky slab clip of the segment against the box
 *  [cx ± h] × [cy ± h]. */
function slabHits(
  x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, h: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const clip = (p0: number, d: number, lo: number, hi: number): boolean => {
    if (d === 0) return p0 >= lo && p0 <= hi;
    let a = (lo - p0) / d;
    let b = (hi - p0) / d;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return t0 <= t1;
  };
  return clip(x0, x1 - x0, cx - h, cx + h) && clip(y0, y1 - y0, cy - h, cy + h);
}

const coord = fc.integer({ min: -100_000, max: 100_000 });
const halfArb = fc.integer({ min: 1, max: 30_000 });

describe('shellPoseAt', () => {
  it('is origin at the fire tick and origin + v·k/60 after k ticks', () => {
    const out: ShellPoseMut = { x: NaN, y: NaN };
    shellPoseAt(10, -20, 600, -1200, 100, 100, out);
    expect(out).toEqual({ x: 10, y: -20 });
    shellPoseAt(10, -20, 600, -1200, 100, 160, out);
    expect(out.x).toBeCloseTo(610, 9);
    expect(out.y).toBeCloseTo(-1220, 9);
  });

  it('writes into the caller-owned out object (no allocation)', () => {
    const out: ShellPoseMut = { x: 0, y: 0 };
    shellPoseAt(1, 2, 3, 4, 0, 6, out);
    const same = out;
    shellPoseAt(5, 6, 7, 8, 0, 6, out);
    expect(out).toBe(same);
  });
});

describe('wire quantisation', () => {
  it('rounds positions to 0.1 u and velocities to 0.01 u/s', () => {
    expect(SHELL_POS_QUANTUM).toBe(0.1);
    expect(SHELL_VEL_QUANTUM).toBe(0.01);
    expect(quantiseShellPos(123.456)).toBe(123.5);
    expect(quantiseShellPos(-0.04)).toBe(-0);
    expect(quantiseShellVel(2599.99876)).toBe(2600);
    expect(quantiseShellVel(-17.123)).toBe(-17.12);
    const out: ShellSpawnMut = { x: 0, y: 0, vx: 0, vy: 0 };
    quantiseShellSpawn(1.04, 2.06, 3.004, 4.006, out);
    expect(out).toEqual({ x: 1, y: 2.1, vx: 3, vy: 4.01 });
  });

  it('is idempotent, within half a quantum, and survives a JSON round trip', () => {
    const v = fc.double({ min: -200_000, max: 200_000, noNaN: true });
    fc.assert(fc.property(v, (x) => {
      const p = quantiseShellPos(x);
      const q = quantiseShellVel(x);
      return quantiseShellPos(p) === p
        && quantiseShellVel(q) === q
        && Math.abs(p - x) <= SHELL_POS_QUANTUM / 2 + 1e-9
        && Math.abs(q - x) <= SHELL_VEL_QUANTUM / 2 + 1e-9
        && JSON.parse(JSON.stringify(p)) === p
        && JSON.parse(JSON.stringify(q)) === q;
    }));
  });
});

describe('shellSegmentInView', () => {
  it('a path crossing the view with both ends outside is in view', () => {
    // Left of the box to right of the box, through its middle.
    expect(shellSegmentInView(-5000, 0, 5000, 0, 0, 0, 1000)).toBe(true);
    // Diagonal through a corner region.
    expect(shellSegmentInView(-3000, -1500, 1500, 3000, 0, 0, 1000)).toBe(true);
    // Same line, shifted to pass outside the corner.
    expect(shellSegmentInView(-3000, -500, 500, 3000, 1500, -1500, 1000)).toBe(false);
  });

  it('ends inside, touching edges, misses and a zero-length segment', () => {
    expect(shellSegmentInView(0, 0, 9000, 9000, 0, 0, 10)).toBe(true); // start inside
    expect(shellSegmentInView(-9000, 3, 1, 3, 0, 0, 10)).toBe(true); // end inside
    expect(shellSegmentInView(-50, 10, 50, 10, 0, 0, 10)).toBe(true); // runs along the top edge
    expect(shellSegmentInView(-50, 10.5, 50, 10.5, 0, 0, 10)).toBe(false); // just above
    expect(shellSegmentInView(20, -50, 20, 50, 0, 0, 10)).toBe(false); // parallel, to the right
    expect(shellSegmentInView(5, 5, 5, 5, 0, 0, 10)).toBe(true);
    expect(shellSegmentInView(11, 5, 11, 5, 0, 0, 10)).toBe(false);
    // Collinear with the box's diagonal but stops short of it.
    expect(shellSegmentInView(-100, -100, -20, -20, 0, 0, 10)).toBe(false);
  });

  it('agrees with an independent slab-clip oracle (integer coordinates)', () => {
    fc.assert(fc.property(coord, coord, coord, coord, coord, coord, halfArb,
      (x0, y0, x1, y1, cx, cy, h) =>
        shellSegmentInView(x0, y0, x1, y1, cx, cy, h) === slabHits(x0, y0, x1, y1, cx, cy, h)),
    { numRuns: 5000 });
  });

  it('is symmetric in the segment direction', () => {
    fc.assert(fc.property(coord, coord, coord, coord, coord, coord, halfArb,
      (x0, y0, x1, y1, cx, cy, h) =>
        shellSegmentInView(x0, y0, x1, y1, cx, cy, h) === shellSegmentInView(x1, y1, x0, y0, cx, cy, h)),
    { numRuns: 2000 });
  });

  it('a path through an interior point is in view even with both ends far outside', () => {
    // Pick a point strictly inside the box, a direction, and extend both ends
    // past the box's diagonal so neither end can be inside.
    const arb = fc.record({
      cx: coord, cy: coord, h: halfArb,
      fx: fc.double({ min: -0.99, max: 0.99, noNaN: true }),
      fy: fc.double({ min: -0.99, max: 0.99, noNaN: true }),
      theta: fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
      ka: fc.double({ min: 3, max: 50, noNaN: true }),
      kb: fc.double({ min: 3, max: 50, noNaN: true }),
    });
    fc.assert(fc.property(arb, ({ cx, cy, h, fx, fy, theta, ka, kb }) => {
      const px = cx + fx * h;
      const py = cy + fy * h;
      const dx = Math.cos(theta);
      const dy = Math.sin(theta);
      const x0 = px - dx * ka * h;
      const y0 = py - dy * ka * h;
      const x1 = px + dx * kb * h;
      const y1 = py + dy * kb * h;
      const outside = (x: number, y: number) => Math.abs(x - cx) > h || Math.abs(y - cy) > h;
      return outside(x0, y0) && outside(x1, y1) && shellSegmentInView(x0, y0, x1, y1, cx, cy, h);
    }), { numRuns: 3000 });
  });

  it('never claims a path whose every point is outside a slightly grown box', () => {
    // Soundness: when it says "in view", some sampled point of the segment is
    // within the box grown by a hair; when every dense sample is well inside,
    // it must say "in view".
    fc.assert(fc.property(coord, coord, coord, coord, coord, coord, halfArb,
      (x0, y0, x1, y1, cx, cy, h) => {
        const res = shellSegmentInView(x0, y0, x1, y1, cx, cy, h);
        let deepInside = false;
        for (let i = 0; i <= 256; i++) {
          const t = i / 256;
          const x = x0 + (x1 - x0) * t;
          const y = y0 + (y1 - y0) * t;
          if (Math.abs(x - cx) < h * 0.999 && Math.abs(y - cy) < h * 0.999) { deepInside = true; break; }
        }
        return !deepInside || res;
      }), { numRuns: 3000 });
  });
});
