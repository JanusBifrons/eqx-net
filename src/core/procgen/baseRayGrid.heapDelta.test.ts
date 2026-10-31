/**
 * Invariant #14 lock: `BaseRayGrid.rayFirst` runs inside every server weapon
 * resolve (beams, projectiles) — it must not allocate. Run via `pnpm test:gc`.
 */
import { describe, expect, it } from 'vitest';
import { generateBase } from './generateBase.js';
import { BASE_GENERATOR_VERSION } from './baseLayout.js';
import { BaseRayGrid } from './baseRayGrid.js';

function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('run via pnpm test:gc (--expose-gc)');
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('BaseRayGrid.rayFirst — zero allocation', () => {
  it('100k queries do not grow the heap', () => {
    const l = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 42, x: 0, y: 0, size: 8000 });
    const g = new BaseRayGrid();
    g.build(l);
    let sink = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const a = (i % 360) * (Math.PI / 180);
        sink += g.rayFirst(-l.half - 50 + (i % 97) * 40, (i % 53) * 30 - 800, Math.cos(a), Math.sin(a), 6000);
      }
    };
    run(10_000); // warm the JIT
    const before = heapUsed();
    run(100_000);
    const after = heapUsed();
    expect(sink).not.toBeNaN();
    // A per-query allocation of even 16 B would be ≥ 1.6 MB here.
    expect(after - before).toBeLessThan(256 * 1024);
  });
});
