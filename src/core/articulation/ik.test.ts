import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  solveTwoBoneReach,
  twoBoneForward,
  createIkReachOut,
  IK_NO_LIMITS,
  type IkLimits,
  type IkReachOut,
} from './ik.js';

const fk = createIkReachOut();

/** FK of `out`'s angles, written into the shared `fk` scratch. */
function fkOf(
  out: IkReachOut,
  bx: number,
  by: number,
  ba: number,
  l1: number,
  l2: number,
): IkReachOut {
  twoBoneForward(bx, by, ba, l1, l2, out.shoulder, out.elbow, fk);
  return fk;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

describe('solveTwoBoneReach — reachable targets', () => {
  it('hits a reachable target exactly (FK within 1e-6)', () => {
    const out = createIkReachOut();
    solveTwoBoneReach(10, -5, 0.3, 40, 30, 50, 20, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(true);
    const f = fkOf(out, 10, -5, 0.3, 40, 30);
    expect(dist(f.endX, f.endY, 50, 20)).toBeLessThan(1e-6);
    expect(dist(out.endX, out.endY, 50, 20)).toBeLessThan(1e-6);
    expect(dist(out.elbowX, out.elbowY, 10, -5)).toBeCloseTo(40, 9);
  });

  it('property: any target inside the reach annulus is hit within 1e-6', () => {
    const out = createIkReachOut();
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 1, max: 200, noNaN: true }),
        fc.double({ min: 1, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.boolean(),
        (bx, by, ba, l1, l2, t, dir, up) => {
          const lo = Math.abs(l1 - l2);
          const hi = l1 + l2;
          // Stay a hair inside the annulus so acos is well conditioned.
          const r = lo + (hi - lo) * (0.001 + 0.998 * t);
          const tx = bx + r * Math.cos(dir);
          const ty = by + r * Math.sin(dir);
          solveTwoBoneReach(bx, by, ba, l1, l2, tx, ty, IK_NO_LIMITS, up ? 1 : -1, out);
          const f = fkOf(out, bx, by, ba, l1, l2);
          expect(dist(f.endX, f.endY, tx, ty)).toBeLessThan(1e-6);
          expect(out.reached).toBe(true);
          expect(Math.abs(out.shoulder)).toBeLessThanOrEqual(Math.PI);
          expect(Math.abs(out.elbow)).toBeLessThanOrEqual(Math.PI);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('solveTwoBoneReach — out of range', () => {
  it('too far: fully extends toward the target, reached=false', () => {
    const out = createIkReachOut();
    solveTwoBoneReach(0, 0, 1.0, 40, 30, 300, 400, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(false);
    expect(out.elbow).toBeCloseTo(0, 9);
    // Tip at full reach (70) along the target direction (3,4)/5.
    expect(out.endX).toBeCloseTo(42, 6);
    expect(out.endY).toBeCloseTo(56, 6);
    const f = fkOf(out, 0, 0, 1.0, 40, 30);
    expect(f.endX).toBe(out.endX);
    expect(f.endY).toBe(out.endY);
  });

  it('too close: folds to the minimum reach toward the target, reached=false', () => {
    const out = createIkReachOut();
    // l1=40, l2=30 → min reach 10; target at distance 2 along +y.
    solveTwoBoneReach(0, 0, 0, 40, 30, 0, 2, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(false);
    expect(Math.abs(out.elbow)).toBeCloseTo(Math.PI, 9);
    expect(out.endX).toBeCloseTo(0, 6);
    expect(out.endY).toBeCloseTo(10, 6);
  });

  it('too close with a longer forearm still folds toward the target', () => {
    const out = createIkReachOut();
    solveTwoBoneReach(0, 0, 0, 20, 50, 5, 0, IK_NO_LIMITS, -1, out);
    expect(out.reached).toBe(false);
    expect(out.endX).toBeCloseTo(30, 6);
    expect(out.endY).toBeCloseTo(0, 6);
  });
});

describe('solveTwoBoneReach — joint limits', () => {
  const limits: IkLimits = { shoulderMin: -0.5, shoulderMax: 0.5, elbowMin: 0, elbowMax: 1.2 };

  it('respects limits and reports the true (FK) end point', () => {
    const out = createIkReachOut();
    fc.assert(
      fc.property(
        fc.double({ min: -150, max: 150, noNaN: true }),
        fc.double({ min: -150, max: 150, noNaN: true }),
        fc.boolean(),
        (tx, ty, up) => {
          solveTwoBoneReach(0, 0, 0.2, 60, 45, tx, ty, limits, up ? 1 : -1, out);
          expect(out.shoulder).toBeGreaterThanOrEqual(limits.shoulderMin);
          expect(out.shoulder).toBeLessThanOrEqual(limits.shoulderMax);
          expect(out.elbow).toBeGreaterThanOrEqual(limits.elbowMin);
          expect(out.elbow).toBeLessThanOrEqual(limits.elbowMax);
          const f = fkOf(out, 0, 0, 0.2, 60, 45);
          expect(out.endX).toBe(f.endX);
          expect(out.endY).toBe(f.endY);
          expect(out.reached).toBe(dist(out.endX, out.endY, tx, ty) <= 1e-6 * 105);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a target behind the shoulder limit is not reached', () => {
    const out = createIkReachOut();
    solveTwoBoneReach(0, 0, 0, 60, 45, -80, 0, limits, 1, out);
    expect(out.reached).toBe(false);
  });

  it('a limited solve still hits a target the limits allow', () => {
    const out = createIkReachOut();
    // Shoulder 0.1, elbow 0.6 lies inside the limits.
    twoBoneForward(0, 0, 0.2, 60, 45, 0.1, 0.6, fk);
    const tx = fk.endX;
    const ty = fk.endY;
    solveTwoBoneReach(0, 0, 0.2, 60, 45, tx, ty, limits, 1, out);
    expect(out.reached).toBe(true);
    expect(out.shoulder).toBeCloseTo(0.1, 9);
    expect(out.elbow).toBeCloseTo(0.6, 9);
  });

  it('clamps across the ±π wrap to the angularly nearer limit', () => {
    const out = createIkReachOut();
    const lim: IkLimits = { shoulderMin: -2.5, shoulderMax: -0.5, elbowMin: -Infinity, elbowMax: Infinity };
    // Unclamped shoulder wants ~+2.8 (just short of +π): nearer to -2.5 across the wrap.
    solveTwoBoneReach(0, 0, 0, 50, 50, -100 * Math.cos(0.34), 100 * Math.sin(0.34), lim, 1, out);
    expect(out.shoulder).toBe(-2.5);
  });
});

describe('solveTwoBoneReach — bendSign', () => {
  it('flips the elbow side; both hit the target', () => {
    const up = createIkReachOut();
    const down = createIkReachOut();
    solveTwoBoneReach(0, 0, 0, 40, 40, 50, 10, IK_NO_LIMITS, 1, up);
    solveTwoBoneReach(0, 0, 0, 40, 40, 50, 10, IK_NO_LIMITS, -1, down);
    expect(up.elbow).toBeGreaterThan(0);
    expect(down.elbow).toBeLessThan(0);
    expect(up.elbow).toBeCloseTo(-down.elbow, 12);
    // Elbow joints lie on opposite sides of the base→target line.
    const side = (x: number, y: number): number => 50 * y - 10 * x;
    expect(Math.sign(side(up.elbowX, up.elbowY))).toBe(-Math.sign(side(down.elbowX, down.elbowY)));
    expect(up.reached && down.reached).toBe(true);
  });
});

describe('solveTwoBoneReach — degenerate input', () => {
  it('target at the base with equal bones: folds shut and reaches', () => {
    const out = createIkReachOut();
    solveTwoBoneReach(5, 5, 0.7, 30, 30, 5, 5, IK_NO_LIMITS, 1, out);
    expect(Number.isFinite(out.shoulder) && Number.isFinite(out.elbow)).toBe(true);
    expect(out.reached).toBe(true);
    expect(dist(out.endX, out.endY, 5, 5)).toBeLessThan(1e-6);
  });

  it('target at the base with unequal bones: aims along baseAngle', () => {
    const out = createIkReachOut();
    solveTwoBoneReach(0, 0, 0.7, 40, 30, 0, 0, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(false);
    expect(out.endX).toBeCloseTo(10 * Math.cos(0.7), 6);
    expect(out.endY).toBeCloseTo(10 * Math.sin(0.7), 6);
  });

  it('zero / negative / NaN lengths are guarded (no NaN out)', () => {
    const out = createIkReachOut();
    const cases: Array<[number, number]> = [
      [0, 0],
      [0, 30],
      [30, 0],
      [-5, 20],
      [Number.NaN, 20],
      [20, Infinity],
    ];
    for (const [l1, l2] of cases) {
      solveTwoBoneReach(1, 2, 0.4, l1, l2, 30, 40, IK_NO_LIMITS, 1, out);
      for (const v of [out.shoulder, out.elbow, out.elbowX, out.elbowY, out.endX, out.endY]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    // Zero arm at a target on the base reaches; anywhere else does not.
    solveTwoBoneReach(1, 2, 0, 0, 0, 1, 2, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(true);
    solveTwoBoneReach(1, 2, 0, 0, 0, 3, 2, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(false);
    // One live bone points straight at the target.
    solveTwoBoneReach(0, 0, 0, 0, 50, 0, 50, IK_NO_LIMITS, 1, out);
    expect(out.reached).toBe(true);
  });
});

describe('solveTwoBoneReach — determinism and allocation', () => {
  it('same input gives bit-identical output', () => {
    const a = createIkReachOut();
    const b = createIkReachOut();
    for (let i = 0; i < 200; i++) {
      const tx = Math.sin(i * 1.7) * 120;
      const ty = Math.cos(i * 0.9) * 120;
      solveTwoBoneReach(3, -4, i * 0.05, 55, 40, tx, ty, IK_NO_LIMITS, i % 2 === 0 ? 1 : -1, a);
      solveTwoBoneReach(3, -4, i * 0.05, 55, 40, tx, ty, IK_NO_LIMITS, i % 2 === 0 ? 1 : -1, b);
      expect(b).toEqual(a);
      expect(Object.is(a.shoulder, b.shoulder) && Object.is(a.elbow, b.elbow)).toBe(true);
    }
  });

  it('writes only into the caller scratch (sealed, same identity, same keys)', () => {
    const out = Object.seal(createIkReachOut());
    const keys = Object.keys(out).join(',');
    for (let i = 0; i < 100; i++) {
      solveTwoBoneReach(0, 0, 0, 30, 20, i, 100 - i, IK_NO_LIMITS, 1, out);
    }
    expect(Object.keys(out).join(',')).toBe(keys);
  });

  // Counts bytes, never time. Needs --expose-gc (`pnpm test:gc`); skipped otherwise.
  const gc = (globalThis as { gc?: () => void }).gc;
  it.skipIf(typeof gc !== 'function')('does not grow the heap over 100k solves', () => {
    const out = createIkReachOut();
    const lim: IkLimits = { shoulderMin: -1, shoulderMax: 1, elbowMin: -2, elbowMax: 2 };
    let sink = 0;
    for (let i = 0; i < 1000; i++) {
      solveTwoBoneReach(0, 0, 0, 30, 20, i % 70, 10, lim, 1, out);
      sink += out.endX;
    }
    gc!();
    gc!();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100_000; i++) {
      solveTwoBoneReach(0, 0, 0, 30, 20, i % 70, (i % 13) - 6, lim, i % 2 === 0 ? 1 : -1, out);
      sink += out.endX;
    }
    gc!();
    gc!();
    const after = process.memoryUsage().heapUsed;
    expect(Number.isFinite(sink)).toBe(true);
    expect(after - before).toBeLessThan(200_000);
  });
});
