/**
 * Weapon hits on capital wreck pieces (capital destruction S2a). A wreck
 * piece is terrain that BLOCKS shots: projectiles, shells, missiles and beams
 * stop on it. The cheap bounding circle runs first, then the shot is refined
 * to the piece's convex parts (the same parts its physics body is built
 * from). One helper for every server weapon path; the client hit prediction
 * joins it in S3 (#15). Pure, allocation-free.
 */
import { projectileSweepCircle, rayHitsSphere, rayHitsShipPolygon, sweptSegmentHitsShipPolygon } from '../combat/Weapons.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/** Ray vs a wreck piece at (cx, cy, angle): distance to entry, or null. */
export function wreckRayHit(
  parts: ReadonlyArray<ReadonlyArray<Vec2>> | undefined, radius: number,
  fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, angle: number,
): number | null {
  const d = rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, radius);
  if (d === null || parts === undefined) return d;
  return rayHitsShipPolygon(fx, fy, dx, dy, maxDist, cx, cy, angle, parts);
}

/** One projectile step vs a wreck piece: entry + hit point, or null. */
export function wreckSweepHit(
  parts: ReadonlyArray<ReadonlyArray<Vec2>> | undefined, radius: number,
  fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
  cx: number, cy: number, angle: number,
): { entry: number; hitX: number; hitY: number } | null {
  const circle = projectileSweepCircle(fromX, fromY, stepX, stepY, projRadius, cx, cy, radius);
  if (circle === null || parts === undefined) return circle;
  return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, parts);
}
