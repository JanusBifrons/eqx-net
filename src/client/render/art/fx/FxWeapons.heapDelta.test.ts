/**
 * Invariant #14: drawing the new weapon effects allocates nothing per frame
 * once the pools are warm. Run via `pnpm test:gc` (needs `--expose-gc`).
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import type { BeamView } from '../../BeamSpritePool.js';
import { FxBeams, FxProjectiles } from './FxWeapons.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

const art = { fx: (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null, fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } }) } as unknown as ArtService;

describe('weapon effects heap-delta', () => {
  it('100 000 frames of 6 projectiles + 3 beams grow the heap < 300 KB', () => {
    const p = new FxProjectiles(art);
    const b = new FxBeams(art, 0x6fd0ff);
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
    const views: BeamView[] = [0, 1, 2].map((i) => ({ fromX: 0, fromY: i * 10, toX: 200, toY: i * 10, solidLen: 120 }));
    const frame = (f: number): void => {
      p.beginFrame();
      for (let i = 0; i < ids.length; i++) p.draw(ids[i]!, i % 2 ? 'bolt' : 'tracer', f % 500, i * 7, 300, 40, 1);
      p.endFrame();
      views[0]!.toX = 150 + (f % 100);
      b.setBeams(views, 1 + (f % 3), f * 16);
    };
    for (let f = 0; f < 2000; f++) frame(f);
    const before = postGcHeap();
    for (let f = 0; f < 100_000; f++) frame(f);
    const grew = postGcHeap() - before;
    expect(p.liveCount()).toBe(6);
    expect(grew).toBeLessThan(300 * 1024);
  });
});
