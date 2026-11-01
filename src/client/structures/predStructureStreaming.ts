/**
 * A3 (plan soft-leaping-truffle v2) — which structures and shield walls the
 * client prediction world carries. Every server correction replays ~20 physics
 * ticks over everything in the prediction world, so a whole citadel there is
 * expensive (see PREDWORLD_STRUCTURE_RADIUS). Bodies are streamed in by their
 * EDGE distance from the local ship and released a little further out.
 */
import {
  PREDWORLD_STRUCTURE_HYSTERESIS,
  PREDWORLD_STRUCTURE_RADIUS,
} from '../../shared-types/structureBudgets.js';

/** Should the prediction world hold this body? `present`: it does already. */
export function wantPredBody(present: boolean, edgeDistance: number): boolean {
  return edgeDistance <= PREDWORLD_STRUCTURE_RADIUS + (present ? PREDWORLD_STRUCTURE_HYSTERESIS : 0);
}

/** Distance from point (px, py) to the segment (ax, ay)–(bx, by). */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
