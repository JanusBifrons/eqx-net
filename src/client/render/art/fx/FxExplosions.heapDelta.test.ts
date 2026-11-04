/**
 * Invariant #14: explosions and missile smoke allocate nothing per frame once
 * their pools are warm. Run via `pnpm test:gc` (needs `--expose-gc`).
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxExplosions, FxMissileTrails } from './FxExplosions.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

const art = { fx: (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
  fx: { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } }) } as unknown as ArtService;

describe('explosions heap-delta', () => {
  it('50 000 frames with a blast every 40 frames and 4 missiles grow the heap < 300 KB', () => {
    const ex = new FxExplosions(art, () => 'high');
    const tr = new FxMissileTrails(art);
    const frame = (f: number): void => {
      const now = f * 16;
      if (f % 40 === 0) ex.spawn(f % 300, 0, 40 + (f % 200), now);
      ex.tick(now);
      tr.beginFrame();
      for (let m = 0; m < 4; m++) tr.draw(m + (f % 800 < 400 ? 0 : 10), (f * 3) % 900, m * 20, 0.3, now);
      tr.endFrame();
    };
    for (let f = 0; f < 3000; f++) frame(f);
    const before = postGcHeap();
    for (let f = 0; f < 50_000; f++) frame(f);
    const grew = postGcHeap() - before;
    expect(ex.activeCount()).toBeGreaterThan(0);
    expect(grew).toBeLessThan(300 * 1024);
  });
});
