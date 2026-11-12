import { describe, it, expect } from 'vitest';
import { LoadSpeedController } from './LoadSpeedController.js';

const W = 60; // one window: 60 ticks real time allowed

describe('LoadSpeedController (automatic slowdown)', () => {
  it('a healthy sector stays at 1', () => {
    const c = new LoadSpeedController();
    for (let i = 0; i < 20; i++) expect(c.window(0, W, 1)).toBe(1);
  });

  it('slows fast to the speed the deficit implies', () => {
    const c = new LoadSpeedController();
    // 12 of 60 ticks late (20 %): drop to 0.8 at once.
    expect(c.window(12, W, 1)).toBeCloseTo(0.8, 5);
  });

  it('never below the floor, from lateness or cost', () => {
    const c = new LoadSpeedController();
    expect(c.window(50, W, 1)).toBe(0.7);
    const d = new LoadSpeedController();
    expect(d.window(0, W, 0.5)).toBe(0.7);
  });

  it('recovers slowly, only after calm windows in a row', () => {
    const c = new LoadSpeedController();
    c.window(12, W, 1); // 0.8
    expect(c.window(0, W, 1)).toBeCloseTo(0.8, 5);
    expect(c.window(0, W, 1)).toBeCloseTo(0.8, 5);
    expect(c.window(0, W, 1)).toBeCloseTo(0.85, 5); // third calm window: +0.05
    for (let i = 0; i < 30; i++) c.window(0, W, 1);
    expect(c.factor()).toBe(1); // and never past 1
  });

  it('holds in the dead band (no hunting)', () => {
    const c = new LoadSpeedController();
    c.window(12, W, 1); // 0.8
    // 2 % late: neither slow (> 5 %) nor calm (< 1 %): hold, and reset calm.
    for (let i = 0; i < 10; i++) expect(c.window(1.2, W, 1)).toBeCloseTo(0.8, 5);
  });

  it('the cost signal caps the factor (the slower of the two wins)', () => {
    const c = new LoadSpeedController();
    expect(c.window(0, W, 0.9)).toBeCloseTo(0.9, 5);
    expect(c.window(12, W, 0.9)).toBeCloseTo(0.8, 5);
  });

  it('converges under a fixed overload instead of spiralling to the floor', () => {
    // A host that can run 48 ticks per wall second: at speed f, real time asks
    // 60·f; lateness = max(0, 60·f − 48).
    const c = new LoadSpeedController();
    let f = 1;
    for (let i = 0; i < 30; i++) {
      const asked = 60 * f;
      f = c.window(Math.max(0, asked - 48), asked, 1);
    }
    expect(f).toBeGreaterThan(0.7);
    expect(f).toBeLessThanOrEqual(0.85);
    expect(f).toBeGreaterThanOrEqual(0.75);
  });
});
