/**
 * Pure flocking / herding (boids) primitives for non-combat drone movement.
 *
 * The roaming-squad "formation" used to assign each follower a FIXED wedge-slot
 * world point every ~1.5 s and `arrive()` (stop) at it — which read as a static
 * blob, not a formation. This replaces that with continuous leader-led flocking
 * run in the drone brain every tick (60 Hz): a designated leader cruises a
 * course, and each follower steers by the three classic Reynolds rules —
 *   - COHESION   : pull toward the leader, but only beyond a follow-distance (so
 *                  followers trail/surround at a readable radius, never pile on);
 *   - ALIGNMENT  : a constant nudge along the leader's heading (the herd flies as
 *                  one + keeps pace with the moving leader);
 *   - SEPARATION : push away from any squad neighbour closer than a radius (this
 *                  is what spreads the blob into a herd — strongest when closest).
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
/** Nominal herd radius — the reference distance for the catch-up BOOST: a
 *  follower farther than `× FLOCK_BOOST_GAP_FACTOR` from its leader boosts back
 *  in. (Cluster TIGHTNESS itself is set by the cohesion/separation balance.) */
export const FLOCK_FOLLOW_DISTANCE = 200;
/** Neighbours closer than this push each other apart (prevents the clump). */
export const FLOCK_SEPARATION_RADIUS = 130;
/** Per-rule blend weights. Separation > cohesion so the herd spreads rather than
 *  piles; alignment keeps it moving with the leader even when cohesion is 0. */
export const FLOCK_COHESION_GAIN = 1.2;
export const FLOCK_ALIGNMENT_GAIN = 0.6;
export const FLOCK_SEPARATION_GAIN = 1.7;
/** A follower farther than `FLOCK_BOOST_GAP_FACTOR × follow-distance` from its
 *  leader BOOSTS to catch up — the drone analogue of a player holding boost. The
 *  drone's normal AI cruise impulse (`ai.thrust`) is far below a player's, so
 *  without a boost a lagging follower (capped at the same slow cruise) could
 *  never close on a moving leader. The brain applies the kind's REAL player-boost
 *  impulse (`thrustImpulse × boostMultiplier`) while boosting; in-formation it
 *  drops back to the calm roam cruise. */
export const FLOCK_BOOST_GAP_FACTOR = 1.6;

/**
 * COHESION — a constant pull toward an anchor point (the LEADER's position). The
 * herd bunches AROUND the leader; SEPARATION counters it at close range, so the
 * squad settles into a cluster at a stable spacing around the leader (rather than
 * piling on). Constant magnitude (not distance-ramped) — far stragglers are
 * pulled back fast by the BOOST, not by overdriving cohesion. (Cohesion +
 * boost both reference the leader, so a lagging follower boosts TOWARD it.)
 */
export function addCohesion(
  acc: FlockAccumulator,
  selfX: number,
  selfY: number,
  centroidX: number,
  centroidY: number,
  gain: number = FLOCK_COHESION_GAIN,
): void {
  const dx = centroidX - selfX;
  const dy = centroidY - selfY;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  acc.x += (dx / d) * gain;
  acc.y += (dy / d) * gain;
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
 * [0, 1] (the desired-velocity magnitude, capped). Zero vector ⇒ no steer.
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
