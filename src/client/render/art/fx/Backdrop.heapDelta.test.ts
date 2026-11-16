/**
 * Invariant #14: laying out the round 2 backdrop allocates nothing per frame.
 * Run via `pnpm test:gc` (needs `--expose-gc`).
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { DEFAULT_RIG } from '../shade.js';
import { Backdrop } from './Backdrop.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

const art = { fx: (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: DEFAULT_RIG, state: 'ready', ship: null, struct: null,
  fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } }), lightRig: DEFAULT_RIG } as unknown as ArtService;

describe('backdrop heap-delta', () => {
  it('50 000 frames of flying across a sector grow the heap < 200 KB', () => {
    const b = new Backdrop(art, () => 'high');
    b.setSector('cygnus-arm'); // a nebula sector (core/galaxy/nebulaField)
    const cam = { center: { x: 0, y: 0 }, scale: { x: 1 }, screenWidth: 1280, screenHeight: 720 };
    const frame = (f: number): void => {
      cam.center.x = ((f * 40) % 360_000) - 180_000; // deep core out to the thin edge
      cam.center.y = Math.sin(f * 0.001) * 150_000;
      cam.scale.x = 0.5 + (f % 200) / 100;
      b.update(cam, f * 16);
      if (b.density > 0) inNebula++;
    };
    let inNebula = 0;
    for (let f = 0; f < 3000; f++) frame(f);
    const before = postGcHeap();
    for (let f = 0; f < 50_000; f++) frame(f);
    expect(postGcHeap() - before).toBeLessThan(200 * 1024);
    // The run must fly through the nebula, so its drawing path is covered.
    expect(inNebula).toBeGreaterThan(1000);
  });
  it('the dense-nebula look (?neblook=) allocates nothing per frame either', () => {
    for (const look of ['fog:1', 'rainbow:2', 'storm:3', 'blend:5']) {
      const b = new Backdrop(art, () => 'high', 'large', look);
      b.setSector('emerald-span');
      const cam = { center: { x: 0, y: 0 }, scale: { x: 1 }, screenWidth: 1280, screenHeight: 720 };
      const frame = (f: number): void => {
        cam.center.x = ((f * 12) % 60_000) - 30_000;
        cam.center.y = Math.sin(f * 0.001) * 20_000;
        cam.scale.x = 0.5 + (f % 200) / 100;
        b.update(cam, f * 16);
      };
      for (let f = 0; f < 3000; f++) frame(f);
      const before = postGcHeap();
      for (let f = 0; f < 20_000; f++) frame(f);
      expect(postGcHeap() - before, look).toBeLessThan(200 * 1024);
      expect(b.density).toBe(1);
    }
  });
});
