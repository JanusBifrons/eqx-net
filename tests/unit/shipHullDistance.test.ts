/**
 * Point-to-hull distance (owner 2026-11-14: weapon range is measured from the
 * turret to the nearest point of the target's TRUE hull outline, not centre
 * to centre). `shipHullDistance` measures against the same shape the hit code
 * uses (`shipHitShape`): a capital's hull polygon (`shipCollisionParts`), a
 * non-capital's shield bubble when its shield is up, its hull polygon when
 * down. `shipWithinHullReach` is the cheap gate: the bounding circle rejects
 * far targets without touching the polygon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shipCollisionParts } from '../../src/core/geometry/shipHullDecomp.js';
import {
  shipBubbleRadius,
  shipHitBound,
  shipHullDistance,
  shipRayHit,
  shipWithinHullReach,
} from '../../src/core/combat/shipHitShape.js';
import { refineRayHit } from '../../src/core/combat/capitalHits.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';

// Pass-through spy: behaviour unchanged, but we can count polygon look-ups.
vi.mock('../../src/core/geometry/shipHullDecomp.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/geometry/shipHullDecomp.js')>();
  return { ...real, shipCollisionParts: vi.fn(real.shipCollisionParts) };
});
const partsSpy = vi.mocked(shipCollisionParts);

function hullExtents(id: string): { maxY: number; maxR: number; maxX: number } {
  let maxY = -Infinity; let maxR = 0; let maxX = 0;
  for (const part of shipCollisionParts(id)) {
    for (const v of part) {
      if (v.y > maxY) maxY = v.y;
      if (Math.abs(v.x) > maxX) maxX = Math.abs(v.x);
      maxR = Math.max(maxR, Math.hypot(v.x, v.y));
    }
  }
  return { maxY, maxR, maxX };
}

describe('shipHullDistance', () => {
  const bb = getShipKind('battleship');
  const ext = hullExtents('battleship');

  it('a battleship is long: alongside its beam is far, off its bow is near', () => {
    // Battleship at the origin, angle 0: keel along y, nose +y.
    const R = bb.radius;
    // Beside the beam at one radius: the bounding circle says "touching" (0),
    // the hull is a narrow keel, so the true gap is most of a radius.
    const beam = shipHullDistance('battleship', true, R, 0, 0, 0, 0);
    expect(beam).toBeGreaterThanOrEqual(R - ext.maxX - 1e-6);
    expect(beam).toBeGreaterThan(R * 0.5);
    // 100 u past the nose tip: the gap is at most 100 u.
    const bowY = ext.maxY + 100;
    const bow = shipHullDistance('battleship', true, 0, bowY, 0, 0, 0);
    expect(bow).toBeGreaterThan(0);
    expect(bow).toBeLessThanOrEqual(100 + 1e-6);
    expect(bow).toBeGreaterThanOrEqual(bowY - ext.maxR - 1e-6);
    expect(bow).toBeLessThan(beam / 5);
  });

  it('follows the pose: a quarter turn moves the bow', () => {
    const bowY = ext.maxY + 100;
    const straight = shipHullDistance('battleship', false, 500, 700 + bowY, 500, 700, 0);
    // angle +pi/2 turns local +y to world -x.
    const turned = shipHullDistance('battleship', false, 500 - bowY, 700, 500, 700, Math.PI / 2);
    expect(turned).toBeCloseTo(straight, 6);
    // The same world point beside the turned ship's beam is far.
    expect(shipHullDistance('battleship', false, 500, 700 + bowY, 500, 700, Math.PI / 2)).toBeGreaterThan(straight * 5);
  });

  it('a point inside the hull is 0', () => {
    expect(shipHullDistance('battleship', true, 0, 0, 0, 0, 0)).toBe(0);
    expect(shipHullDistance('battleship', false, 0, ext.maxY * 0.5, 0, 0, 0)).toBe(0);
    expect(shipHullDistance('fighter', true, 1, 1, 0, 0, 0)).toBe(0);
  });

  it('a fighter with its shield up is measured to its bubble circle', () => {
    const r = shipBubbleRadius('fighter');
    expect(shipHullDistance('fighter', true, 300, 400, 0, 0, 1.2)).toBeCloseTo(500 - r, 9);
    // Shield down: its hull polygon, inside the bubble.
    const down = shipHullDistance('fighter', false, 300, 400, 0, 0, 1.2);
    expect(down).toBeGreaterThanOrEqual(500 - r - 1e-6);
    expect(down).toBeLessThanOrEqual(500);
  });

  it('agrees with the capital hit test: where a ray enters the hull, the distance is ~0', () => {
    const R = bb.radius;
    let hits = 0;
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const fx = Math.cos(a) * R * 2;
      const fy = Math.sin(a) * R * 2;
      const ty = ((i % 7) - 3) * R * 0.25;
      const len = Math.hypot(-fx, ty - fy);
      const dx = -fx / len; const dy = (ty - fy) / len;
      const d = refineRayHit('battleship', 0, fx, fy, dx, dy, R * 4, 0, 0, 0.3, R);
      expect(shipRayHit('battleship', true, fx, fy, dx, dy, R * 4, 0, 0, 0.3)).toBe(d);
      if (d === null) continue;
      hits++;
      expect(shipHullDistance('battleship', true, fx + dx * d, fy + dy * d, 0, 0, 0.3)).toBeLessThan(1e-6 * R);
      const before = shipHullDistance('battleship', true, fx + dx * (d - 5), fy + dy * (d - 5), 0, 0, 0.3);
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThanOrEqual(5 + 1e-6);
    }
    expect(hits).toBeGreaterThan(10);
  });
});

describe('shipWithinHullReach', () => {
  beforeEach(() => {
    shipHitBound('battleship'); // warm the per-kind bound cache
    partsSpy.mockClear();
  });

  it('a far target is rejected on the bounding circle without touching the polygon', () => {
    const far = shipHitBound('battleship') + 1500;
    expect(shipWithinHullReach('battleship', true, far, 0, 0, 0, 0, 1000)).toBe(false);
    expect(shipWithinHullReach('battleship', false, 0, -far, 0, 0, 1, 1000)).toBe(false);
    expect(partsSpy).not.toHaveBeenCalled();
  });

  it('inside the circle band it measures the hull', () => {
    const bowY = hullExtents('battleship').maxY + 100;
    expect(shipWithinHullReach('battleship', true, 0, bowY, 0, 0, 0, 150)).toBe(true);
    expect(partsSpy).toHaveBeenCalled();
    // Beside the beam at one radius: inside the bounding circle, out of a 150 u reach.
    expect(shipWithinHullReach('battleship', true, getShipKind('battleship').radius, 0, 0, 0, 0, 150)).toBe(false);
  });
});
