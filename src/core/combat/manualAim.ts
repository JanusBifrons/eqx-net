/**
 * Aim bearings: the wire encoding (`encodeAim` / `decodeAim`, used by
 * `lock_track.b`, the lock line's bearing) and the screen-stick / vector →
 * world-bearing helpers the lock line uses. A WORLD BEARING is radians in the
 * ship-angle convention: 0 = +y world, `atan2(-dx, dy)`.
 *
 * History: this was the manual-aim rule (exp/hud-mobile-first). Lock-to-fire
 * retired manual aim (turrets aim at their group's lock) and the input `aim`
 * field was dropped from the wire.
 */
import { wrapPi } from '../ai/WeaponMountController.js';

/** Wire quantisation: 4096 steps per turn (~0.088° — far below any arc). */
export const AIM_STEPS = 4096;
const TWO_PI = Math.PI * 2;

/** World bearing (any range) → wire integer in [0, AIM_STEPS). */
export function encodeAim(bearing: number): number {
  const turns = bearing / TWO_PI;
  const frac = turns - Math.floor(turns);
  const q = Math.round(frac * AIM_STEPS);
  return q >= AIM_STEPS ? 0 : q;
}

/** Wire integer → world bearing in (-π, π]. */
export function decodeAim(q: number): number {
  return wrapPi((q / AIM_STEPS) * TWO_PI);
}

/** Screen-space stick (x right, y DOWN, pointer convention) → world bearing.
 *  The camera draws game +y UP (pixi y = -gameY) and never rotates, so the
 *  game-space direction is (x, -y). */
export function stickToWorldBearing(x: number, yDown: number): number {
  return Math.atan2(-x, -yDown);
}

/** World vector (dx, dy in game space) → world bearing. */
export function vectorToWorldBearing(dx: number, dy: number): number {
  return Math.atan2(-dx, dy);
}
