/**
 * Shells as events, slice 0 (docs/architecture/shell-events.md §2–§4): the
 * shared, pure flight maths both sides will use once a naval shell is sent as
 * one spawn event instead of riding every snapshot (#15).
 *
 * A naval shell flies in a straight line at a constant speed (no drag, no
 * spread), so its whole flight is known when it is fired. The server's
 * `ProjectilePipeline.advance` Euler-steps it (`x += vx · DT`, one step per
 * tick); `shellPoseAt` is the closed form of that step. The parity test
 * (`tests/unit/shellFlightParity.test.ts`) runs the real pipeline for every
 * naval gun's full flight in both range modes.
 *
 * Nothing here is wired yet. Every function is alloc-free (#14): results go
 * into caller-owned out objects.
 */

/** One server tick in seconds. Must equal `ProjectilePipeline`'s `DT_SEC`
 *  (the parity test fails if they differ). */
export const SHELL_TICK_DT_S = 1 / 60;

/** Wire precision of a shell's spawn position (world units). */
export const SHELL_POS_QUANTUM = 0.1;
/** Wire precision of a shell's velocity (world units per second). */
export const SHELL_VEL_QUANTUM = 0.01;

const POS_SCALE = 1 / SHELL_POS_QUANTUM; // 10
const VEL_SCALE = 1 / SHELL_VEL_QUANTUM; // 100

export interface ShellPoseMut {
  x: number;
  y: number;
}

export interface ShellSpawnMut {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * The shell's position after `tick − fireTick` pipeline steps:
 * `origin + v · (tick − fireTick) · DT`. `fireTick` is the shell's
 * `birthTick`. Not clamped to the flight: the caller ends the shell at
 * `fireTick + maxTicks` (or at its `shell_end` tick).
 */
export function shellPoseAt(
  x0: number, y0: number, vx: number, vy: number,
  fireTick: number, tick: number, out: ShellPoseMut,
): void {
  const t = (tick - fireTick) * SHELL_TICK_DT_S;
  out.x = x0 + vx * t;
  out.y = y0 + vy * t;
}

/** Round a shell position component to the wire precision (0.1 u). */
export function quantiseShellPos(v: number): number {
  return Math.round(v * POS_SCALE) / POS_SCALE;
}

/** Round a shell velocity component to the wire precision (0.01 u/s). */
export function quantiseShellVel(v: number): number {
  return Math.round(v * VEL_SCALE) / VEL_SCALE;
}

/**
 * Quantise a shell's spawn state to wire precision. The server applies this
 * to the record BEFORE its first step, so server and client integrate the
 * same numbers (design §2). Idempotent; `out` may be a fresh or reused object.
 */
export function quantiseShellSpawn(
  x: number, y: number, vx: number, vy: number, out: ShellSpawnMut,
): void {
  out.x = quantiseShellPos(x);
  out.y = quantiseShellPos(y);
  out.vx = quantiseShellVel(vx);
  out.vy = quantiseShellVel(vy);
}

/**
 * Does the segment (x0, y0) → (x1, y1) meet the axis-aligned square of
 * half-extent `half` around (cx, cy)? Bounds are inclusive (a touch counts),
 * matching `navalShellInView`. True when the path crosses the square even if
 * both ends are outside it.
 *
 * Separating-axis test with no division: the two box axes (segment bounds vs
 * box), then the segment's normal (all four corners strictly on one side ⇒
 * miss). A zero-length segment reduces to a point-in-box test.
 */
export function shellSegmentInView(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, half: number,
): boolean {
  const minX = cx - half;
  const maxX = cx + half;
  const minY = cy - half;
  const maxY = cy + half;
  if ((x0 < x1 ? x1 : x0) < minX || (x0 < x1 ? x0 : x1) > maxX) return false;
  if ((y0 < y1 ? y1 : y0) < minY || (y0 < y1 ? y0 : y1) > maxY) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  // Side of each corner relative to the segment's line (cross product).
  const a = dx * (minY - y0) - dy * (minX - x0);
  const b = dx * (minY - y0) - dy * (maxX - x0);
  const c = dx * (maxY - y0) - dy * (minX - x0);
  const d = dx * (maxY - y0) - dy * (maxX - x0);
  if (a > 0 && b > 0 && c > 0 && d > 0) return false;
  if (a < 0 && b < 0 && c < 0 && d < 0) return false;
  return true;
}
