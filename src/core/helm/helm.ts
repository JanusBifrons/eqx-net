/**
 * Helm orders (capital-ship R&D round 3 D): steer a ship to a point at a set
 * speed by producing the ordinary pilot inputs (thrust / turn left / turn
 * right) each tick.
 *
 * The helm runs on the client, before input is sent, so the server and the
 * client prediction receive the same inputs and replay them through the same
 * `applyShipInput`: nothing new to reconcile (#12, #15).
 *
 * The control law follows the physics model (`applyShipInput` +
 * `solveCapitalPhysics`): turn and speed both decay by Rapier damping, so a
 * ship that stops pushing still travels `rate / damping` further. The helm
 * stops turning when the remaining heading error is within that coast angle,
 * and stops thrusting when the remaining distance is within the coast
 * distance, so a slow-to-respond hull settles on its heading and its point
 * instead of overshooting. No allocation: the caller owns `out`.
 *
 * Autopilot (navigation slice 13): an order may carry the server's route
 * (`nav_route`). The helm then passes through each waypoint without slowing,
 * turning onto the next leg a turn's lead before it, and stops only at the
 * last point. Every hull takes helm orders.
 */
import type { ShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

/** Speed settings: stop, one third, two thirds, full. */
export type HelmSpeed = 0 | 1 | 2 | 3;
export const HELM_SPEED_FRACTION: readonly number[] = [0, 1 / 3, 2 / 3, 1];

export interface HelmOrder {
  /** False ⇒ no order: the helm outputs nothing. */
  active: boolean;
  /** Course point (world units). */
  tx: number;
  ty: number;
  speed: HelmSpeed;
  /** The way there (autopilot): waypoints flown in order; absent ⇒ straight at (tx, ty). */
  route?: HelmRoute | null;
}

/** A route the helm flies (caller-owned, reused). */
export interface HelmRoute {
  /** Waypoints packed x, y; the last is the order's point. */
  pts: Float64Array;
  /** Waypoints held. */
  n: number;
  /** The waypoint being flown to; the helm advances it as it passes them. */
  idx: number;
}

export interface HelmPose {
  x: number; y: number; angle: number;
  vx: number; vy: number; angvel: number;
}

/** The kind the helm flies (its handling, and its tuning for the arrival radius). */
export type HelmKind = ShipKind;

export interface HelmOutput {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** Within the arrival radius and nearly stopped: the order is done. */
  arrived: boolean;
}

export function makeHelmOutput(): HelmOutput {
  return { thrust: false, turnLeft: false, turnRight: false, arrived: false };
}

/** Heading error below this is "on course" (rad). */
export const HELM_HEADING_DEADBAND = 0.02;
/** Thrust only while the nose is within this of the course (rad). */
export const HELM_THRUST_CONE = Math.PI / 2;
/** Speed hysteresis: thrust resumes below this fraction of the set speed. */
export const HELM_SPEED_HYSTERESIS = 0.97;

/** Arrival radius: a quarter of the hull, at least the ship's hit radius
 *  (`shipTuning.hitRadius`, scaled with the ship, #18; it was a fixed 20). */
export function helmArriveRadius(kind: HelmKind): number {
  return Math.max(shipTuning(kind).hitRadius, kind.radius * 0.25);
}

/** Fraction of the turning radius a waypoint is passed early: a 45° turn's
 *  lead (tan 22.5° ≈ 0.41), the sharpest a capital's route makes in a lane. */
export const HELM_PASS_TURN_LEAD = 0.41;

/** How near a waypoint counts as passed at `speed`: the turn's lead, at least twice the arrival radius. */
export function helmPassRadius(kind: HelmKind, speed: number): number {
  const turn = kind.maxAngvel > 0 ? speed / kind.maxAngvel : 0;
  return Math.max(2 * helmArriveRadius(kind), HELM_PASS_TURN_LEAD * turn);
}

function wrapPi(a: number): number {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Is the course point inside the circle the ship sweeps turning towards it at
 * full rate and its current speed (radius speed / maxAngvel)? Then thrusting
 * only orbits it: a battleship (1.2°/s) at full speed sweeps ~8 km, so a tap
 * beside it on screen was never reached (showcase player-capital-sector
 * 2026-11-17). The helm coasts instead until the circle shrinks past it.
 */
export function insideTurnCircle(
  pose: HelmPose, fx: number, fy: number, speed: number, err: number, tx: number, ty: number, maxAngvel: number,
): boolean {
  if (maxAngvel <= 0 || err === 0) return false;
  const r = speed / maxAngvel;
  // Left of forward (-sin, cos) is (-cos, -sin) = (-fy, fx); err > 0 turns left.
  const side = err > 0 ? 1 : -1;
  const cx = pose.x - fy * r * side, cy = pose.y + fx * r * side;
  const ex = tx - cx, ey = ty - cy;
  return ex * ex + ey * ey < r * r;
}

/**
 * One tick of the helm. `out` carries the previous tick's thrust bit (the
 * speed hysteresis) and is overwritten with this tick's inputs.
 */
export function helmStep(order: HelmOrder, pose: HelmPose, kind: HelmKind, out: HelmOutput): HelmOutput {
  const wasThrusting = out.thrust;
  out.thrust = false; out.turnLeft = false; out.turnRight = false; out.arrived = false;
  if (!order.active) return out;

  const speed = Math.sqrt(pose.vx * pose.vx + pose.vy * pose.vy);
  // The leg flown now: the route's next waypoint, or the order's point.
  let tx = order.tx, ty = order.ty, last = true;
  const r = order.route;
  if (r != null && r.idx < r.n - 1) {
    const pass = helmPassRadius(kind, speed);
    while (r.idx < r.n - 1 && Math.hypot(r.pts[2 * r.idx]! - pose.x, r.pts[2 * r.idx + 1]! - pose.y) <= pass) r.idx++;
    if (r.idx < r.n - 1) { tx = r.pts[2 * r.idx]!; ty = r.pts[2 * r.idx + 1]!; last = false; }
  }
  const dx = tx - pose.x, dy = ty - pose.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Forward is (-sin θ, cos θ) (see applyShipInput), so the course heading is:
  const fx = -Math.sin(pose.angle), fy = Math.cos(pose.angle);
  const vFwd = pose.vx * fx + pose.vy * fy;
  const arrive = helmArriveRadius(kind);

  if (last && dist <= arrive) {
    out.arrived = speed < kind.maxSpeed * 0.05;
    return out; // on station: coast to a stop
  }

  // --- Turn: aim at the point, coasting out the turn rate before the course.
  const err = wrapPi(Math.atan2(-dx, dy) - pose.angle);
  const w = pose.angvel;
  const coastAngle = kind.angularDamping > 0 ? Math.abs(w) / kind.angularDamping : 0;
  const turningTowards = (w > 0 && err > 0) || (w < 0 && err < 0);
  if (Math.abs(err) > HELM_HEADING_DEADBAND && !(turningTowards && Math.abs(err) <= coastAngle)) {
    if (err > 0) out.turnLeft = true; else out.turnRight = true;
  }

  // --- Speed: hold the set speed, and stop pushing once the coast carries
  // the ship to the point.
  const set = (HELM_SPEED_FRACTION[order.speed] ?? 0) * kind.maxSpeed;
  const coastDist = kind.linearDamping > 0 ? Math.max(0, vFwd) / kind.linearDamping : 0;
  // Aim the coast at the point itself, so the ship ends inside the arrival
  // radius rather than on its rim.
  const braking = last && dist <= coastDist; // a waypoint is passed, not stopped at
  const threshold = wasThrusting ? set : set * HELM_SPEED_HYSTERESIS;
  out.thrust = set > 0 && !braking && Math.abs(err) < HELM_THRUST_CONE && vFwd < threshold
    && !insideTurnCircle(pose, fx, fy, speed, err, tx, ty, kind.maxAngvel);
  return out;
}
