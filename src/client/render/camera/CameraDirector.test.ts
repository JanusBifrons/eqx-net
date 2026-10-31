import { describe, it, expect } from 'vitest';
import {
  CameraDirector,
  FRAME_MIN_EXTENT,
  type CameraTargetLookup,
  type DirectorTarget,
  type MutableBounds,
  type MutablePoint,
} from './CameraDirector.js';
import type { CameraCue, CameraGroup } from '@core/contracts/cameraScript.js';
import { smoothDamp } from './smoothDamp.js';

/** Fake lookup over a plain pixi-space pose table. */
function makeLookup(poses: Record<string, { x: number; y: number; group?: CameraGroup }>, vw = 1000, vh = 500): CameraTargetLookup {
  const add = (b: MutableBounds, n: number, x: number, y: number): void => {
    if (n === 0) {
      b.minX = b.maxX = x;
      b.minY = b.maxY = y;
    } else {
      b.minX = Math.min(b.minX, x);
      b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y);
      b.maxY = Math.max(b.maxY, y);
    }
  };
  return {
    pose(id: string, out: MutablePoint) {
      const p = poses[id];
      if (!p) return false;
      out.x = p.x;
      out.y = p.y;
      return true;
    },
    groupBounds(g: CameraGroup, out: MutableBounds) {
      let n = 0;
      for (const p of Object.values(poses)) {
        if (g !== 'all' && p.group !== g) continue;
        add(out, n++, p.x, p.y);
      }
      return n;
    },
    idsBounds(ids: readonly string[], out: MutableBounds) {
      let n = 0;
      for (const id of ids) {
        const p = poses[id];
        if (p) add(out, n++, p.x, p.y);
      }
      return n;
    },
    viewport(out: MutablePoint) {
      out.x = vw;
      out.y = vh;
    },
  };
}

function out(): DirectorTarget {
  return { x: 0, y: 0, zoom: 1, smoothMs: 0 };
}

describe('CameraDirector', () => {
  it('is idle until a script plays', () => {
    const d = new CameraDirector();
    expect(d.update(0, makeLookup({}), out())).toBe('idle');
  });

  it('hold converts game space (Y-up) to pixi space (Y-down)', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'hold', x: 100, y: 200, zoom: 0.5 } }], 0);
    const o = out();
    expect(d.update(10, makeLookup({}), o)).toBe('active');
    expect(o).toMatchObject({ x: 100, y: -200, zoom: 0.5, smoothMs: 450 });
  });

  it('advances cues by time and reports the active cue', () => {
    const d = new CameraDirector();
    const cues: CameraCue[] = [
      { atMs: 1000, shot: { kind: 'hold', x: 2, y: 0, zoom: 1 } },
      { atMs: 0, shot: { kind: 'hold', x: 1, y: 0, zoom: 1 }, smoothMs: 0 },
    ];
    d.play(cues, 5000);
    const o = out();
    d.update(5500, makeLookup({}), o);
    expect(o.x).toBe(1);
    expect(o.smoothMs).toBe(0);
    expect(d.currentCueIndex()).toBe(0);
    d.update(6100, makeLookup({}), o);
    expect(o.x).toBe(2);
    expect(d.currentCueIndex()).toBe(1);
  });

  it('track follows the rendered pose with offset (game-space offset Y-flipped)', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'track', target: 'swarm-7', zoom: 1.2, offsetX: 10, offsetY: 20 } }], 0);
    const o = out();
    d.update(16, makeLookup({ 'swarm-7': { x: 300, y: -40 } }), o);
    expect(o).toMatchObject({ x: 310, y: -60, zoom: 1.2 });
  });

  it('track lead looks ahead along measured velocity', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'track', target: 'a', zoom: 1, leadMs: 500 } }], 0);
    const o = out();
    const poses = { a: { x: 0, y: 0 } };
    const lookup = makeLookup(poses);
    for (let t = 0; t <= 2000; t += 16) {
      poses.a.x = t; // 1 unit / ms to the right
      d.update(t, lookup, o);
    }
    // ≈ pose + 1 u/ms × 500 ms ahead.
    expect(o.x).toBeGreaterThan(poses.a.x + 400);
    expect(o.x).toBeLessThan(poses.a.x + 600);
  });

  it('holds the last framing when the tracked subject disappears', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'track', target: 'a', zoom: 1 } }], 0);
    const o = out();
    d.update(0, makeLookup({ a: { x: 50, y: 60 } }), o);
    expect(d.update(16, makeLookup({}), o)).toBe('active');
    expect(o).toMatchObject({ x: 50, y: 60 });
  });

  it('frame fits a group bounding box, clamped by min extent and zoom range', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'frame', group: 'drones', padding: 0 } }], 0);
    const o = out();
    const lookup = makeLookup({
      a: { x: -1000, y: 0, group: 'drones' },
      b: { x: 1000, y: 100, group: 'drones' },
      c: { x: 99999, y: 0, group: 'asteroids' },
    });
    d.update(0, lookup, o);
    expect(o.x).toBe(0);
    expect(o.y).toBe(50);
    // width 2000 → 1000/2000 = 0.5; height max(400,100)=400 → 500/400 = 1.25 → min = 0.5.
    expect(o.zoom).toBeCloseTo(0.5, 6);

    const single = new CameraDirector();
    single.play([{ atMs: 0, shot: { kind: 'frame', ids: ['a'], padding: 0, maxZoom: 10 } }], 0);
    single.update(0, lookup, o);
    expect(o.zoom).toBeCloseTo(500 / FRAME_MIN_EXTENT, 6);
  });

  it('path interpolates keys with geometric zoom and holds the last key', () => {
    const d = new CameraDirector();
    d.play(
      [{ atMs: 0, shot: { kind: 'path', easing: 'linear', keys: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 1000, x: 100, y: 100, zoom: 0.25 }] } }],
      0,
    );
    const o = out();
    d.update(500, makeLookup({}), o);
    expect(o.x).toBeCloseTo(50, 6);
    expect(o.y).toBeCloseTo(-50, 6);
    expect(o.zoom).toBeCloseTo(0.5, 6);
    d.update(5000, makeLookup({}), o);
    expect(o).toMatchObject({ x: 100, y: -100, zoom: 0.25 });
  });

  it('orbit circles the point at the given radius', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'orbit', x: 0, y: 0, radius: 100, periodMs: 4000, zoom: 1 } }], 0);
    const o = out();
    d.update(1000, makeLookup({}), o);
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(100, 6);
  });

  it('release stops the director and reports released', () => {
    const d = new CameraDirector();
    d.play([{ atMs: 0, shot: { kind: 'hold', x: 0, y: 0, zoom: 1 } }, { atMs: 100, shot: { kind: 'release' } }], 0);
    const o = out();
    expect(d.update(50, makeLookup({}), o)).toBe('active');
    expect(d.update(150, makeLookup({}), o)).toBe('released');
    expect(d.isActive()).toBe(false);
  });
});

describe('smoothDamp', () => {
  it('reaches the target without overshoot', () => {
    const st = { v: 0 };
    let x = 0;
    for (let i = 0; i < 200; i++) {
      x = smoothDamp(x, 10, st, 200, 16);
      expect(x).toBeLessThanOrEqual(10);
    }
    expect(x).toBeCloseTo(10, 3);
  });

  it('smoothTime 0 snaps', () => {
    expect(smoothDamp(0, 7, { v: 3 }, 0, 16)).toBe(7);
  });
});
