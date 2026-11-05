/**
 * FxEngines heap-delta lock (invariant #14): 24 ships flying and turning for
 * 20 000 frames, joining and leaving, must not allocate per frame.
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxEngines, type Nozzle } from './FxEngines.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

const art = {
  fx: (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } }),
} as unknown as ArtService;

describe('FxEngines heap-delta', () => {
  it('20 000 frames of 24 ships grow the heap < 200 KB', () => {
    const fx = new FxEngines(art);
    const hulls: Nozzle[][] = [[{ x: 0, y: 8, r: 2 }], [{ x: -4, y: 10, r: 2 }, { x: 4, y: 10, r: 2 }]];
    const keys: string[] = [];
    for (let i = 0; i < 24; i++) keys.push(`s${i}`);
    const frame = (f: number): void => {
      fx.beginFrame();
      for (let i = 0; i < 24; i++) {
        if ((f + i * 37) % 900 < 60) continue; // ships come and go
        const a = f * 0.01 + i;
        fx.draw(keys[i]!, hulls[i % 2]!, Math.cos(a) * 3000, Math.sin(a) * 3000, a + Math.PI, i % 3 === 0 ? -1 : 1, (f >> 7) & 1 ? 1 : 0, 800, 1 / 60, f * 16.7);
      }
      fx.endFrame();
    };
    for (let f = 0; f < 2000; f++) frame(f);
    const before = postGcHeap();
    for (let f = 2000; f < 22_000; f++) frame(f);
    expect(postGcHeap() - before).toBeLessThan(200 * 1024);
  });
});
