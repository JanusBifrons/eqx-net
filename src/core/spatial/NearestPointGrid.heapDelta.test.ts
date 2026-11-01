/**
 * Invariant #14 lock: the turret target grid is rebuilt every turret tick and
 * queried per turret — steady-state rebuild + query must not allocate.
 * Run via `pnpm test:gc`.
 */
import { describe, expect, it } from 'vitest';
import { NearestPointGrid } from './NearestPointGrid.js';

function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('run via pnpm test:gc (--expose-gc)');
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('NearestPointGrid — zero allocation', () => {
  it('10k rebuild+query cycles do not grow the heap', () => {
    const g = new NearestPointGrid(512, 10_000, 2048);
    let sink = 0;
    const cycle = (n: number): void => {
      for (let t = 0; t < n; t++) {
        g.reset();
        for (let i = 0; i < 600; i++) g.add(((i * 7919 + t) % 20_000) - 10_000, ((i * 104_729) % 20_000) - 10_000);
        g.build();
        for (let q = 0; q < 40; q++) sink += g.nearest((q * 331) % 8000 - 4000, (q * 577) % 8000 - 4000, 900);
      }
    };
    cycle(500); // warm the JIT + reach steady capacity
    const before = heapUsed();
    cycle(10_000);
    const after = heapUsed();
    expect(sink).not.toBeNaN();
    expect(after - before).toBeLessThan(256 * 1024);
  });
});
