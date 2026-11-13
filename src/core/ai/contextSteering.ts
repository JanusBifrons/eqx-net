/**
 * Context steering (Andrew Fray, "Context Steering: Behavior-Driven Steering
 * at the Macro Scale", Game AI Pro 2 ch.18 / GDC AI Summit 2013).
 *
 * WHY: blending boids-style weighted vectors (chase + avoid + spacing) lets
 * opposing concerns cancel out (an obstacle dead ahead of the goal sums to a
 * zero vector) and jitter from tick to tick as weights trade places. Context
 * steering instead keeps each concern's opinion PER HEADING and decides once:
 *
 *  - Every agent owns two fixed maps over `CONTEXT_SLOTS` (16) headings:
 *    `interest` (where it wants to go) and `danger` (where it must not go).
 *  - Behaviours WRITE into the maps (max-accumulate, so concerns never cancel):
 *    `addInterestToward`, `addInterestOrbit`, `addDangerFromPoint`,
 *    `addDangerFromSegment`. A new concern is one new writer.
 *  - `resolveContext` MASKS every slot whose danger exceeds the minimum danger
 *    (+ `CONTEXT_DANGER_EPSILON`), takes the highest-interest slot left,
 *    refines it between slots with a parabolic fit over its neighbours (masked
 *    neighbours count as 0, so the refinement only leans toward SAFE slots),
 *    and returns a desired heading plus a desired-speed scale in [0, 1]
 *    (lowered when the chosen slot still carries danger or interest is weak;
 *    0 when every heading is fully dangerous — it then faces the least bad one).
 *
 * Slot `i` points at ship angle `i · 2π / CONTEXT_SLOTS`, using the codebase
 * ship-angle convention: forward = (-sin θ, cos θ) (`formation.ts`,
 * `World.applyInput`); `angleForDir(dx, dy)` = `Math.atan2(-dx, dy)` as in
 * `HostileDroneBehaviour`. Slots therefore run counter-clockwise from +Y.
 *
 * Zone-pure (src/core), deterministic, allocation-free (#14): the maps are
 * allocated ONCE per behaviour by `createContextMaps`; every writer and the
 * resolver are scalar in / caller-owned out. Game-space is Y-up.
 */

export const CONTEXT_SLOTS = 16;

/** Angle between neighbouring slots (radians). */
export const CONTEXT_SLOT_ANGLE = (2 * Math.PI) / CONTEXT_SLOTS;

/** Danger this far above the minimum is masked. Small, so faint dangers far
 *  away do not mask whole hemispheres. */
export const CONTEXT_DANGER_EPSILON = 0.05;

export interface ContextMaps {
  interest: Float32Array;
  danger: Float32Array;
}

export interface ContextSteerOutput {
  /** Unit desired-heading direction. */
  dirX: number;
  dirY: number;
  /** Desired ship angle (`angleForDir(dirX, dirY)`), in (-π, π]. */
  angle: number;
  /** Desired-speed scale in [0, 1]. */
  speedScale: number;
  /** Winning slot index (before sub-slot refinement). */
  slot: number;
}

const SLOT_DIR_X = new Float64Array(CONTEXT_SLOTS);
const SLOT_DIR_Y = new Float64Array(CONTEXT_SLOTS);
for (let i = 0; i < CONTEXT_SLOTS; i++) {
  const a = i * CONTEXT_SLOT_ANGLE;
  SLOT_DIR_X[i] = -Math.sin(a);
  SLOT_DIR_Y[i] = Math.cos(a);
}

/** Unit X of slot `i`'s heading (ship-angle convention). */
export function slotDirX(i: number): number {
  return SLOT_DIR_X[i]!;
}

/** Unit Y of slot `i`'s heading (ship-angle convention). */
export function slotDirY(i: number): number {
  return SLOT_DIR_Y[i]!;
}

/** Ship angle facing direction (dx, dy): forward = (-sin θ, cos θ). */
export function angleForDir(dx: number, dy: number): number {
  return Math.atan2(-dx, dy);
}

/** Allocate one agent's maps. Call once at behaviour construction. */
export function createContextMaps(): ContextMaps {
  return {
    interest: new Float32Array(CONTEXT_SLOTS),
    danger: new Float32Array(CONTEXT_SLOTS),
  };
}

