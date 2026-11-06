/**
 * Hits on capital ships follow the hull (capital-ship R&D round 3, plan
 * eager-sauteeing-curry B). Every swarm hit test first tries the cheap circle
 * of the entity's radius; for a capital that circle is half a 5.8 km hull's
 * length, so a shot anywhere near the ship would count. These refine a circle
 * hit to the hull polygon (`shipCollisionParts`, the same outline the physics
 * collider uses). ONE helper for the server (projectiles, hitscan) and the
 * client hit prediction (#15).
 *
 * The shield pad is not modelled in the refinement: a hit lands on the hull
 * outline and the shield/hull layering still decides what it damages.
 * Pure, allocation-free (the parts are precomputed per kind).
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import { rayHitsShipPolygon, sweptSegmentHitsShipPolygon } from './Weapons.js';

/** True for a capital-class ship kind id. */
export function isCapitalKindId(kindId: string | null | undefined): boolean {
  return kindId != null && getShipKind(kindId).sizeClass === 'capital' && getShipKind(kindId).id === kindId;
}

/** A hitscan ray that already hit the bounding circle (`circleDist`), refined
 *  to the hull for a capital; any other kind returns `circleDist` unchanged. */
export function refineRayHit(
  kindId: string | null | undefined, circleDist: number | null,
  fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number,
  cx: number, cy: number, angle: number,
): number | null {
  if (circleDist === null || !isCapitalKindId(kindId)) return circleDist;
  return rayHitsShipPolygon(fromX, fromY, dirX, dirY, maxDist, cx, cy, angle, shipCollisionParts(kindId));
}

/** A projectile step that already hit the bounding circle, refined to the
 *  hull for a capital; any other kind returns `circle` unchanged. */
export function refineSweepHit(
  kindId: string | null | undefined, circle: { entry: number; hitX: number; hitY: number } | null,
  fromX: number, fromY: number, stepX: number, stepY: number,
  cx: number, cy: number, angle: number,
): { entry: number; hitX: number; hitY: number } | null {
  if (circle === null || !isCapitalKindId(kindId)) return circle;
  return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, shipCollisionParts(kindId));
}
