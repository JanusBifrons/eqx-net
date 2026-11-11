/**
 * Damage-number coalescing — pure, alloc-free (invariant #14).
 *
 * A new hit within MERGE_RADIUS_PX (on screen) of a live number folds into
 * that number instead of opening its own. Keyed by spot, not only by
 * targetId: a packed melee or a splash puts several targets under one
 * screen spot, and their stacked black-stroked numbers smeared into dark
 * blocks inside fireballs (owner review 2026-11-10; WS7.3).
 */

/** On-screen radius (CSS px) inside which a new hit joins a live number. */
export const MERGE_RADIUS_PX = 36;

/**
 * Index of the live entry (first `count` of `entries`) nearest to (x, y)
 * and within `radius` (same units as the coords), or -1 for none.
 */
export function findCoalesceIndex(
  entries: ArrayLike<{ curX: number; curY: number }>,
  count: number,
  x: number,
  y: number,
  radius: number,
): number {
  let best = -1;
  let bestD2 = radius * radius;
  for (let i = 0; i < count; i++) {
    const e = entries[i]!;
    const dx = e.curX - x;
    const dy = e.curY - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
