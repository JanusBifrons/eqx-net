/**
 * Owner decision 2026-11-12 — "You can't zoom in past the point where your
 * whole hull fits on screen. A battleship's closest zoom becomes about 1/18 of
 * a fighter's; fighters keep today's zoom."
 *
 * The report: flying a battleship zoomed in, the stern and engines slid off
 * the screen. The follow camera has no look-ahead (it centres the ship's
 * origin and the hull is balanced fore/aft), so the cause was the flat
 * zoom-in cap of 3 for every hull: a battleship (radius ~2,876 u) overflows a
 * 1080-px-tall view at any zoom above ~0.18. The zoom-in cap now follows the
 * ship you fly (`zoomCeilingForView`), recomputed on a ship change and on
 * every resize.
 */
import { describe, it, expect } from 'vitest';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import {
  GAMEPLAY_MAX_ZOOM,
  HULL_VIEW_MARGIN,
  zoomCeilingForView,
  zoomRangeForKind,
} from '../../src/shared-types/shipScale/tuning.js';
import { Camera, type CameraTarget } from '../../src/client/render/worker/Camera.js';

const BASE = 0.6;
const VIEWS = [
  { name: '1920x1080', w: 1920, h: 1080 },
  { name: '1280x720', w: 1280, h: 720 },
  { name: 'phone portrait 390x844', w: 390, h: 844 },
  { name: 'phone landscape 844x390', w: 844, h: 390 },
];
const CAPITALS = ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship'];

function range(id: string, w: number, h: number, mode: 'real' | 'legacy' = 'legacy') {
  return zoomRangeForKind(getShipKind(id), BASE, { minScale: 0, startZoom: 0, maxScale: 0 }, mode, w, h);
}

describe('zoom-in cap: the whole hull always fits on screen', () => {
  it('a battleship at its closest zoom fits its hull (plus margin) in the short side of the view', () => {
    for (const vp of VIEWS) {
      const bs = getShipKind('battleship');
      const max = range('battleship', vp.w, vp.h).maxScale;
      // Hull diameter (with the 5 % margin) in screen px at the closest zoom.
      expect(2 * bs.radius * HULL_VIEW_MARGIN * max, vp.name).toBeLessThanOrEqual(Math.min(vp.w, vp.h) + 1e-6);
    }
  });

  it("a battleship's closest zoom is about 1/18 of a fighter's at 1920x1080", () => {
    const ratio = range('fighter', 1920, 1080).maxScale / range('battleship', 1920, 1080).maxScale;
    expect(ratio).toBeGreaterThan(15);
    expect(ratio).toBeLessThan(20);
  });

  it('fighters (and every small hull) keep today\'s cap of 3 at normal viewports', () => {
    for (const id of ['fighter', 'scout', 'heavy', 'interceptor', 'gunship']) {
      for (const vp of VIEWS) expect(range(id, vp.w, vp.h).maxScale, `${id} ${vp.name}`).toBe(3);
    }
    expect(GAMEPLAY_MAX_ZOOM).toBe(3);
  });

  it('no view size ⇒ the ordinary cap (the viewport-free reference)', () => {
    expect(zoomCeilingForView(getShipKind('battleship'), 0, 0, 0.01)).toBe(GAMEPLAY_MAX_ZOOM);
  });

  it('the cap never falls below the zoom-out floor, and the start zoom never exceeds the cap', () => {
    for (const id of CAPITALS) {
      for (const vp of VIEWS) {
        for (const mode of ['real', 'legacy'] as const) {
          const r = range(id, vp.w, vp.h, mode);
          expect(r.maxScale, `${id} ${vp.name} ${mode}`).toBeGreaterThanOrEqual(r.minScale);
          expect(r.startZoom, `${id} ${vp.name} ${mode}`).toBeLessThanOrEqual(r.maxScale);
        }
      }
    }
  });

  it('a start zoom above the cap starts at the cap (battleship on a phone)', () => {
    const noView = range('battleship', 0, 0);
    const phone = range('battleship', 390, 844);
    expect(noView.startZoom).toBeGreaterThan(phone.maxScale);
    expect(phone.startZoom).toBe(phone.maxScale);
  });
});

function makeTarget(scale = 1): CameraTarget {
  return { x: 0, y: 0, scale: { x: scale, y: scale, set(s: number) { this.x = s; this.y = s; } } };
}

describe('Camera.setMaxScale', () => {
  it('eases the current zoom down to a lowered cap (no snap), keeping the followed ship centred', () => {
    const t = makeTarget();
    const cam = new Camera(t, { minScale: 0.01, maxScale: 3 });
    cam.setScreenSize(1920, 1080);
    cam.follow({ x: 500, y: -300 });
    cam.setZoom(2);
    cam.tick(16);
    cam.setMaxScale(0.18);
    // Unchanged until the camera ticks (the change is eased, not snapped).
    expect(t.scale.x).toBe(2);
    cam.tick(16);
    expect(t.scale.x).toBeLessThan(2);
    expect(t.scale.x).toBeGreaterThan(0.18);
    for (let i = 0; i < 120; i++) cam.tick(16);
    expect(t.scale.x).toBeCloseTo(0.18, 6);
    const c = cam.center;
    expect(c.x).toBeCloseTo(500, 3);
    expect(c.y).toBeCloseTo(-300, 3);
  });

  it('wheel and pinch cannot zoom past the cap', () => {
    const t = makeTarget(0.1);
    const cam = new Camera(t, { minScale: 0.01, maxScale: 3 });
    cam.setScreenSize(1920, 1080);
    cam.setMaxScale(0.18);
    for (let i = 0; i < 40; i++) cam.onWheel(-100, 960, 540);
    for (let i = 0; i < 120; i++) cam.tick(16);
    expect(t.scale.x).toBeCloseTo(0.18, 6);
    cam.setZoom(5);
    expect(t.scale.x).toBeCloseTo(0.18, 6);
  });

  it('a raised cap leaves the current zoom alone', () => {
    const t = makeTarget();
    const cam = new Camera(t, { minScale: 0.01, maxScale: 3 });
    cam.setScreenSize(1920, 1080);
    cam.setZoom(0.1);
    cam.setMaxScale(3);
    cam.tick(16);
    expect(t.scale.x).toBeCloseTo(0.1, 9);
  });

  it('the cinematic director keeps the original zoom-in limit', () => {
    const t = makeTarget(0.1);
    const cam = new Camera(t, { minScale: 0.01, maxScale: 3 });
    cam.setScreenSize(1920, 1080);
    cam.setMaxScale(0.18);
    cam.setDirectorTarget(0, 0, 2, 0);
    cam.tick(16);
    expect(t.scale.x).toBeCloseTo(2, 6);
  });
});
