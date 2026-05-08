import { describe, it, expect } from 'vitest';
import { springStep, type SpringState } from './CritDampedSpring.js';

describe('CritDampedSpring', () => {
  it('Cycle 1: converges within 1% of target after 5 × halfLife', () => {
    // Standard convergence test. With halfLifeMs = 100, after 500 ms (=5
    // half-lives) the analytical closed-form gives |offset| ≈ 0.2% of
    // initial — well under the 1% bound.
    const s: SpringState = { x: 100, v: 0 };
    const target = 0;
    const halfLifeMs = 100;
    const dtMs = 16; // typical 60 Hz frame
    let elapsedMs = 0;
    while (elapsedMs < 500) {
      springStep(s, target, halfLifeMs, dtMs);
      elapsedMs += dtMs;
    }
    expect(Math.abs(s.x)).toBeLessThan(1);
  });

  it('Cycle 2: no overshoot under critical damping (v₀ = 0)', () => {
    // For critically damped spring with zero initial velocity, the
    // approach to target is strictly monotonic — never crosses past
    // the target. Under-damped systems would ring and cross zero.
    const s: SpringState = { x: 100, v: 0 };
    const target = 0;
    const halfLifeMs = 50;
    const dtMs = 4;
    let prev = s.x;
    for (let t = 0; t < 1000; t += dtMs) {
      springStep(s, target, halfLifeMs, dtMs);
      // Initial offset is positive; should stay non-negative throughout
      // and decrease (or stay equal) every step.
      expect(s.x).toBeGreaterThanOrEqual(-1e-9);
      expect(s.x).toBeLessThanOrEqual(prev + 1e-9);
      prev = s.x;
    }
  });

  it('Cycle 3: frame-rate independence — dt = 8 ms vs dt = 33 ms produce identical end state within 1%', () => {
    // The analytical closed-form is exact regardless of dt; this
    // protects against ProMotion 120 Hz → 60 Hz transitions where
    // a frame-rate-coupled integrator would visibly jitter.
    const totalMs = 240; // multiple of both 8 and 33 (ish)
    const halfLifeMs = 60;
    const initial = 100;

    function runAtCadence(dtMs: number): number {
      const s: SpringState = { x: initial, v: 0 };
      let elapsed = 0;
      while (elapsed + dtMs <= totalMs) {
        springStep(s, 0, halfLifeMs, dtMs);
        elapsed += dtMs;
      }
      // Catch the residual to the same total wall-clock if dtMs doesn't
      // divide evenly, so both branches integrate the *same* total time.
      const remainder = totalMs - elapsed;
      if (remainder > 0) springStep(s, 0, halfLifeMs, remainder);
      return s.x;
    }

    const fastCadence = runAtCadence(8);
    const slowCadence = runAtCadence(33);
    // Both run the spring for `totalMs` ms total; the analytical step is
    // exact so the two trajectories must agree to floating-point tolerance.
    // Use 1% of initial as the bound (plan target).
    expect(Math.abs(fastCadence - slowCadence)).toBeLessThan(initial * 0.01);
  });

  it('halfLife parameter: x(halfLife) ≈ 0.5 × initial for v₀ = 0', () => {
    // The user-facing definition of halfLife: time for offset to halve
    // when starting from rest. Critical to the Reconciler's spring-shape
    // assertion in Stage 1 Cycle 4.
    const initial = 100;
    const halfLifeMs = 80;
    const s: SpringState = { x: initial, v: 0 };
    // Step in small slices to halfLifeMs precisely.
    const dtMs = 0.5;
    let elapsed = 0;
    while (elapsed + dtMs <= halfLifeMs) {
      springStep(s, 0, halfLifeMs, dtMs);
      elapsed += dtMs;
    }
    // x at t = halfLife should be ~50% of initial.
    expect(s.x).toBeCloseTo(initial * 0.5, 1);
  });
});
