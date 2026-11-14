/**
 * Heap-delta lock (invariant #14) for `shipHullDistance` / `shipWithinHullReach`:
 * they run per turret per candidate per tick in the fire gates.
 * Run with `pnpm test:gc`.
 */
import { describe, expect, it } from 'vitest';
import { shipHullDistance, shipWithinHullReach } from '../../src/core/combat/shipHitShape.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`.');
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('shipHullDistance heap-delta', () => {
  it('does not grow the heap', () => {
    let sink = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++) {
        sink += shipHullDistance('battleship', true, i % 5000, 3000, 0, 0, i * 0.01);
        sink += shipHullDistance('fighter', (i & 1) === 0, 200, i % 300, 0, 0, i * 0.02);
        if (shipWithinHullReach('battleship', false, i % 9000, 0, 0, 0, i * 0.01, 1400)) sink++;
      }
    };
    run(2000);
    const before = postGcHeap();
    run(50_000);
    const after = postGcHeap();
    expect(after - before).toBeLessThan(200_000);
    expect(Number.isFinite(sink)).toBe(true);
  });
});
