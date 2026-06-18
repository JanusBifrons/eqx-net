import { describe, it, expect } from 'vitest';
import {
  makeFlockAccumulator,
  makeFlockOutput,
  resetFlock,
  addCohesion,
  addAlignment,
  addSeparation,
  resolveFlock,
  FLOCK_SEPARATION_RADIUS,
  FLOCK_COHESION_GAIN,
  FLOCK_FOLLOW_DISTANCE,
} from './flocking.js';

describe('flocking — cohesion (toward the leader anchor, with arrival ramp)', () => {
  it('pulls toward the anchor at FULL gain beyond the follow-distance', () => {
    const acc = makeFlockAccumulator();
    // Anchor to the +x well beyond the follow-distance → pull is +x at full gain.
    addCohesion(acc, 0, 0, FLOCK_FOLLOW_DISTANCE * 3, 0);
    expect(acc.x).toBeGreaterThan(0);
    expect(acc.y).toBeCloseTo(0, 6);
    expect(acc.x).toBeCloseTo(FLOCK_COHESION_GAIN, 6); // ramp == 1 beyond follow-distance
  });

  it('ARRIVAL ramp: weaker pull inside the follow-distance, linear to 0 at the anchor', () => {
    const near = makeFlockAccumulator();
    const far = makeFlockAccumulator();
    addCohesion(near, 0, 0, FLOCK_FOLLOW_DISTANCE * 0.4, 0); // inside → ramped down
    addCohesion(far, 0, 0, FLOCK_FOLLOW_DISTANCE * 3, 0); // beyond → full
    expect(Math.abs(near.x)).toBeLessThan(Math.abs(far.x));
    // Halfway in is half the full pull (the linear arrival ramp).
    const half = makeFlockAccumulator();
    addCohesion(half, 0, 0, FLOCK_FOLLOW_DISTANCE * 0.5, 0);
    expect(Math.abs(half.x)).toBeCloseTo(FLOCK_COHESION_GAIN * 0.5, 6);
  });

  it('no pull when already at the anchor', () => {
    const acc = makeFlockAccumulator();
    addCohesion(acc, 100, 100, 100, 100);
    expect(acc.x).toBe(0);
    expect(acc.y).toBe(0);
  });
});

describe('flocking — alignment', () => {
  it('adds the leader forward vector ((-sin, cos))', () => {
    const acc = makeFlockAccumulator();
    addAlignment(acc, 0, 1); // angle 0 → forward (0, 1)
    expect(acc.x).toBeCloseTo(0, 6);
    expect(acc.y).toBeCloseTo(1, 6);
  });
});

describe('flocking — separation', () => {
  it('pushes away from a too-close neighbour', () => {
    const acc = makeFlockAccumulator();
    // Neighbour just to the +x, well inside the radius → push toward -x.
    addSeparation(acc, 0, 0, FLOCK_SEPARATION_RADIUS * 0.2, 0);
    expect(acc.x).toBeLessThan(0);
  });

  it('ignores a neighbour beyond the separation radius', () => {
    const acc = makeFlockAccumulator();
    addSeparation(acc, 0, 0, FLOCK_SEPARATION_RADIUS * 2, 0);
    expect(acc.x).toBe(0);
    expect(acc.y).toBe(0);
  });

  it('pushes harder the closer the neighbour is', () => {
    const close = makeFlockAccumulator();
    const farther = makeFlockAccumulator();
    addSeparation(close, 0, 0, FLOCK_SEPARATION_RADIUS * 0.1, 0);
    addSeparation(farther, 0, 0, FLOCK_SEPARATION_RADIUS * 0.8, 0);
    expect(Math.abs(close.x)).toBeGreaterThan(Math.abs(farther.x));
  });

  it('breaks apart two exactly-coincident drones deterministically', () => {
    const acc = makeFlockAccumulator();
    addSeparation(acc, 50, 50, 50, 50);
    expect(acc.x).toBeGreaterThan(0); // deterministic +x nudge
  });
});

describe('flocking — resolveFlock', () => {
  it('normalises to a unit direction + caps the thrust scale at 1', () => {
    const acc = makeFlockAccumulator();
    acc.x = 3;
    acc.y = 4; // magnitude 5 → capped to 1 (calm cruise; no boost above cruise)
    const out = resolveFlock(acc, makeFlockOutput());
    expect(Math.hypot(out.dirX, out.dirY)).toBeCloseTo(1, 6);
    expect(out.dirX).toBeCloseTo(0.6, 6);
    expect(out.dirY).toBeCloseTo(0.8, 6);
    expect(out.thrustScale).toBe(1);
  });

  it('a small vector yields a sub-1 thrust scale', () => {
    const acc = makeFlockAccumulator();
    acc.x = 0.3;
    acc.y = 0;
    const out = resolveFlock(acc, makeFlockOutput());
    expect(out.thrustScale).toBeCloseTo(0.3, 6);
  });

  it('zero vector ⇒ no steer', () => {
    const out = resolveFlock(makeFlockAccumulator(), makeFlockOutput());
    expect(out.thrustScale).toBe(0);
    expect(out.dirX).toBe(0);
    expect(out.dirY).toBe(0);
  });

  it('a herd member: cohesion toward centroid + alignment + separation blends sanely', () => {
    // Follower at origin; squad centroid ahead in +y; leader heading +y;
    // one neighbour close on +x (separation toward -x).
    const acc = makeFlockAccumulator();
    resetFlock(acc);
    addCohesion(acc, 0, 0, 0, 300); // pull +y toward the centroid
    addAlignment(acc, 0); // leader forward (0,1)
    addSeparation(acc, 0, 0, FLOCK_SEPARATION_RADIUS * 0.3, 0); // push -x
    const out = resolveFlock(acc, makeFlockOutput());
    // Net: forward/cohesion +y with a bit of -x separation → mostly +y, slight -x.
    expect(out.dirY).toBeGreaterThan(0);
    expect(out.dirX).toBeLessThan(0);
    expect(out.thrustScale).toBeGreaterThan(0);
  });
});
