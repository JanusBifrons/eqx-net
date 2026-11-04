/**
 * Invariant #14: the per-frame Machined light update allocates nothing.
 * Run via `pnpm test:gc` (needs `--expose-gc`).
 */
import { describe, it, expect } from 'vitest';
import { applySunBlend } from './machinedShipLight.js';
import { decideArtSwap } from '../spriteUpdateDecisions.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

describe('Machined light update heap-delta', () => {
  it('1 000 000 per-ship updates grow the heap < 200 KB', () => {
    const frames = Array.from({ length: 16 }, (_, i) => ({ id: i }));
    const layers = { a: { texture: frames[0]! }, b: { texture: frames[1]!, alpha: 0 } };
    for (let i = 0; i < 10_000; i++) { applySunBlend(layers, frames, -0.6, i * 0.001); decideArtSwap(true, 'ready', true); }
    const before = postGcHeap();
    let swaps = 0;
    for (let i = 0; i < 1_000_000; i++) {
      applySunBlend(layers, frames, -0.6, i * 0.0007);
      if (decideArtSwap(true, i % 3 === 0 ? 'pending' : 'ready', i % 2 === 0) !== 'keep') swaps++;
    }
    const grew = postGcHeap() - before;
    expect(swaps).toBeGreaterThan(0);
    expect(grew).toBeLessThan(200 * 1024);
  });
});
