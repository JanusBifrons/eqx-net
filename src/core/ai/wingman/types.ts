/**
 * Wingman command vocabulary (RTS command layer, slice 2).
 *
 * A wingman is the AI pilot that flies a ship its owner is not flying. It has:
 *  - a standing MODE (what it does when it has nothing else to do),
 *  - an optional DIRECT ORDER on top (done once, then it resumes the mode from
 *    where it is now),
 *  - a STANCE (when it may open fire; read by the firing slice).
 *
 * Pure data: the server, the client UI and the brain all import these. Wire
 * schemas (zod) for the command messages belong in `src/shared-types` and
 * should mirror these unions.
 */

/** Standing behaviour. Slice 2 implements `defend`; the rest fall back to it. */
export type WingmanMode = 'patrol' | 'defend' | 'hunt' | 'escort' | 'retreat';

export const WINGMAN_MODES: readonly WingmanMode[] = ['patrol', 'defend', 'hunt', 'escort', 'retreat'];

/** When the wingman may fire (consumed by the later firing slice). */
export type WingmanStance = 'aggressive' | 'defensive' | 'holdFire';

export const WINGMAN_STANCES: readonly WingmanStance[] = ['aggressive', 'defensive', 'holdFire'];

/** A one-off order layered on top of the mode. */
export type WingmanOrder =
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | { readonly kind: 'attack'; readonly targetId: string }
  | { readonly kind: 'stop' };

/** What the wingman is doing right now (for status streaming / the UI). */
export type WingmanActivity =
  | 'idle'
  | 'moving'
  | 'patrolling'
  | 'chasing'
  | 'attacking'
  | 'retreating'
  | 'formingUp'
  | 'guarding';

/**
 * The player control bits, exactly what a pilot presses. Structurally the same
 * as `ShipInputArgs` (`physics/applyShipInput.ts`) / `ShipInput` (`World.ts`)
 * minus warp, so it can be handed to the same INPUT path a pilot's keys use.
 */
export interface WingmanControls {
  thrust: boolean;
  reverse: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
}

export function makeWingmanControls(): WingmanControls {
  return { thrust: false, reverse: false, turnLeft: false, turnRight: false, boost: false };
}

/** The ship's own pose this tick. `AiEntity` satisfies it. Game space is Y-up;
 *  the nose points along (-sin angle, cos angle). */
export interface WingmanPose {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly angvel: number;
}

/** Mutable pose buffer the world view writes another entity's pose into. */
export interface WingmanPoseOut {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * What the brain may read about the world. Kept deliberately narrow; later
 * slices add contacts (hunt / auto-target) and the escorted ship.
 */
export interface WingmanWorldView {
  readonly tick: number;
  /** Write entity `id`'s live pose into `out`; false if it is gone. Absent ⇒
   *  nothing can be resolved (an attack order then completes at once). */
  resolvePoseInto?(id: string, out: WingmanPoseOut): boolean;
}

/**
 * The movement stats the control adapter needs. Same values the ship's own
 * `applyShipInput` uses, so the AI flies the hull as a player would.
 * A `ShipKind` supplies all but `reverseAccel` (see {@link reverseAccelFor}).
 */
export interface WingmanShipStats {
  /** Speed cap (u/s), already scaled by any `topSpeed` multiplier. */
  readonly maxSpeed: number;
  /** Rapier linear damping (1/s): the coast decay, helps braking. */
  readonly linearDamping: number;
  /** Snap turn rate (rad/s), already scaled by any `turnRate` multiplier. */
  readonly maxAngvel: number;
  readonly angularDamping: number;
  /** Present on torque-turned (capital) hulls: the turn coasts after release. */
  readonly turnTorque?: number;
  /** Deceleration (u/s²) the reverse key gives this hull. */
  readonly reverseAccel: number;
}

/**
 * Reverse deceleration from the catalogue and the body's mass: `applyShipInput`
 * applies `thrustImpulse · reverseFactor` per 1/60 s tick. The server reads
 * `mass` from `World.getBodyMass(id)`.
 */
export function reverseAccelFor(
  kind: { readonly thrustImpulse: number; readonly reverseFactor: number },
  mass: number,
  topSpeedMul = 1,
): number {
  return mass > 0 ? (kind.thrustImpulse * topSpeedMul * kind.reverseFactor * 60) / mass : 0;
}
