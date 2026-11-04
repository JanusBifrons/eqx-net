/**
 * Invariant #14: the new shields and fences allocate nothing per frame once
 * warm. Run via `pnpm test:gc` (needs `--expose-gc`).
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxFences, FxShields, type ShieldPoseFn } from './FxShields.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

const art = { fx: (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
  fx: { tex: Texture.WHITE, frames: Array.from({ length: 12 }, () => Texture.WHITE), w: 1, h: 1 } }) } as unknown as ArtService;
const pose: ShieldPoseFn = (_id, out) => { out.x = 10; out.y = 20; return true; };

describe('shields + fences heap-delta', () => {
  it('50 000 frames of 4 shields under fire and 6 fences grow the heap < 300 KB', () => {
    const s = new FxShields(art);
    const f = new FxFences(art);
    const ids = ['a', 'b', 'c', 'd'];
    const frame = (n: number): void => {
      const now = n * 16;
      s.begin();
      if (n % 7 === 0) s.hitAt(ids[n % 4]!, 50, 20, now, pose);
      s.beam('a', 1, 60, 20, pose); s.beam('b', 2, -40, 20, pose);
      for (const id of ids) s.shield(id, 40);
      s.end(now, pose);
      f.begin();
      for (let w = 0; w < 6; w++) f.wall(w, 0, w * 30, 300, w * 30, ((n >> 6) + w) % 3 !== 0, w === 5 && (n >> 7) % 2 === 0, now);
      f.end(now);
    };
    for (let n = 0; n < 3000; n++) frame(n);
    const before = postGcHeap();
    for (let n = 0; n < 50_000; n++) frame(n);
    const grew = postGcHeap() - before;
    expect(s.count()).toBe(4);
    expect(grew).toBeLessThan(300 * 1024);
  });
});
