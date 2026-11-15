/**
 * Owner decision 2026-11-15: the capital heavy beam is drawn
 * `HEAVY_BEAM_WIDTH` wide, so it hits by its width ("Hit by its width"):
 * anything the drawn beam covers is hit and the beam stops on it. Its hit test
 * sweeps a disc of half that width along the ray (a capsule) instead of a
 * line; every other beam stays the thin centre line.
 *
 * These lock the core geometry: a hull, a shield bubble, a structure box and
 * a rock offset sideways from the centre line by less than the half-width are
 * hit at the first contact of the swept disc; by more, missed.
 */
import { describe, expect, it } from 'vitest';
import {
  HEAVY_BEAM_WIDTH, WEAPON_IDS, getWeapon,
} from './WeaponCatalogue.js';
import { beamHalfWidth, rayHitsBox, rayHitsConvexPolygon, pointToShipPolygonDistance } from './Weapons.js';
import { shipBubbleRadius, shipRayHit } from './shipHitShape.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { wreckRayHit } from '../destruction/wreckHits.js';

const HW = HEAVY_BEAM_WIDTH / 2;

/** The hull's furthest reach along +y at angle 0 (its nose tip). */
function hullMaxY(kindId: string): number {
  let m = -Infinity;
  for (const part of shipCollisionParts(kindId)) for (const v of part) if (v.y > m) m = v.y;
  return m;
}

/** Brute-force first contact of a disc of radius r swept along +x from
 *  (fx, y) against the hull at the origin (angle 0): fine march. */
function bruteEntry(kindId: string, fx: number, y: number, maxDist: number, r: number): number | null {
  const parts = shipCollisionParts(kindId);
  for (let t = 0; t <= maxDist; t += 0.05) {
    if (pointToShipPolygonDistance(fx + t, y, 0, 0, 0, parts) <= r) return t;
  }
  return null;
}