/** Reusable output scratch. */
export function makeContextOutput(): ContextSteerOutput {
  return { dirX: 0, dirY: 1, angle: 0, speedScale: 0, slot: 0 };
}

/** Zero both maps (start of each tick). */
export function clearContextMaps(m: ContextMaps): void {
  m.interest.fill(0);
  m.danger.fill(0);
}

/**
 * Interest around direction (dx, dy) (need not be unit): slot value =
 * `weight · ((1 + dot) / 2) ^ shape`. The remap keeps a little interest even
 * sideways/behind (so a masked goal still leaves somewhere to go); a larger
 * `shape` sharpens the lobe (1 = broad cardioid, 4+ = tight).
 */
export function addInterestToward(
  m: ContextMaps,
  dx: number,
  dy: number,
  weight: number,
  shape: number,
): void {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || weight <= 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const interest = m.interest;
  for (let i = 0; i < CONTEXT_SLOTS; i++) {
    const dot = SLOT_DIR_X[i]! * ux + SLOT_DIR_Y[i]! * uy;
    const v = weight * Math.pow((1 + dot) * 0.5, shape);
    if (v > interest[i]!) interest[i] = v;
  }
}

/** Lobe sharpness used by `addInterestOrbit`. */
const ORBIT_SHAPE = 2;

/**
 * Interest perpendicular to the line to the target (orbiting): the tangent of
 * a circle around it, clockwise (Y-up, viewed from +Z) or counter-clockwise.
 * Pure tangent — callers hold the radius with a separate toward/away writer.
 */
export function addInterestOrbit(
  m: ContextMaps,
  dxToTarget: number,
  dyToTarget: number,
  clockwise: boolean,
  weight: number,
): void {
  // Clockwise around the target = the radius vector (self - target) rotated
  // −90°; with d = target - self that is (-dy, dx). Counter-clockwise: (dy, -dx).
  if (clockwise) addInterestToward(m, -dyToTarget, dxToTarget, weight, ORBIT_SHAPE);
  else addInterestToward(m, dyToTarget, -dxToTarget, weight, ORBIT_SHAPE);
}

/**
 * Danger toward a nearby body at offset (dx, dy) (need not be unit), `dist`
 * away (centre to centre). Strength is 1 within `radius`, falling linearly to
 * 0 at `radius + falloffRange`; it spreads over slots by `max(0, dot)`, so the
 * heading straight at the body is worst and perpendicular headings are clear.
 * Use for neighbour separation and obstacles.
 */
export function addDangerFromPoint(
  m: ContextMaps,
  dx: number,
  dy: number,
  dist: number,
  radius: number,
  falloffRange: number,
  weight: number,
): void {
  if (weight <= 0) return;
  let s: number;
  if (dist <= radius) s = 1;
  else if (falloffRange <= 0 || dist >= radius + falloffRange) return;
  else s = 1 - (dist - radius) / falloffRange;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    // Exactly on top: every heading equally dangerous — leave the choice to interest.
    const danger = m.danger;
    const v = weight * s;
    for (let i = 0; i < CONTEXT_SLOTS; i++) if (v > danger[i]!) danger[i] = v;
    return;
  }
  const ux = dx / len;
  const uy = dy / len;
  const ws = weight * s;
  const danger = m.danger;
  for (let i = 0; i < CONTEXT_SLOTS; i++) {
    const dot = SLOT_DIR_X[i]! * ux + SLOT_DIR_Y[i]! * uy;
    if (dot <= 0) continue;
    const v = ws * dot;
    if (v > danger[i]!) danger[i] = v;
  }
}

/**
 * Danger for headings that carry the agent into the line-of-fire lane a→b
 * (half-width `laneHalfWidth`) within `lookahead` distance — friendly-fire
 * avoidance. Outside the lane: a heading that reaches the lane edge after `t`
 * (≤ `lookahead`) at a point within the segment's extent scores
 * `weight · (1 − t / lookahead)`; parallel or departing headings score 0.
 * Inside the lane (alongside the segment): every heading scores
 * `weight · (1 − outward)`, so the straight exit to the nearer edge is best.
 */
