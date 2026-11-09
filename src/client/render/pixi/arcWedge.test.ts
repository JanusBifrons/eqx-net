import { describe, it, expect } from 'vitest';
import { arcWedgeScreenAnglesInto, arcWedgeVisualParams, isArcLimited, type ArcWedgeAngles } from './connectorVisual.js';

const DEG = Math.PI / 180;

/** The game-space fire direction at total bearing a, converted to Pixi (Y-down). */
function pixiDirOfBearing(a: number): [number, number] {
  return [-Math.sin(a), -Math.cos(a)];
}

describe('arcWedgeScreenAnglesInto (coastal placement arc)', () => {
  it('rotation 0: the wedge centre points up the screen (game +y)', () => {
    const out: ArcWedgeAngles = { start: 0, end: 0 };
    arcWedgeScreenAnglesInto(out, 0, 0, -72 * DEG, 72 * DEG);
    const mid = (out.start + out.end) / 2;
    expect(Math.cos(mid)).toBeCloseTo(0);
    expect(Math.sin(mid)).toBeCloseTo(-1);
    expect(out.end - out.start).toBeCloseTo(144 * DEG);
  });

  it('each arc edge matches the server fire direction at every placement rotation', () => {
    const out: ArcWedgeAngles = { start: 0, end: 0 };
    for (const rotDeg of [0, 90, 180, 270, 37]) {
      const rot = rotDeg * DEG;
      arcWedgeScreenAnglesInto(out, rot, 0, -60 * DEG, 60 * DEG);
      // start ↔ arcMax edge, end ↔ arcMin edge.
      const [sx, sy] = pixiDirOfBearing(rot + 60 * DEG);
      const [ex, ey] = pixiDirOfBearing(rot - 60 * DEG);
      expect(Math.cos(out.start)).toBeCloseTo(sx);
      expect(Math.sin(out.start)).toBeCloseTo(sy);
      expect(Math.cos(out.end)).toBeCloseTo(ex);
      expect(Math.sin(out.end)).toBeCloseTo(ey);
    }
  });

  it('writes into out and returns it (no alloc)', () => {
    const out: ArcWedgeAngles = { start: 0, end: 0 };
    expect(arcWedgeScreenAnglesInto(out, 0, 0, -1, 1)).toBe(out);
  });

  it('only arc-limited mounts get a wedge', () => {
    expect(isArcLimited(-Math.PI, Math.PI)).toBe(false);
    expect(isArcLimited(-60 * DEG, 60 * DEG)).toBe(true);
  });

  it('visual params are faint with a ~1 screen-px edge', () => {
    const v = arcWedgeVisualParams(0.5);
    expect(v.fillAlpha).toBeLessThan(0.15);
    expect(v.width).toBe(2);
    expect(arcWedgeVisualParams(0).width).toBe(1);
  });
});