describe('heavy beam hits by its width (owner 2026-11-15)', () => {
  it('the heavy beam record carries its drawn width; every other weapon is a thin line', () => {
    expect(getWeapon('heavy_beam').mode).toBe('hitscan');
    expect(beamHalfWidth(getWeapon('heavy_beam'))).toBe(HEAVY_BEAM_WIDTH / 2);
    for (const id of WEAPON_IDS) {
      if (id === 'heavy_beam') continue;
      expect(beamHalfWidth(getWeapon(id)), id).toBe(0);
    }
  });

  for (const kindId of ['missile-frigate', 'fighter'] as const) {
    it(`${kindId}, shield down: a beam passing beside the hull by less than the half-width hits it, by more misses`, () => {
      const top = hullMaxY(kindId);
      const fx = -2000;
      const near = top + HW * 0.6; // centre line misses the hull by 0.6 × half-width
      const far = top + HW * 1.4;
      // The thin centre line misses at both offsets (today's behaviour).
      expect(shipRayHit(kindId, false, fx, near, 1, 0, 4000, 0, 0, 0)).toBeNull();
      expect(shipRayHit(kindId, false, fx, near, 1, 0, 4000, 0, 0, 0, 0)).toBeNull();
      // The wide beam hits at the near offset, at the first contact of its edge.
      const d = shipRayHit(kindId, false, fx, near, 1, 0, 4000, 0, 0, 0, HW);
      expect(d).not.toBeNull();
      const brute = bruteEntry(kindId, fx, near, 4000, HW)!;
      expect(brute).not.toBeNull();
      expect(Math.abs(d! - brute)).toBeLessThan(0.1);
      // ... and misses at the far one.
      expect(shipRayHit(kindId, false, fx, far, 1, 0, 4000, 0, 0, 0, HW)).toBeNull();
    });

    it(`${kindId}, shield up: the bubble grows by the half-width`, () => {
      const R = shipBubbleRadius(kindId);
      expect(shipRayHit(kindId, true, -2000, R + HW * 0.6, 1, 0, 4000, 0, 0, 0)).toBeNull();
      const d = shipRayHit(kindId, true, -2000, R + HW * 0.6, 1, 0, 4000, 0, 0, 0, HW);
      expect(d).not.toBeNull();
      expect(d!).toBeCloseTo(2000 - Math.sqrt((R + HW) ** 2 - (R + HW * 0.6) ** 2), 6);
      expect(shipRayHit(kindId, true, -2000, R + HW * 1.4, 1, 0, 4000, 0, 0, 0, HW)).toBeNull();
    });
  }

  it('a capital hull too (always its polygon), from beside its far half', () => {
    const kindId = 'battleship';
    const top = hullMaxY(kindId);
    expect(shipRayHit(kindId, true, -6000, top + HW * 0.6, 1, 0, 12_000, 0, 0, 0)).toBeNull();
    expect(shipRayHit(kindId, true, -6000, top + HW * 0.6, 1, 0, 12_000, 0, 0, 0, HW)).not.toBeNull();
    expect(shipRayHit(kindId, true, -6000, top + HW * 1.4, 1, 0, 12_000, 0, 0, 0, HW)).toBeNull();
  });

  it('a structure box is hit on its rounded outline (the corners are round, not mitred)', () => {
    // Box half extents 50 × 50 at the origin; a ray at 45° passing the
    // (50, 50) corner. Centre-line distance to the corner `c`.
    const s = Math.SQRT1_2;
    const along = (c: number) => {
      // Line x − y = −c·√2 ... a ray along (s, −s) whose closest approach to
      // (50, 50) is c, on the far side from the box.
      const px = 50 + c * s, py = 50 + c * s;
      return { fx: px - 500 * s, fy: py + 500 * s };
    };
    const inside = along(HW * 0.9);
    expect(rayHitsBox(inside.fx, inside.fy, s, -s, 1000, 0, 0, 50, 50)).toBeNull();
    const d = rayHitsBox(inside.fx, inside.fy, s, -s, 1000, 0, 0, 50, 50, undefined, HW);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(500 - Math.sqrt(HW * HW - (HW * 0.9) ** 2), 6);
    // Past the round corner (a mitred box grown by HW would still catch it).
    const outside = along(HW * 1.2);
    expect(rayHitsBox(outside.fx, outside.fy, s, -s, 1000, 0, 0, 50, 50, undefined, HW)).toBeNull();
    // Gate parts (flat [ox, oy, hw, hh]): the same rounded test per part.
    const parts = new Float32Array([0, 0, 50, 50]);
    expect(rayHitsBox(inside.fx, inside.fy, s, -s, 1000, 0, 0, 0, 0, parts, HW)).toBeCloseTo(d!, 4);
  });

  it('a rock (convex polygon) and a wreck piece are hit by the width too', () => {
    const square = [{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 }];
    expect(rayHitsConvexPolygon(-500, 40 + HW * 0.5, 1, 0, 1000, 0, 0, 0, square)).toBeNull();
    expect(rayHitsConvexPolygon(-500, 40 + HW * 0.5, 1, 0, 1000, 0, 0, 0, square, HW)).toBeCloseTo(460 - Math.sqrt(HW * HW - (HW * 0.5) ** 2), 6);
    expect(rayHitsConvexPolygon(-500, 40 + HW * 1.5, 1, 0, 1000, 0, 0, 0, square, HW)).toBeNull();
    // Flat face: first contact one half-width before the face.
    expect(rayHitsConvexPolygon(-500, 0, 1, 0, 1000, 0, 0, 0, square, HW)).toBeCloseTo(460 - HW, 6);
    // Starting within the half-width of the rock ⇒ contact at once.
    expect(rayHitsConvexPolygon(-60, 0, 1, 0, 1000, 0, 0, 0, square, HW)).toBe(0);
    expect(wreckRayHit([square], 60, -500, 40 + HW * 0.5, 1, 0, 1000, 0, 0, 0)).toBeNull();
    expect(wreckRayHit([square], 60, -500, 40 + HW * 0.5, 1, 0, 1000, 0, 0, 0, HW)).not.toBeNull();
  });

  it('half-width 0 is the thin line, bit for bit', () => {
    const kind = getShipKind('missile-frigate');
    for (const off of [0, 5, 10, kind.radius, kind.radius + 5]) {
      for (const shieldUp of [true, false]) {
        expect(shipRayHit(kind.id, shieldUp, -500, off, 1, 0, 1000, 0, 0, 0.3, 0))
          .toBe(shipRayHit(kind.id, shieldUp, -500, off, 1, 0, 1000, 0, 0, 0.3));
      }
    }
  });
});
