/**
 * Incoming-fire warning — the pure math (no Pixi), so the node unit tests
 * import it directly. See `IncomingFireWarning.ts` for the renderer side and
 * docs/architecture/off-screen-indicators.md "Incoming fire".
 *
 * Everything is GAME space (Y up), seconds and world units. Allocation-free:
 * every function writes into a caller-owned record (invariant #14).
 */

/** Where and when a shell passes closest to the ship. */
export interface ShellPass {
  /** Seconds from now to the closest approach (within the shell's flight). */
  t: number;
  /** Distance (u) between shell and ship centre at that moment. */
  miss: number;
  /** The shell's world position at that moment (the fall-point marker). */
  x: number;
  y: number;
}

/** A shell that is not closing on the ship never warns. */
export const NOT_INCOMING = Number.POSITIVE_INFINITY;

/**
 * Closest approach of a straight-flying shell to a straight-flying ship,
 * clipped to the shell's remaining flight. Relative motion, so a ship
 * running from (or into) the salvo gets the right answer, not the point
 * where its centre is NOW. A shell moving away from the ship (already past,
 * or fired the other way) gets `miss = NOT_INCOMING`.
 */
export function predictShellPass(
  px: number, py: number, vx: number, vy: number, remainingS: number,
  shipX: number, shipY: number, shipVx: number, shipVy: number,
  out: ShellPass,
): ShellPass {
  const rx = px - shipX, ry = py - shipY;
  const wx = vx - shipVx, wy = vy - shipVy;
  const w2 = wx * wx + wy * wy;
  const closing = -(rx * wx + ry * wy);
  if (w2 < 1e-9 || closing <= 0 || !(remainingS > 0)) {
    out.t = 0; out.miss = NOT_INCOMING; out.x = px; out.y = py;
    return out;
  }
  let t = closing / w2;
  if (t > remainingS) t = remainingS;
  out.t = t;
  out.miss = Math.hypot(rx + wx * t, ry + wy * t);
  out.x = px + vx * t;
  out.y = py + vy * t;
  return out;
}

/**
 * Seconds of flight a shell has left: its gun's lifetime (`maxTicks` at
 * 60 Hz) minus how long it has flown since the client first saw it
 * (`travelled / speed`). The server sends a naval shell from its first
 * snapshot whenever its fall point is in the viewer's view (PR #425), so for
 * any shell that can land near you "first seen" ≈ "fired". A shell first seen
 * mid-flight gets a too-long remaining time, which only extends the segment
 * past its real end, where it is out of view and never within the danger
 * radius (`docs/architecture/off-screen-indicators.md`).
 */
export function shellRemainingS(maxTicks: number, travelled: number, speed: number): number {
  if (!(speed > 0)) return 0;
  const left = maxTicks / 60 - travelled / speed;
  return left > 0 ? left : 0;
}

/** The danger radius for one shot: the ship's `incomingFireRadius`
 *  (shipTuning, #18) plus the gun's splash radius, if it has one. */
export function shellDangerRadius(shipRadius: number, splashRadius: number): number {
  return shipRadius + (splashRadius > 0 ? splashRadius : 0);
}

/** Does a predicted pass come within `dangerRadius` of the ship? */
export function isShellDangerous(pass: ShellPass, dangerRadius: number): boolean {
  return pass.miss <= dangerRadius;
}

/** One marker: the shells of a salvo falling in the same area. */
export interface FallGroup {
  /** Fall-point centroid (game space). */
  x: number;
  y: number;
  /** Centroid of where the group's shells are NOW (the edge indicator points here). */
  sx: number;
  sy: number;
  /** Soonest arrival (s) in the group. */
  t: number;
  /** Largest danger radius in the group (drawn ring). */
  r: number;
  count: number;
}

export function makeFallGroup(): FallGroup {
  return { x: 0, y: 0, sx: 0, sy: 0, t: 0, r: 0, count: 0 };
}

/**
 * Greedy grouping: a pass joins the first group whose fall-point centroid is
 * within `joinDist` and whose soonest arrival is within `joinDt` seconds;
 * else it opens a new group (up to `groups.length`; overflow joins nothing
 * and is dropped). Inputs are parallel arrays of `n` passes. Returns the
 * group count. Allocation-free: `groups` is a caller-owned pool.
 */
export function groupShellPasses(
  fx: Float64Array, fy: Float64Array, sx: Float64Array, sy: Float64Array,
  t: Float64Array, r: Float64Array, n: number,
  joinDist: number, joinDt: number, groups: FallGroup[],
): number {
  let g = 0;
  const jd2 = joinDist * joinDist;
  for (let i = 0; i < n; i++) {
    let into = -1;
    for (let k = 0; k < g; k++) {
      const G = groups[k]!;
      const dx = G.x - fx[i]!, dy = G.y - fy[i]!;
      if (dx * dx + dy * dy <= jd2 && Math.abs(G.t - t[i]!) <= joinDt) { into = k; break; }
    }
    if (into < 0) {
      if (g >= groups.length) continue;
      const G = groups[g++]!;
      G.x = fx[i]!; G.y = fy[i]!; G.sx = sx[i]!; G.sy = sy[i]!;
      G.t = t[i]!; G.r = r[i]!; G.count = 1;
      continue;
    }
    const G = groups[into]!;
    const c = G.count + 1;
    G.x += (fx[i]! - G.x) / c; G.y += (fy[i]! - G.y) / c;
    G.sx += (sx[i]! - G.sx) / c; G.sy += (sy[i]! - G.sy) / c;
    if (t[i]! < G.t) G.t = t[i]!;
    if (r[i]! > G.r) G.r = r[i]!;
    G.count = c;
  }
  return g;
}

/** Fewest CSS px a far naval shell is drawn wide (it is never sub-pixel). */
export const SHELL_MIN_SCREEN_PX = 3;

/**
 * Scale multiplier that keeps something `worldSize` u across at least
 * `minPx` on screen at camera scale `cameraScale` (px per u). 1 when it is
 * already big enough.
 */
export function minScreenSizeMul(worldSize: number, cameraScale: number, minPx: number): number {
  const px = worldSize * cameraScale;
  if (!(px > 0)) return 1;
  return px >= minPx ? 1 : minPx / px;
}

const LABELS: string[] = [];
/** Countdown text in tenths ("3.2s"), cached per value (no per-frame
 *  string building, #14). Clamped to 0–99.9 s. */
export function countdownLabel(seconds: number): string {
  let i = Math.ceil(seconds * 10 - 1e-6);
  if (!(i > 0)) i = 0;
  if (i > 999) i = 999;
  let s = LABELS[i];
  if (s === undefined) { s = `${(i / 10).toFixed(1)}s`; LABELS[i] = s; }
  return s;
}
