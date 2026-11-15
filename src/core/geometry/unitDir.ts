/**
 * Arithmetic-only unit directions: the one way shared deterministic geometry
 * (capital fracture, asteroid outlines) turns an angle into a direction.
 * `Math.sin` / `Math.cos` are not specified bit-exactly and differ between
 * JS engines, so code that must give the same vertices on the server (V8)
 * and in every browser (V8, SpiderMonkey, JavaScriptCore) uses this instead.
 */

/** Angle steps per full turn (a u16 angle). */
export const ANGLE_STEPS = 65536;

/**
 * The unit direction of a u16 angle (`ang` = angle × 65536 / 2π, x then y).
 * Arithmetic only (never sin/cos): the quarter-turn angle, folded to at most
 * π/4, goes through fixed Taylor series (error < 1e-13), the quadrant by sign
 * swaps. Writes into `out` when given (no allocation), else returns a new one.
 */
export function unitDirFromSteps(ang: number, out?: { x: number; y: number }): { x: number; y: number } {
  const a = (Math.round(ang) % ANGLE_STEPS + ANGLE_STEPS) % ANGLE_STEPS;
  const quadrant = Math.floor(a / 16384);
  const r = a - quadrant * 16384;
  const fold = r > 8192;
  const x = (fold ? 16384 - r : r) * (Math.PI / 32768);
  const x2 = x * x;
  // sin and cos of x ≤ π/4 (Horner, fixed order).
  const sx = x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110 * (1 - x2 / 156))))));
  const cx = 1 - x2 / 2 * (1 - x2 / 12 * (1 - x2 / 30 * (1 - x2 / 56 * (1 - x2 / 90 * (1 - x2 / 132 * (1 - x2 / 182))))));
  const c = fold ? sx : cx;
  const s = fold ? cx : sx;
  const o = out ?? { x: 0, y: 0 };
  if (quadrant === 0) { o.x = c; o.y = s; }
  else if (quadrant === 1) { o.x = -s; o.y = c; }
  else if (quadrant === 2) { o.x = -c; o.y = -s; }
  else { o.x = s; o.y = -c; }
  return o;
}
