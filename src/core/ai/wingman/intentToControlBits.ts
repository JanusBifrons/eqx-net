/**
 * Intent → player control bits (RTS command layer, slice 2).
 *
 * The owner's rule: AI ships fly with PLAYER CONTROLS ONLY. A wingman brain
 * decides a desired velocity; this adapter turns it into the keys a pilot
 * would hold this tick (thrust / reverse / turn left / turn right / boost),
 * which then go through the same `applyShipInput` as a pilot's keys. No AI
 * forces, same stats, same speed cap.
 *
 * Control law:
 *  - Desired speed ~0 ⇒ brake without turning: reverse while moving forward,
 *    thrust while moving backward, down to {@link brakeBand} (lateral grip
 *    bleeds sideways drift).
 *  - Otherwise turn toward the desired heading (a deadband of half a tick's
 *    turn on snap-turn hulls; the helm's coast angle on torque-turned hulls),
 *    thrust while roughly facing it and below the desired speed, reverse
 *    when faster than wanted (overshoot / closing in) or when facing away
 *    while still moving forward.
 *  - Boost only when asked, well aligned and already thrusting.
 *
 * Pure and allocation-free: the caller owns `out`.
 */
import type { WingmanControls, WingmanPose, WingmanShipStats } from './types.js';

/** What the brain wants this tick. Velocity in world u/s (Y-up). */
export interface ControlIntent {
  dvx: number;
  dvy: number;
  /** The brain allows boost (long leg). The adapter still gates it on facing. */
  boost: boolean;
}

export function makeControlIntent(): ControlIntent {
  return { dvx: 0, dvy: 0, boost: false };
}

/** Thrust only while the nose is within this of the desired heading (rad). */
export const CONTROL_THRUST_CONE = 0.5;
/** Boost only while the nose is within this of the desired heading (rad). */
export const CONTROL_BOOST_CONE = 0.15;
/** Minimum heading deadband (rad). */
export const CONTROL_HEADING_DEADBAND = 0.02;
/** Speed band (fraction of max speed) around the desired speed with no push. */
export const CONTROL_SPEED_BAND = 0.02;
/** Below this fraction of max speed a desired velocity means "stop". */
export const CONTROL_STOP_FRAC = 0.01;
/**
 * Longest time one control decision may be held (s): the fleet re-plans every
 * `FLEET_REPLAN_EVERY_TICKS` (6) ticks and the worker holds the last INPUT in
 * between. A brake in place pushes until the forward speed is inside half of
 * what one held key removes, so a held key can't overshoot into chatter, yet
 * nothing is left to crawl on. (The old 2 %-of-max-speed band left a 2×
 * fighter coasting at ~10 u/s for seconds after Stop: RTS stop drift,
 * 2026-11-14.)
 */
export const CONTROL_HOLD_S = 0.1;
/** Smallest brake band (u/s). */
export const CONTROL_BRAKE_BAND_MIN = 0.5;

/** The forward-speed band a brake in place leaves alone (u/s). */
export function brakeBand(stats: WingmanShipStats): number {
  return Math.max(CONTROL_BRAKE_BAND_MIN, stats.reverseAccel * CONTROL_HOLD_S * 0.5);
}

const TICK_S = 1 / 60;

export function wrapPi(a: number): number {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Ship angle whose nose points along (dx, dy): nose = (-sin θ, cos θ). */
export function headingOf(dx: number, dy: number): number {
  return Math.atan2(-dx, dy);
}

export function intentToControlBits(
  intent: ControlIntent,
  pose: WingmanPose,
  stats: WingmanShipStats,
  out: WingmanControls,
): WingmanControls {
  out.thrust = false; out.reverse = false; out.turnLeft = false; out.turnRight = false; out.boost = false;

  const fx = -Math.sin(pose.angle), fy = Math.cos(pose.angle);
  const vFwd = pose.vx * fx + pose.vy * fy;
  const band = Math.max(1, stats.maxSpeed * CONTROL_SPEED_BAND);
  const want = Math.sqrt(intent.dvx * intent.dvx + intent.dvy * intent.dvy);

  if (want < stats.maxSpeed * CONTROL_STOP_FRAC) {
    // Brake in place: no turning, push against the forward motion down to
    // what one held key can remove (lateral grip bleeds sideways drift).
    const bb = brakeBand(stats);
    if (vFwd > bb) out.reverse = true;
    else if (vFwd < -bb) out.thrust = true;
    return out;
  }

  // --- Turn toward the desired heading.
  const err = wrapPi(headingOf(intent.dvx, intent.dvy) - pose.angle);
  const absErr = Math.abs(err);
  const torqueTurn = stats.turnTorque !== undefined && stats.turnTorque > 0;
  let deadband: number;
  if (torqueTurn) {
    // A torque-turned hull keeps turning after release: stop pushing once the
    // coast carries it onto the heading (same rule as the helm).
    const w = pose.angvel;
    const coast = stats.angularDamping > 0 ? Math.abs(w) / stats.angularDamping : 0;
    const turningTowards = (w > 0 && err > 0) || (w < 0 && err < 0);
    deadband = turningTowards ? Math.max(CONTROL_HEADING_DEADBAND, coast) : CONTROL_HEADING_DEADBAND;
  } else {
    // A snap-turn hull turns maxAngvel/60 a tick and stops on release: turn
    // only while the error is more than half a tick's turn, so it never chatters.
    deadband = Math.max(CONTROL_HEADING_DEADBAND, stats.maxAngvel * TICK_S * 0.5);
  }
  if (absErr > deadband) {
    if (err > 0) out.turnLeft = true; else out.turnRight = true;
  }

  // --- Speed along the nose.
  if (absErr < CONTROL_THRUST_CONE) {
    // Roughly facing: aim the forward speed at the desired speed, reduced by
    // how far off-axis we still are (cos of the error).
    const target = want * Math.cos(absErr);
    if (vFwd < target - band) out.thrust = true;
    else if (vFwd > target + band) out.reverse = true;
  } else if (absErr > Math.PI / 2) {
    // Facing away: any forward motion is away from where we want to go.
    if (vFwd > band) out.reverse = true;
  } else if (vFwd > want + band) {
    // Side-on and too fast: shed speed while the turn comes round.
    out.reverse = true;
  }

  out.boost = intent.boost && out.thrust && absErr < CONTROL_BOOST_CONE;
  return out;
}
