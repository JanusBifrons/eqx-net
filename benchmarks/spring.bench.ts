/**
 * Stage 1 (network-feel roadmap) — CritDampedSpring step cost.
 *
 * Run: pnpm bench
 *
 * Acceptance criterion: a single `springStep` call completes in well under
 * 200 ns. The renderer calls this per visible spring (local + up to 32
 * remote ships, 3 axes each = ~100 calls/frame); at 200 ns/call that's
 * ~20 µs/frame in the worst case — negligible against a 16.67 ms budget.
 *
 * The closed-form analytical step is `Math.exp` + a handful of floating-
 * point ops, so the cost is dominated by the libm `exp` implementation.
 */
import { bench, describe } from 'vitest';
import { springStep, type SpringState } from '../src/core/math/CritDampedSpring.js';

describe('CritDampedSpring step cost', () => {
  bench('springStep — single call', () => {
    const s: SpringState = { x: 100, v: 0 };
    springStep(s, 0, 25, 16.67);
  });

  bench('springStep — converging from 100u over 200 frames @ 16 ms', () => {
    const s: SpringState = { x: 100, v: 0 };
    for (let i = 0; i < 200; i++) {
      springStep(s, 0, 25, 16);
    }
  });

  bench('springStep — 100 parallel springs (local + 32 remote × 3 axes)', () => {
    const springs: SpringState[] = [];
    for (let i = 0; i < 100; i++) springs.push({ x: 50 + i, v: 0 });
    for (const s of springs) {
      springStep(s, 0, 25, 16.67);
    }
  });
});
