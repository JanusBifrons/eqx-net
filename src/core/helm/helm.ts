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
 */

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
}

export interface HelmPose {
  x: number; y: number; angle: number;
  vx: number; vy: number; angvel: number;
}

/** The kind fields the helm reads (a `ShipKind` satisfies it). */
export interface HelmKind {
  radius: number;
  maxSpeed: number;
  linearDamping: number;
  angularDamping: number;
}

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

/** Arrival radius: a quarter of the hull, at least 20 u. */
export function helmArriveRadius(kind: HelmKind): number {
  return Math.max(20, kind.radius * 0.25);
}

function wrapPi(a: number): number {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * One tick of the helm. `out` carries the previous tick's thrust bit (the
 * speed hysteresis) and is overwritten with this tick's inputs.
 */
export function helmStep(order: HelmOrder, pose: HelmPose, kind: HelmKind, out: HelmOutput): HelmOutput {
  const wasThrusting = out.thrust;
  out.thrust = false; out.turnLeft = false; out.turnRight = false; out.arrived = false;
  if (!order.active) return out;

  const dx = order.tx - pose.x, dy = order.ty - pose.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Forward is (-sin θ, cos θ) (see applyShipInput), so the course heading is:
  const fx = -Math.sin(pose.angle), fy = Math.cos(pose.angle);
  const vFwd = pose.vx * fx + pose.vy * fy;
  const speed = Math.sqrt(pose.vx * pose.vx + pose.vy * pose.vy);
  const arrive = helmArriveRadius(kind);

  if (dist <= arrive) {
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
  const braking = dist <= coastDist;
  const threshold = wasThrusting ? set : set * HELM_SPEED_HYSTERESIS;
  out.thrust = set > 0 && !braking && Math.abs(err) < HELM_THRUST_CONE && vFwd < threshold;
  return out;
}
