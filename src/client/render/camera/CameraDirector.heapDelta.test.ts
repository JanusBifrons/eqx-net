/**
 * Heap-delta lock for the cinematic camera hot path (invariant #14):
 * `CameraDirector.update` + `Camera.tick` while directed run every frame and
 * must not allocate. Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import {
  CameraDirector,
  type CameraTargetLookup,
  type DirectorTarget,
  type MutableBounds,
  type MutablePoint,
} from './CameraDirector.js';
import { Camera, type CameraTarget } from '../worker/Camera.js';
import type { CameraCue } from '@core/contracts/cameraScript.js';

function heapAfterGc(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('global.gc not available — run via `pnpm test:gc`.');
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

// Alloc-free fake lookup over fixed numeric poses.
const POSES = [
  [0, 0],
  [500, -200],
  [-300, 400],
] as const;
const lookup: CameraTargetLookup = {
  pose(_id: string, out: MutablePoint) {
    out.x = POSES[1][0];
    out.y = POSES[1][1];
    return true;
  },
  groupBounds(_g, out: MutableBounds) {
    out.minX = -300;
    out.maxX = 500;
    out.minY = -200;
    out.maxY = 400;
    return POSES.length;
  },
  idsBounds(_ids, out: MutableBounds) {
    return this.groupBounds('all', out);
  },
  viewport(out: MutablePoint) {
    out.x = 1920;
    out.y = 1080;
  },
};

describe('CameraDirector heap-delta', () => {
  it('update + directed Camera.tick allocate nothing per frame', () => {
    const target: CameraTarget = {
      x: 0,
      y: 0,
      scale: { x: 1, y: 1, set(s: number) { this.x = s; this.y = s; } },
    };
    const cam = new Camera(target, { minScale: 0.15, maxScale: 3 });
    cam.setScreenSize(1920, 1080);
    const d = new CameraDirector();
    const out: DirectorTarget = { x: 0, y: 0, zoom: 1, smoothMs: 0 };
    const cues: CameraCue[] = [
      { atMs: 0, shot: { kind: 'track', target: 'a', zoom: 0.8, leadMs: 300 } },
      { atMs: 20_000, shot: { kind: 'frame', group: 'drones' } },
      { atMs: 40_000, shot: { kind: 'path', keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 10_000, x: 100, y: 100, zoom: 0.5 }] } },
      { atMs: 60_000, shot: { kind: 'orbit', x: 0, y: 0, radius: 300, periodMs: 8000, zoom: 0.6 } },
    ];
    d.play(cues, 0);

    const run = (from: number, frames: number): void => {
      for (let i = 0; i < frames; i++) {
        const t = from + i * 16.67;
        if (d.update(t, lookup, out) === 'active') cam.setDirectorTarget(out.x, out.y, out.zoom, out.smoothMs);
        cam.tick(16.67);
      }
    };
    run(0, 500); // warm-up (JIT, first-time shapes)
    const before = heapAfterGc();
    run(500 * 16.67, 4800); // ~80 s of frames, crosses every cue type
    const after = heapAfterGc();
    // 4800 frames × even one 32-byte object would be ~150 KB.
    expect(after - before).toBeLessThan(64 * 1024);
  });
});
