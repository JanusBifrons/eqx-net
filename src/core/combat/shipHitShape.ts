/**
 * The ONE hit shape of a ship, whoever flies it (owner's rule 2026-11-13:
 * "Ships turning, acceleration, weapons, everything is related to the ship,
 * regardless of pilot"). Every weapon path that can hit a ship (player bolts
 * and beams, NPC bolts and beams, structure turrets, missiles, the client's
 * beam-end and hit prediction) asks this module, with the ship's kind and
 * whether its shield is up. Nothing reads the pilot.
 *
 *   - shield UP   ⇒ the shield bubble: `kind.radius + shipTuning(kind).shieldPad`,
 *                   the shield-up collider and the drawn aura (`shieldBubbleRadius`);
 *   - shield DOWN ⇒ the hull polygon (`shipCollisionParts`, the shield-down
 *                   collider), gated by a cheap "does it come near" circle;
 *   - NO SHIELD   ⇒ always the hull polygon, whatever `shieldUp` says: a kind
 *                   with `shieldMax` 0 (`kindHasShield`; every capital, owner
 *                   2026-11-16 "capital ships never have shields").
 *
 * Splash is measured to `shipSplashRadius` (the kind's own radius, #18).
 *
 * Before 2026-11-13 a player ship was hit on its bubble but an NPC of the same
 * kind on a bare `kind.radius` circle (no pad, no hull when its shield was
 * down), and shell splash treated every player ship as a 12 u fighter.
 * Lock: `tests/integration/sectorRoom/shipHitShapeParity.test.ts`.
 *
 * Pure and allocation-free after the first call per kind (#14).
 */
import { getShipKind, kindHasShield } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import {
  pointToShipPolygonDistance,
  projectileSweepCircle,
  rayHitsShipPolygon,
  rayHitsSphere,
  segmentNearCircle,
  sweptSegmentHitsShipPolygon,
} from './Weapons.js';

/** The shield bubble's radius (shield-up hit circle of a shielded kind). */
export function shipBubbleRadius(kindId: string | null | undefined): number {
  const k = getShipKind(kindId ?? null);
  return k.radius + shipTuning(k).shieldPad;
}

const BOUND = new Map<string, number>();

/** A circle around the ship's centre that contains every shape it can be hit
 *  on (bubble and hull). The broadphase bins ships by it and the shield-down /
 *  capital paths gate on it. */
export function shipHitBound(kindId: string | null | undefined): number {
  const k = getShipKind(kindId ?? null);
  let b = BOUND.get(k.id);
  if (b !== undefined) return b;
  b = k.radius + shipTuning(k).shieldPad;
  for (const part of shipCollisionParts(k.id)) {
    for (const v of part) {
      const d = Math.hypot(v.x, v.y);
      if (d > b) b = d;
    }
  }
  BOUND.set(k.id, b);
  return b;
}

/** The circle an aimer lines a fixed gun up on: the shield bubble while a
 *  shielded kind's shield is up, else the kind's own hull radius (the polygon's
 *  size, #18). Used for the AI pilot's trigger cone, never for a hit test. */
export function shipAimRadius(kindId: string | null | undefined, shieldUp: boolean): number {
  const k = getShipKind(kindId ?? null);
  if (shieldUp && kindHasShield(k)) return k.radius + shipTuning(k).shieldPad;
  return k.radius;
}

/** The radius a blast measures a ship's edge by: its kind's own size (#18). */
export function shipSplashRadius(kindId: string | null | undefined): number {
  return getShipKind(kindId ?? null).radius;
}

/** Distance along the unit ray to the ship at (cx, cy, angle), or null.
 *  `halfWidth` (a wide beam, `beamHalfWidth`; owner 2026-11-15 "Hit by its
 *  width"): the first contact of a disc of that radius swept down the ray, so
 *  the shape is hit wherever the drawn beam covers it. 0 ⇒ the thin ray. */
export function shipRayHit(
  kindId: string | null | undefined, shieldUp: boolean,
  fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, angle: number,
  halfWidth = 0,
): number | null {
  const k = getShipKind(kindId ?? null);
  const id = k.id;
  if (shieldUp && kindHasShield(k)) return rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, shipBubbleRadius(id) + halfWidth);
  // "Does the ray come near?", never `rayHitsSphere`: that misses once the
  // origin is inside the circle past the centre (the far half of a hull).
  if (!segmentNearCircle(fx, fy, dx * maxDist, dy * maxDist, cx, cy, shipHitBound(id) + halfWidth)) return null;
  return rayHitsShipPolygon(fx, fy, dx, dy, maxDist, cx, cy, angle, shipCollisionParts(id), halfWidth);
}

/** First contact of a projectile step with the ship at (cx, cy, angle). */
export function shipSweepHit(
  kindId: string | null | undefined, shieldUp: boolean,
  fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
  cx: number, cy: number, angle: number,
): { entry: number; hitX: number; hitY: number } | null {
  const k = getShipKind(kindId ?? null);
  const id = k.id;
  if (shieldUp && kindHasShield(k)) {
    return projectileSweepCircle(fromX, fromY, stepX, stepY, projRadius, cx, cy, shipBubbleRadius(id));
  }
  if (!segmentNearCircle(fromX, fromY, stepX, stepY, cx, cy, shipHitBound(id) + projRadius)) return null;
  return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, shipCollisionParts(id));
}

/**
 * Distance from the world point (px, py) (a turret's muzzle) to the nearest
 * point of the ship's hit shape at (cx, cy, angle); 0 when the point is
 * inside. The same shape the hits use: a shielded kind with its shield up is
 * its bubble circle, everything else the hull polygon. Exact; for a range
 * gate use `shipWithinHullReach`, which skips the polygon when the bounding
 * circle already settles it.
 */
export function shipHullDistance(
  kindId: string | null | undefined, shieldUp: boolean,
  px: number, py: number, cx: number, cy: number, angle: number,
): number {
  const k = getShipKind(kindId ?? null);
  const id = k.id;
  if (shieldUp && kindHasShield(k)) {
    const d = Math.hypot(px - cx, py - cy) - shipBubbleRadius(id);
    return d > 0 ? d : 0;
  }
  return pointToShipPolygonDistance(px, py, cx, cy, angle, shipCollisionParts(id));
}

/**
 * True when the ship's hit shape comes within `reach` of (px, py). Cheap
 * first: past `shipHitBound` + reach from the centre it is out without
 * touching the polygon (the bound contains every vertex, so the hull can be
 * no closer than centre distance − bound).
 */
export function shipWithinHullReach(
  kindId: string | null | undefined, shieldUp: boolean,
  px: number, py: number, cx: number, cy: number, angle: number, reach: number,
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  const gate = shipHitBound(kindId) + reach;
  if (dx * dx + dy * dy > gate * gate) return false;
  return shipHullDistance(kindId, shieldUp, px, py, cx, cy, angle) <= reach;
}
