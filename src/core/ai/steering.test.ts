import { describe, it, expect } from 'vitest';
import { seek, arrive, makeSteerOutput } from './steering.js';

describe('steering — seek', () => {
  it('points a unit vector straight at the target at full thrust', () => {
    const out = makeSteerOutput();
    seek(0, 0, 30, 40, out); // 3-4-5 → dist 50
    expect(out.dist).toBeCloseTo(50, 9);
    expect(out.dirX).toBeCloseTo(0.6, 9);
    expect(out.dirY).toBeCloseTo(0.8, 9);
    expect(out.thrustScale).toBe(1);
  });

  it('zeroes out when already at the target (no NaN direction)', () => {
    const out = makeSteerOutput();
    seek(5, 5, 5, 5, out);
    expect(out.dist).toBe(0);
    expect(out.dirX).toBe(0);
    expect(out.dirY).toBe(0);
    expect(out.thrustScale).toBe(0);
  });
});

describe('steering — arrive (slow down + stop, do not float past)', () => {
  it('full thrust while outside the slow radius', () => {
    const out = makeSteerOutput();
    arrive(0, 0, 0, 500, 200, out); // dist 500 > slowRadius 200
    expect(out.thrustScale).toBe(1);
    expect(out.dirY).toBeCloseTo(1, 9);
  });

  it('ramps thrust DOWN linearly inside the slow radius (eases to a stop)', () => {
    const out = makeSteerOutput();
    arrive(0, 0, 0, 100, 200, out); // dist 100, slowRadius 200 → 0.5
    expect(out.thrustScale).toBeCloseTo(0.5, 9);
    arrive(0, 0, 0, 20, 200, out); // dist 20 → 0.1
    expect(out.thrustScale).toBeCloseTo(0.1, 9);
  });

  it('thrust is monotonic in distance within the slow radius', () => {
    const near = makeSteerOutput();
    const far = makeSteerOutput();
    arrive(0, 0, 0, 50, 200, near);
    arrive(0, 0, 0, 150, 200, far);
    expect(far.thrustScale).toBeGreaterThan(near.thrustScale);
  });

  it('zeroes out at the target', () => {
    const out = makeSteerOutput();
    arrive(10, 10, 10, 10, 200, out);
    expect(out.thrustScale).toBe(0);
    expect(out.dist).toBe(0);
  });
});
