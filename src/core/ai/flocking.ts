/**
 * Pure flocking / herding (boids) primitives for non-combat drone movement.
 *
 * The roaming-squad "formation" used to assign each follower a FIXED wedge-slot
 * world point every ~1.5 s and `arrive()` (stop) at it — which read as a static
 * blob, not a formation. This replaces that with continuous leader-led flocking
 * run in the drone brain every tick (60 Hz): a designated leader cruises a
 * course, and each follower steers by the three classic Reynolds rules —
 *   - COHESION   : pull toward the leader, with an ARRIVAL ramp so the follower
 *                  SLOWS as it nears the follow-distance (standard "arrive"
 *                  behaviour — it doesn't barrel through the leader);
 *   - ALIGNMENT  : a constant nudge along the leader's heading (the herd flies as
 *                  one + keeps pace with the moving leader);
 *   - SEPARATION : push away from any squad neighbour closer than a radius (this
 *                  is what spreads the blob into a herd — strongest when closest).
 *
 * There is NO boost. Followers move at the calm AI cruise (`ai.thrust`); the
 * arrival ramp + per-kind damping settle them into the cluster with no overshoot.
 * The catch-up problem (a follower can't outrun a leader moving at the same max
 * speed) is solved on the DIRECTOR side instead — the leader is THROTTLED and
 * WAITS when the squad is spread, so the flock keeps up (see
 * `HostileDroneBehaviour` `LEADER_CRUISE_THROTTLE` + `LivingWorldDirector.flockStep`).
 *
 * Zone-pure (src/core): scalar in / caller-owned accumulator + out (allocation-
 * free, invariant #14), deterministic. Game-space is Y-up; the ship-forward
 * convention is `(-sin θ, cos θ)` (matches steering.ts / HostileDroneBehaviour).
 *
 * Usage (alloc-free) per follower per tick:
 *   resetFlock(acc);
 *   addCohesion(acc, sx, sy, leaderX, leaderY);
 *   addAlignment(acc, leaderAngle);
 *   for (neighbour) addSeparation(acc, sx, sy, nX, nY);
 *   resolveFlock(acc, out);   // → unit dir + thrustScale
 */

/** A reusable desired-velocity accumulator (the boids vector sum). */
export interface FlockAccumulator {
  x: number;
  y: number;
}

/** The resolved steer: a unit desired-heading direction + a forward-thrust
 *  scale in [0, 1]. Same consumer contract as `steering.ts` `SteerOutput`. */
export interface FlockOutput {
  dirX: number;
  dirY: number;
  thrustScale: number;
}

export function makeFlockAccumulator(): FlockAccumulator {
  return { x: 0, y: 0 };
}

export function makeFlockOutput(): FlockOutput {
  return { dirX: 0, dirY: 0, thrustScale: 0 };
}

export function resetFlock(acc: FlockAccumulator): void {
  acc.x = 0;
  acc.y = 0;
}

// ── FEEL constants (tune on-device — the boids weights/radii) ───────────────
/** The follow-distance: within this range of the leader the COHESION pull ramps
 *  down toward 0 (arrival), so followers trail/surround at a readable radius and
 *  SLOW as they arrive rather than piling onto the leader. Also the director's
 *  reference for whether the squad has "gathered". */
export const FLOCK_FOLLOW_DISTANCE = 220;
/** Neighbours closer than this push each other apart (prevents the clump). Set
 *  below FOLLOW_DISTANCE so the stable band (separation floor → cohesion-zero) is
 *  a real spacing, not a single point. */
export const FLOCK_SEPARATION_RADIUS = 150;
/** Per-rule blend weights. Cohesion ≥ separation so the herd actually bunches;
 *  alignment keeps it moving with the leader even when cohesion has ramped to 0
 *  at the follow-distance. */
export const FLOCK_COHESION_GAIN = 1.4;
export const FLOCK_ALIGNMENT_GAIN = 0.6;
export const FLOCK_SEPARATION_GAIN = 1.3;

/**
 * COHESION — pull toward an anchor point (the LEADER's position) with an ARRIVAL
 * ramp: FULL `gain` while farther than `FLOCK_FOLLOW_DISTANCE`, then linearly
 * ramped down to 0 as the follower closes inside it. This is the textbook
 * "arrive" slow-down — the follower decelerates its inward pull as it reaches
 * the follow-radius instead of overshooting through the leader. SEPARATION
 * counters it at close range, so the squad settles into a cluster at a stable
 * spacing AROUND the leader (between the separation floor and the follow radius).
 */
export function addCohesion(
  acc: FlockAccumulator,
  selfX: number,
  selfY: number,
  leaderX: number,
  leaderY: number,
  gain: number = FLOCK_COHESION_GAIN,
  followDistance: number = FLOCK_FOLLOW_DISTANCE,
): void {
  const dx = leaderX - selfX;
  const dy = leaderY - selfY;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  // Arrival ramp: full pull beyond the follow-distance, linearly to 0 within it.
  const ramp = d >= followDistance ? 1 : d / followDistance;
  const s = ramp * gain;
  acc.x += (dx / d) * s;
  acc.y += (dy / d) * s;
}

/**
 * ALIGNMENT — a constant push along the leader's forward heading
 * (`(-sin, cos)`), so the herd flies the leader's way + keeps pace with it.
 */
export function addAlignment(
  acc: FlockAccumulator,
  leaderAngle: number,
  gain: number = FLOCK_ALIGNMENT_GAIN,
): void {
  acc.x += -Math.sin(leaderAngle) * gain;
  acc.y += Math.cos(leaderAngle) * gain;
}

/**
 * SEPARATION — push away from one neighbour, strength `(1 - d/radius) × gain`
 * (strongest at contact, 0 at the radius). A coincident neighbour gets a
 * deterministic +x nudge so two stacked drones still separate.
 */
export function addSeparation(
  acc: FlockAccumulator,
  selfX: number,
  selfY: number,
  neighbourX: number,
  neighbourY: number,
  radius: number = FLOCK_SEPARATION_RADIUS,
  gain: number = FLOCK_SEPARATION_GAIN,
): void {
  const dx = selfX - neighbourX;
  const dy = selfY - neighbourY;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    acc.x += gain; // exactly stacked — deterministic break-apart push
    return;
  }
  if (d >= radius) return;
  const s = (1 - d / radius) * gain;
  acc.x += (dx / d) * s;
  acc.y += (dy / d) * s;
}

/**
 * Resolve the accumulated boids vector into a unit heading + a thrust scale in
 * [0, 1] (the desired-velocity magnitude, capped at 1). Zero vector ⇒ no steer.
 * Because cohesion arrival-ramps to 0 and separation cancels it near the
 * follow-radius, a settled follower's vector shrinks toward the alignment term
 * alone — so it eases off thrust ("slow down once close") without any boost.
 */
export function resolveFlock(acc: FlockAccumulator, out: FlockOutput): FlockOutput {
  const m = Math.hypot(acc.x, acc.y);
  if (m < 1e-6) {
    out.dirX = 0;
    out.dirY = 0;
    out.thrustScale = 0;
    return out;
  }
  out.dirX = acc.x / m;
  out.dirY = acc.y / m;
  out.thrustScale = m > 1 ? 1 : m;
  return out;
}
