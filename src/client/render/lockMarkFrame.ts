/**
 * Where, and how big, to draw a fire-control mark (lock ring, group brackets,
 * the threat diamond, the smart-aim candidate ring) on a target. Pure + alloc-
 * free (writes into `out`), so it can run per frame (#14) and be unit-tested.
 *
 * A mark is sized from the target's hull radius (which already follows
 * `shipTuning` / the ship-scale knob, #18) so it sits just outside the
 * silhouette. That breaks on a capital: a battleship is many screens long at
 * normal zoom, so a hull-sized diamond becomes two stray lines crossing the
 * screen, nowhere near anything (showcase `capital-guns-fighter`, 2026-11-10).
 *
 * So the mark's half-size is capped at {@link LOCK_MARK_MAX_SCREEN_HALF} screen
 * pixels. When the cap bites the mark no longer surrounds the hull, so it is
 * moved onto the hull where the pilot can see it: the point on the ship's keel
 * line (its long axis, within {@link LOCK_KEEL_FRAC} of the radius) closest to
 * the viewer. Uncapped marks (every fighter at every zoom) are unchanged:
 * centred on the target, `max(LOCK_MIN_HALF, r + LOCK_PAD)`.
 *
 * Coordinates are game space (Y-up); `angle` is the target's heading
 * (forward = (-sin a, cos a)).
 */
export const LOCK_PAD = 10;
export const LOCK_MIN_HALF = 16;
/** Largest on-screen half-size of a lock mark, in screen pixels. A 2x fighter
 *  (half 34 u) stays under it up to the 3x zoom ceiling. */
export const LOCK_MARK_MAX_SCREEN_HALF = 120;
/** How far along the keel (fraction of the hull radius) a capped mark may sit. */
export const LOCK_KEEL_FRAC = 0.8;

export interface LockMarkFrame {
  x: number;
  y: number;
  /** Half-size in world units (multiply by the per-mark factor, e.g. ring 1.35). */
  half: number;
  /** True when the screen cap applied and the mark was moved onto the hull. */
  capped: boolean;
}

/**
 * @param tx,ty   target centre (game space)
 * @param angle   target heading (rad)
 * @param r       target hull radius (world units)
 * @param ox,oy   viewer (the local ship / camera centre) in game space
 * @param px      world units per screen pixel (1 / zoom)
 */
export function lockMarkFrame(
  tx: number, ty: number, angle: number, r: number,
  ox: number, oy: number, px: number, out: LockMarkFrame,
): LockMarkFrame {
  const half = Math.max(LOCK_MIN_HALF, r + LOCK_PAD);
  const max = LOCK_MARK_MAX_SCREEN_HALF * px;
  if (half <= max) {
    out.x = tx; out.y = ty; out.half = half; out.capped = false;
    return out;
  }
  const fx = -Math.sin(angle), fy = Math.cos(angle);
  const reach = r * LOCK_KEEL_FRAC;
  const t = Math.max(-reach, Math.min(reach, (ox - tx) * fx + (oy - ty) * fy));
  out.x = tx + fx * t;
  out.y = ty + fy * t;
  out.half = max;
  out.capped = true;
  return out;
}

/** Largest on-screen radius of the threat ring round the local ship (a
 *  capital's 1.9x-hull ring would sit off screen). */
export const THREAT_RING_MAX_SCREEN_R = 220;

/** Threat-ring radius round the local ship: 1.9x hull + 10 px, capped on screen. */
export function threatRingRadius(localR: number, px: number): number {
  return Math.min(localR * 1.9 + 10 * px, THREAT_RING_MAX_SCREEN_R * px);
}