export function addDangerFromSegment(
  m: ContextMaps,
  selfX: number,
  selfY: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  laneHalfWidth: number,
  lookahead: number,
  weight: number,
): void {
  if (weight <= 0 || lookahead <= 0) return;
  const abx = bx - ax;
  const aby = by - ay;
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return;
  const tx = abx / len; // lane axis
  const ty = aby / len;
  const nx = -ty; // lane normal (left of a→b)
  const ny = tx;
  const rx = selfX - ax;
  const ry = selfY - ay;
  const h = rx * nx + ry * ny; // signed offset from the lane centre line
  const along = rx * tx + ry * ty; // position along a→b
  const side = h >= 0 ? 1 : -1;
  const absH = h * side;
  const danger = m.danger;

  if (absH < laneHalfWidth) {
    if (along < 0 || along > len) return; // in line but beyond the ends
    for (let i = 0; i < CONTEXT_SLOTS; i++) {
      const outward = side * (SLOT_DIR_X[i]! * nx + SLOT_DIR_Y[i]! * ny);
      const v = weight * (1 - (outward > 0 ? outward : 0));
      if (v > danger[i]!) danger[i] = v;
    }
    return;
  }

  const gap = absH - laneHalfWidth;
  for (let i = 0; i < CONTEXT_SLOTS; i++) {
    const sx = SLOT_DIR_X[i]!;
    const sy = SLOT_DIR_Y[i]!;
    const closing = -side * (sx * nx + sy * ny);
    if (closing <= 1e-6) continue;
    const t = gap / closing;
    if (t > lookahead) continue;
    const hitAlong = along + t * (sx * tx + sy * ty);
    if (hitAlong < -laneHalfWidth || hitAlong > len + laneHalfWidth) continue;
    const v = weight * (1 - t / lookahead);
    if (v > danger[i]!) danger[i] = v;
  }
}

/**
 * Resolve the maps into a desired heading and speed scale (see header).
 * Writes and returns `out`; allocates nothing.
 */
export function resolveContext(m: ContextMaps, out: ContextSteerOutput): ContextSteerOutput {
  const interest = m.interest;
  const danger = m.danger;
  let minDanger = Infinity;
  for (let i = 0; i < CONTEXT_SLOTS; i++) if (danger[i]! < minDanger) minDanger = danger[i]!;
  const limit = minDanger + CONTEXT_DANGER_EPSILON;

  // Best unmasked slot by interest; ties broken by lower danger, then lower index.
  let best = -1;
  let bestInterest = -1;
  for (let i = 0; i < CONTEXT_SLOTS; i++) {
    const d = danger[i]!;
    if (d > limit) continue;
    const v = interest[i]!;
    if (v > bestInterest || (v === bestInterest && best >= 0 && d < danger[best]!)) {
      best = i;
      bestInterest = v;
    }
  }
  // `limit` ≥ minDanger guarantees at least one slot survives the mask.

  // Sub-slot refinement: parabola through (left, centre, right) interest,
  // masked neighbours counted as 0 so the vertex leans only toward safe slots.
  const li = (best + CONTEXT_SLOTS - 1) % CONTEXT_SLOTS;
  const ri = (best + 1) % CONTEXT_SLOTS;
  const l = danger[li]! > limit ? 0 : interest[li]!;
  const r = danger[ri]! > limit ? 0 : interest[ri]!;
  const c = bestInterest;
  const denom = l - 2 * c + r;
  let offset = 0;
  if (denom < -1e-9) {
    offset = (0.5 * (l - r)) / denom;
    if (offset > 0.5) offset = 0.5;
    else if (offset < -0.5) offset = -0.5;
  }
  // Slot index increases with angle; the left neighbour (best − 1) is offset −1.
  let angle = (best + offset) * CONTEXT_SLOT_ANGLE;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  else if (angle <= -Math.PI) angle += 2 * Math.PI;

  const bestDanger = danger[best]!;
  const interestScale = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const dangerScale = bestDanger >= 1 ? 0 : bestDanger <= 0 ? 1 : 1 - bestDanger;

  out.dirX = -Math.sin(angle);
  out.dirY = Math.cos(angle);
  out.angle = angle;
  out.speedScale = interestScale * dangerScale;
  out.slot = best;
  return out;
}
