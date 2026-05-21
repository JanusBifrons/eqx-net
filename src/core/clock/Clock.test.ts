/**
 * Lock for the Clock injection seam (plan: replay infra Phase B).
 *
 * Purpose: prevent regression of the production-default behaviour AND
 * lock the MockClock contract that tests/replay/ depends on.
 */
import { describe, it, expect } from 'vitest';
import { REAL_CLOCK, MockClock, type Clock } from './Clock.js';

describe('Clock', () => {
  it('REAL_CLOCK.now() returns a finite number close to performance.now()', () => {
    const a = REAL_CLOCK.now();
    const b = performance.now();
    // Both should be within 5 ms; we don't assert equality (calls aren't simultaneous).
    expect(Number.isFinite(a)).toBe(true);
    expect(Math.abs(a - b)).toBeLessThan(5);
  });

  it('REAL_CLOCK.now() advances monotonically', () => {
    const a = REAL_CLOCK.now();
    // Spin-wait briefly so the second sample is strictly later.
    let n = 0;
    while (REAL_CLOCK.now() === a && n < 1_000_000) n++;
    const b = REAL_CLOCK.now();
    expect(b).toBeGreaterThan(a);
  });
});

describe('MockClock', () => {
  it('starts at 0 by default', () => {
    const c = new MockClock();
    expect(c.now()).toBe(0);
  });

  it('starts at the provided initial value', () => {
    const c = new MockClock(1234);
    expect(c.now()).toBe(1234);
  });

  it('advance(ms) moves the clock forward by exactly that amount', () => {
    const c = new MockClock(100);
    c.advance(50);
    expect(c.now()).toBe(150);
    c.advance(0.5);
    expect(c.now()).toBe(150.5);
  });

  it('set(ms) jumps the clock to an absolute value', () => {
    const c = new MockClock(100);
    c.set(5000);
    expect(c.now()).toBe(5000);
  });

  it('satisfies the Clock interface (compile-time + structural)', () => {
    const c: Clock = new MockClock();
    expect(typeof c.now()).toBe('number');
  });

  it('multiple advances accumulate deterministically (replay-loop pattern)', () => {
    const c = new MockClock();
    for (let i = 0; i < 60; i++) c.advance(1000 / 60);
    expect(c.now()).toBeCloseTo(1000, 5); // 60 frames at 60 Hz = 1 second
  });
});
