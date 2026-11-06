/**
 * Capital-ship R&D round 3 D — the zoom range follows the ship you fly.
 * A fighter's range is unchanged; a capital pilot can pull back far enough
 * to see the hull and several kilometres around it.
 */
import { describe, it, expect } from 'vitest';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import {
  GAMEPLAY_MIN_ZOOM,
  HULL_ZOOM_REF_RADIUS,
  hullZoomFactor,
  startZoomForScale,
  zoomRangeForKind,
} from '../../src/shared-types/shipScale/tuning.js';
import { Camera, type CameraTarget } from '../../src/client/render/worker/Camera.js';

const BASE = 0.5;

describe('zoom range follows the hull', () => {
  it('every non-capital keeps the ordinary range', () => {
    for (const id of ['fighter', 'scout', 'heavy', 'gunship', 'missile-frigate', 'crossguard', 'trader-hauler', 'robot-nexus']) {
      const k = getShipKind(id);
      expect(k.radius).toBeLessThanOrEqual(HULL_ZOOM_REF_RADIUS);
      expect(hullZoomFactor(k)).toBe(1);
      const r = zoomRangeForKind(k, BASE, { minScale: 0, startZoom: 0 });
      expect(r.minScale).toBe(GAMEPLAY_MIN_ZOOM);
      expect(r.startZoom).toBe(startZoomForScale(BASE));
    }
  });

  it('capitals widen the range in proportion to the hull, biggest widest', () => {
    const out = { minScale: 0, startZoom: 0 };
    let prevMin = GAMEPLAY_MIN_ZOOM;
    for (const id of ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship']) {
      const k = getShipKind(id);
      zoomRangeForKind(k, BASE, out);
      expect(out.minScale).toBeLessThan(prevMin);
      prevMin = out.minScale;
      // At the floor, a 1000 px screen still shows at least twice the hull's length.
      expect(1000 / out.minScale).toBeGreaterThanOrEqual(4 * k.radius * 0.99);
      // At the start zoom the whole hull fits on a 1000 px screen.
      expect(2 * k.radius * out.startZoom).toBeLessThan(1000);
    }
  });

  it('Camera.setMinScale moves the zoom-out floor', () => {
    const target: CameraTarget = { x: 0, y: 0, scale: { x: 1, y: 1, set(s: number) { this.x = s; this.y = s; } } };
    const cam = new Camera(target, { minScale: GAMEPLAY_MIN_ZOOM, maxScale: 3 });
    cam.setScreenSize(800, 600);
    cam.setZoom(0.01);
    expect(target.scale.x).toBeCloseTo(GAMEPLAY_MIN_ZOOM);
    const bs = zoomRangeForKind(getShipKind('battleship'), BASE, { minScale: 0, startZoom: 0 });
    cam.setMinScale(bs.minScale);
    cam.setZoom(0.01);
    expect(target.scale.x).toBeCloseTo(bs.minScale);
  });
});
