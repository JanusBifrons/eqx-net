/**
 * Camera speed zoom heap-delta lock (plan iridescent-seeking-rainbow v5, C3,
 * invariant #14): following a ship while the speed factor changes every tick
 * must not allocate.
 */
import { describe, it, expect } from 'vitest';
import { Camera, type CameraTarget } from './Camera.js';

function postGcHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`');
  gc(); gc();
  return process.memoryUsage().heapUsed;
}

describe('camera speed zoom heap-delta', () => {
  it('100 000 ticks of follow + a changing speed factor grow the heap < 100 KB', () => {
    const target: CameraTarget = { x: 0, y: 0, scale: { x: 1, y: 1, set(s: number) { this.x = s; this.y = s; } } };
    const cam = new Camera(target, { minScale: 0.15, maxScale: 3, followLerpFactor: 1 });
    cam.setScreenSize(1280, 720);
    const ship = { x: 0, y: 0 };
    cam.follow(ship);
    const frame = (f: number): void => {
      ship.x += 12; ship.y = Math.sin(f * 0.01) * 500;
      cam.setSpeedZoom(0.8 + 0.2 * Math.abs(Math.sin(f * 0.003)));
      cam.tick(16.67);
    };
    for (let f = 0; f < 5000; f++) frame(f);
    const before = postGcHeap();
    for (let f = 0; f < 100_000; f++) frame(f);
    expect(postGcHeap() - before).toBeLessThan(100 * 1024);
  });
});
