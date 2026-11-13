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
 *   - a CAPITAL   ⇒ always the hull polygon (its shield follows its hull, and
 *                   its circle is half the hull's LENGTH; the pad is not
 *                   modelled), shield up or down.
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
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import {
  projectileSweepCircle,
  rayHitsShipPolygon,
  rayHitsSphere,
  segmentNearCircle,
  sweptSegmentHitsShipPolygon,
} from './Weapons.js';
import { isCapitalKindId } from './capitalHits.js';

/** The shield bubble's radius (shield-up hit circle of a non-capital). */
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

/** The radius a blast measures a ship's edge by: its kind's own size (#18). */
export function shipSplashRadius(kindId: string | null | undefined): number {
  return getShipKind(kindId ?? null).radius;
}

/** Distance along the unit ray to the ship at (cx, cy, angle), or null. */
export function shipRayHit(
  kindId: string | null | undefined, shieldUp: boolean,
  fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, angle: number,
): number | null {
  const id = getShipKind(kindId ?? null).id;
  if (shieldUp && !isCapitalKindId(id)) return rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, shipBubbleRadius(id));
  // "Does the ray come near?", never `rayHitsSphere`: that misses once the
  // origin is inside the circle past the centre (the far half of a hull).
  if (!segmentNearCircle(fx, fy, dx * maxDist, dy * maxDist, cx, cy, shipHitBound(id))) return null;
  return rayHitsShipPolygon(fx, fy, dx, dy, maxDist, cx, cy, angle, shipCollisionParts(id));
}

/** First contact of a projectile step with the ship at (cx, cy, angle). */
export function shipSweepHit(
  kindId: string | null | undefined, shieldUp: boolean,
  fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
  cx: number, cy: number, angle: number,
): { entry: number; hitX: number; hitY: number } | null {
  const id = getShipKind(kindId ?? null).id;
  if (shieldUp && !isCapitalKindId(id)) {
    return projectileSweepCircle(fromX, fromY, stepX, stepY, projRadius, cx, cy, shipBubbleRadius(id));
  }
  if (!segmentNearCircle(fromX, fromY, stepX, stepY, cx, cy, shipHitBound(id) + projRadius)) return null;
  return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, shipCollisionParts(id));
}
