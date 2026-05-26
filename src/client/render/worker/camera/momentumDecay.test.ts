import { describe, it, expect } from 'vitest';
import { MomentumDecay } from './momentumDecay.js';

describe('MomentumDecay', () => {
  it('starts dead (velocity 0, not alive)', () => {
    const m = new MomentumDecay({ decelFactor: 0.9, epsilon: 0.1 });
    expect(m.isAlive()).toBe(false);
    expect(m.velocity()).toEqual({ vx: 0, vy: 0 });
  });

  it('seed sets velocity; step decays then applies', () => {
    const m = new MomentumDecay({ decelFactor: 0.5, epsilon: 0.01 });
    m.seed(10, -4);
    const target = { x: 100, y: 200 };
    m.step(target);
    expect(target).toEqual({ x: 110, y: 196 });
    // After step: vx *= 0.5 → 5; vy *= 0.5 → -2
    expect(m.velocity()).toEqual({ vx: 5, vy: -2 });
  });

  it('clamps to zero below epsilon (no infinite ε tail)', () => {
    const m = new MomentumDecay({ decelFactor: 0.5, epsilon: 1 });
    m.seed(0.3, 0.2); // both below epsilon
    const target = { x: 0, y: 0 };
    m.step(target);
    // Below-epsilon seed: not alive, snap to 0, no target mutation
    expect(target).toEqual({ x: 0, y: 0 });
    expect(m.velocity()).toEqual({ vx: 0, vy: 0 });
  });

  it('clear() halts mid-coast', () => {
    const m = new MomentumDecay({ decelFactor: 0.9, epsilon: 0.01 });
    m.seed(50, 0);
    m.clear();
    expect(m.isAlive()).toBe(false);
  });

  it('alive iff |vx| > eps OR |vy| > eps', () => {
    const m = new MomentumDecay({ decelFactor: 0.9, epsilon: 0.5 });
    m.seed(0, 1);
    expect(m.isAlive()).toBe(true);
    m.seed(0.4, 0.4);
    expect(m.isAlive()).toBe(false);
  });
});
