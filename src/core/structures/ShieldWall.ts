/**
 * Shield-wall math — zone-pure (shield-fence plan). A shield wall is the
 * blocking energy span a PAIR of `shield_pylon`s projects between them. It is
 * deliberately NOT a catalogue kind and NOT a swarm/wire entity: its geometry is
 * DERIVED on both sides from the two pylon poses (so the server collider, the
 * client predWorld collider, and the rendered span all agree without shipping a
 * variable-length entity), and its survivability is grid-power-driven rather than
 * an HP pool.
 *
 * This module owns the PURE pieces — span geometry, the grid-power hit
 * resolution, the active-state predicate, and the unordered pair key. The server
 * `ShieldWallManager` orchestrates the live walls and drives the physics
 * collider; the client derives the same geometry for prediction + render.
 *
 * Modelled on eqx-peri's `ShieldWall` + `GridManager.resolveShieldWallDamage`,
 * adapted to eqx-net: eqx-peri drains BATTERIES then power-spikes the posts; here
 * the component's instantaneous power surplus is a free buffer, batteries are the
 * depletable buffer, and overwhelming both stuns the wall.
 */

/** Collider thickness of the wall span, world units. Wide enough that a
 *  full-thrust ship can't tunnel the static cuboid at the 60 Hz step. */
export const SHIELD_WALL_THICKNESS = 20;

/** How long a wall stays stunned (non-blocking) after its buffer is overwhelmed,
 *  ms. eqx-peri's `SHIELD_WALL_STUN_MS`. */
export const SHIELD_WALL_STUN_MS = 5000;

export interface WallGeometry {
  midX: number;
  midY: number;
  /** Distance between the two pylon centres (the cuboid's full length). */
  length: number;
  /** Span heading, radians (game space, atan2(dy, dx)). */
  angle: number;
}

/** Span geometry from the two pylon poses (game space). Computed identically on
 *  server + client so every consumer (collider, render) agrees. */
export function wallGeometry(ax: number, ay: number, bx: number, by: number): WallGeometry {
  const dx = bx - ax;
  const dy = by - ay;
  return {
    midX: (ax + bx) / 2,
    midY: (ay + by) / 2,
    length: Math.hypot(dx, dy),
    angle: Math.atan2(dy, dx),
  };
}

export interface WallHitResult {
  /** How much to drain from the component's batteries. */
  batteryDrain: number;
  /** True when the buffer was overwhelmed → the wall stuns. */
  stun: boolean;
}

/**
 * Resolve a weapon hit on an ACTIVE wall (the grid-power model): the component's
 * instantaneous power SURPLUS absorbs the hit for free; the EXCESS drains the
 * component's batteries; exceeding both overwhelms the wall → STUN (and the
 * batteries empty). Pure — the caller supplies the live component `netPower` (raw
 * generation balance) + total battery charge, then applies `batteryDrain` and
 * stuns on `stun`.
 */
export function resolveWallHit(
  damage: number,
  netPower: number,
  batteryCharge: number,
): WallHitResult {
  if (damage <= 0) return { batteryDrain: 0, stun: false };
  const surplus = netPower > 0 ? netPower : 0;
  const overSurplus = damage - surplus;
  if (overSurplus <= 0) return { batteryDrain: 0, stun: false }; // surplus alone held
  const batteryDrain = batteryCharge < overSurplus ? batteryCharge : overSurplus;
  return { batteryDrain, stun: overSurplus > batteryCharge };
}

/** A wall blocks (its collider is live) only while POWERED and not stunned. */
export function isWallActive(powered: boolean, stunnedUntilMs: number, nowMs: number): boolean {
  return powered && nowMs >= stunnedUntilMs;
}

/** Stable unordered pair key for the wall between two pylon ids. */
export function wallPairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

/**
 * Distance along a UNIT ray `(ox,oy) + t·(dx,dy)` at which it first crosses the
 * segment A→B, or null if it never does (parallel, or the crossing is behind the
 * origin / off the segment). `(dx,dy)` MUST be unit length so `t` is a world
 * distance. Used to absorb a beam at a wall span (a thin segment for hitscan).
 */
export function rayCrossesSegment(
  ox: number, oy: number, dx: number, dy: number,
  ax: number, ay: number, bx: number, by: number,
): number | null {
  const ex = bx - ax;
  const ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-9) return null; // parallel to the wall
  const cx = ax - ox;
  const cy = ay - oy;
  const t = (cx * ey - cy * ex) / denom; // distance along the ray
  const u = (cx * dy - cy * dx) / denom; // param along the segment [0,1]
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return null;
}
