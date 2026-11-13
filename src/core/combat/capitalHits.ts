/**
 * Hits on capital ships follow the hull (capital-ship R&D round 3, plan
 * eager-sauteeing-curry B). Every swarm hit test first tries the cheap circle
 * of the entity's radius; for a capital that circle is half a 5.8 km hull's
 * length, so a shot anywhere near the ship would count. These refine a circle
 * hit to the hull polygon (`shipCollisionParts`, the same outline the physics
 * collider uses). ONE helper for the server (projectiles, hitscan) and the
 * client hit prediction (#15).
 *
 * For a capital the caller's circle result is NOT the gate: the gate is
 * `segmentNearCircle` against `gateR` (the radius the caller's circle used).
 * The circle result comes from `rayHitsSphere`, which is null once the shot's
 * origin is inside the circle and past its closest approach to the centre, so
 * a shell stepping through the hull's FAR half (or a beam fired from beside
 * the hull, away from its centre) used to miss (2026-11-13).
 *
 * The shield pad is not modelled in the refinement: a hit lands on the hull
 * outline and the shield/hull layering still decides what it damages.
 * Pure, allocation-free (the parts are precomputed per kind).
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import { rayHitsShipPolygon, segmentNearCircle, sweptSegmentHitsShipPolygon } from './Weapons.js';

/** True for a capital-class ship kind id. */
export function isCapitalKindId(kindId: string | null | undefined): boolean {
  return kindId != null && getShipKind(kindId).sizeClass === 'capital' && getShipKind(kindId).id === kindId;
}

/** A hitscan ray tested against the bounding circle (`circleDist`, radius
 *  `gateR`), refined to the hull for a capital; any other kind returns
 *  `circleDist` unchanged. */
export function refineRayHit(
  kindId: string | null | undefined, circleDist: number | null,
  fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number,
  cx: number, cy: number, angle: number, gateR: number,
): number | null {
  if (!isCapitalKindId(kindId)) return circleDist;
  if (!segmentNearCircle(fromX, fromY, dirX * maxDist, dirY * maxDist, cx, cy, gateR)) return null;
  return rayHitsShipPolygon(fromX, fromY, dirX, dirY, maxDist, cx, cy, angle, shipCollisionParts(kindId!));
}

/** A projectile step tested against the bounding circle (`circle`, radius
 *  `gateR` = target radius + projectile radius), refined to the hull for a
 *  capital; any other kind returns `circle` unchanged. */
export function refineSweepHit(
  kindId: string | null | undefined, circle: { entry: number; hitX: number; hitY: number } | null,
  fromX: number, fromY: number, stepX: number, stepY: number,
  cx: number, cy: number, angle: number, gateR: number,
): { entry: number; hitX: number; hitY: number } | null {
  if (!isCapitalKindId(kindId)) return circle;
  if (!segmentNearCircle(fromX, fromY, stepX, stepY, cx, cy, gateR)) return null;
  return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, shipCollisionParts(kindId!));
}
