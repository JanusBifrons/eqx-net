/**
 * Weapon hits on capital wreck pieces (capital destruction S2a). A wreck
 * piece is terrain that BLOCKS shots: projectiles, shells, missiles and beams
 * stop on it. The cheap bounding circle runs first, then the shot is refined
 * to the piece's convex parts (the same parts its physics body is built
 * from). One helper for every server weapon path; the client hit prediction
 * joins it in S3 (#15). Pure, allocation-free.
 *
 * The circle gate asks only "does the segment come within the circle?"
 * (`segmentNearCircle`), never `rayHitsSphere`: that returns null once the
 * origin is inside the circle and past its closest approach to the centre,
 * so a shell stepping through a long piece off its centre passed straight
 * through the piece's far half (found by the overkill knock-back test,
 * 2026-11-13).
 */
import { projectileSweepCircle, rayHitsSphere, rayHitsShipPolygon, sweptSegmentHitsShipPolygon } from '../combat/Weapons.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/** Does the segment (fx, fy) → (fx + sx, fy + sy) come within `r` of (cx, cy)?
 *  True when it starts inside the circle too. */
export function segmentNearCircle(
  fx: number, fy: number, sx: number, sy: number, cx: number, cy: number, r: number,
): boolean {
  const l2 = sx * sx + sy * sy;
  let t = l2 > 0 ? ((cx - fx) * sx + (cy - fy) * sy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = fx + sx * t - cx;
  const py = fy + sy * t - cy;
  return px * px + py * py <= r * r;
}

/** Ray vs a wreck piece at (cx, cy, angle): distance to entry, or null. */
export function wreckRayHit(
  parts: ReadonlyArray<ReadonlyArray<Vec2>> | undefined, radius: number,
  fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, angle: number,
): number | null {
  if (parts === undefined) return rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, radius);
  if (!segmentNearCircle(fx, fy, dx * maxDist, dy * maxDist, cx, cy, radius)) return null;
  return rayHitsShipPolygon(fx, fy, dx, dy, maxDist, cx, cy, angle, parts);
}

/** One projectile step vs a wreck piece: entry + hit point, or null. */
export function wreckSweepHit(
  parts: ReadonlyArray<ReadonlyArray<Vec2>> | undefined, radius: number,
  fromX: number, fromY: number, stepX: number, stepY: number, projRadius: number,
  cx: number, cy: number, angle: number,
): { entry: number; hitX: number; hitY: number } | null {
  if (parts === undefined) return projectileSweepCircle(fromX, fromY, stepX, stepY, projRadius, cx, cy, radius);
  if (!segmentNearCircle(fromX, fromY, stepX, stepY, cx, cy, radius + projRadius)) return null;
  return sweptSegmentHitsShipPolygon(fromX, fromY, stepX, stepY, cx, cy, angle, parts);
}
