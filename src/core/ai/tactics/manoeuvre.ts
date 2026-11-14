/**
 * Decision layer contracts (AI overhaul slice 4, plan composed-harbor §3).
 *
 * A manoeuvre is one way of fighting a target (tail it, dive through it,
 * break away, hold a stand-off). Each tick the running manoeuvre writes its
 * goal as INTEREST into the brain's context maps and fills a {@link
 * ManoeuvreGoal} (speed, facing mode, boost); the brain then adds neighbour
 * danger, resolves, and flies the result through the virtual pilot. Which
 * manoeuvre runs is the utility picker's call (`utility.ts`).
 *
 * New manoeuvres implement {@link IManoeuvre} (Open/Closed); the brain never
 * switches on what a manoeuvre does. Instances are preallocated per brain and
 * the context is a reused scratch struct: nothing here allocates per tick (#14).
 */
import type { ContextMaps } from '../contextSteering.js';
import { Rng } from '../../random/rng.js';

/** Manoeuvre ids (dense, used as array indices and the test-visible value). */
export const MANOEUVRE_HOLD = 0;
export const MANOEUVRE_TAIL = 1;
export const MANOEUVRE_ATTACK_RUN = 2;
export const MANOEUVRE_BREAK = 3;
/** Slice 6b: circle at the band edge (gunships, robots), hold the band nose
 *  on (missile boats), and the two morale outcomes. FallBack and Flee are
 *  never scored: only a morale roll starts them. */
export const MANOEUVRE_ORBIT = 4;
export const MANOEUVRE_KITE = 5;
export const MANOEUVRE_FALL_BACK = 6;
export const MANOEUVRE_FLEE = 7;
export const MANOEUVRE_COUNT = 8;
export type ManoeuvreId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Facing mode of a goal: nose on the lead point, nose along the move, or the
 *  brain's own rule (lead in range, move when repositioning). */
export const FACE_AUTO = 0;
export const FACE_AIM_LEAD = 1;
export const FACE_MOVE = 2;
export type FacingMode = 0 | 1 | 2;

/** What a manoeuvre asks for this tick (besides the interest it wrote). */
export interface ManoeuvreGoal {
  /** Wanted speed along the resolved heading (u/s). */
  speed: number;
  facing: FacingMode;
  /** The manoeuvre allows boost (the pilot and the energy pool still decide). */
  boost: boolean;
  /** Boost may dip into the energy reserve (a ship running from a tailer
   *  burns everything it has). The brain clears it before each `writeGoal`,
   *  so only a manoeuvre that sets it gets it. */
  spendReserve: boolean;
}

export function makeManoeuvreGoal(): ManoeuvreGoal {
  return { speed: 0, facing: FACE_AUTO, boost: false, spendReserve: false };
}

/**
 * Everything a manoeuvre or the utility scorer reads, refreshed by the brain
 * each combat tick (one struct per brain, written in place). Unit vectors are
 * zero when undefined (target on top of us, target not moving).
 */
export interface TacticalContext {
  tick: number;
  // Self.
  x: number; y: number; vx: number; vy: number;
  /** Ship angle; forward is (-sin, cos). */
  angle: number;
  fwdX: number; fwdY: number;
  // Target.
  tx: number; ty: number; tvx: number; tvy: number;
  /** Target is a ship (false for a structure: it never runs or turns). */
  targetIsShip: boolean;
  /** Distance to the target, and the unit line self → target. */
  dist: number;
  ux: number; uy: number;
  /** Lead (intercept) point and the facing that points at it. */
  aimX: number; aimY: number;
  leadAngle: number;
  /** |nose − lead bearing| (rad, 0..π). */
  offBoresight: number;
  /** Rate the gap shrinks (u/s, + closing). */
  closing: number;
  /** cos(target's velocity, target → self): −1 when I sit right behind it,
   *  +1 when it flies straight at me; 0 when it is barely moving. */
  targetAspectCos: number;
  /** cos(my nose, self → target): −1 when the target sits right behind me. */
  threatBearingCos: number;
  /** cos(the target's nose, target → self): +1 when it points straight at me.
   *  1 when its facing is unknown (assume its guns may bear). */
  targetBowCos: number;
  // Weapons and handling.
  fireRange: number;
  cruiseSpeed: number;
  maxSpeed: number;
  /** The kind's handling (the ship's own numbers, never the pilot's): turn cap
   *  (rad/s), thrust and reverse acceleration (u/s², without boost), and
   *  the hull radius (#18), so ranges follow speed, agility and size. */
  maxAngvel: number;
  accel: number;
  brakeAccel: number;
  radius: number;
  /** `shipTuning(kind).attackRunOvershoot` (#18). */
  overshoot: number;
  // Condition.
  /** Hull fraction 0..1 (1 when unknown). */
  hullFrac: number;
  /** Hits taken lately (decaying count, ~1 s half-life). */
  recentHits: number;
  /** Shots the line-of-fire gate held lately (decaying, 0.5 s half-life;
   *  `HostileDroneBehaviour.getRecentBlocks`). Slice 5b, `fireLanes.ts`. */
  recentBlocks: number;
  /** Same-side / enemy ships near me (grid count at decision time). */
  allies: number;
  enemies: number;
  // Slice 6b: band, turret arcs and the sensor picture.
  /** The role's preferred band in world units (`rangeBand × fireRange`). */
  bandMin: number;
  bandMax: number;
  /** Widest rotating mount's half-arc (rad; 0 for fixed-forward guns). */
  turretHalfArc: number;
  /** `roleSensorRange` (world units). */
  sensorRange: number;
  /** Refreshed at decision time from the neighbour grid within sensor range:
   *  enemies seen, their centroid weighted by hull radius, and the fall-back
   *  anchor (nearest friendly capital, else the centroid of same-side ships;
   *  `hasAnchor` false when alone). */
  sensorEnemies: number;
  threatX: number;
  threatY: number;
  hasAnchor: boolean;
  anchorX: number;
  anchorY: number;
  /** Today's stand-off decision (the Hold goal): wanted speed along the
   *  target line (+ closing) and whether it may boost. */
  holdAlong: number;
  holdBoost: boolean;
  /** Per-ship seeded stream (mulberry32, reseeded from the entity id). */
  readonly rng: Rng;
}

export function makeTacticalContext(): TacticalContext {
  return {
    tick: 0,
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, fwdX: 0, fwdY: 1,
    tx: 0, ty: 0, tvx: 0, tvy: 0, targetIsShip: true,
    dist: 0, ux: 0, uy: 0, aimX: 0, aimY: 0, leadAngle: 0, offBoresight: 0,
    closing: 0, targetAspectCos: 0, threatBearingCos: 0, targetBowCos: 1,
    fireRange: 1, cruiseSpeed: 1, maxSpeed: 1, overshoot: 1,
    maxAngvel: 1, accel: 1, brakeAccel: 1, radius: 1,
    hullFrac: 1, recentHits: 0, recentBlocks: 0, allies: 0, enemies: 0,
    bandMin: 0, bandMax: 1, turretHalfArc: 0, sensorRange: 1,
    sensorEnemies: 0, threatX: 0, threatY: 0, hasAnchor: false, anchorX: 0, anchorY: 0,
    holdAlong: 0, holdBoost: false,
    rng: new Rng(1),
  };
}

/** A target moving slower than this share of MY cruise speed is parked: it
 *  has no heading, no six to sit on, and cannot be tailing me (~14 u/s for a
 *  fighter at cruise ~141 u/s; a pilot who lets go of the stick drifts under
 *  it within seconds of linear damping). */
export const PARKED_SPEED_FRAC = 0.1;

/** Is the target parked (below `PARKED_SPEED_FRAC` × my cruise)? */
export function targetParked(ctx: TacticalContext): boolean {
  const v = PARKED_SPEED_FRAC * ctx.cruiseSpeed;
  return ctx.tvx * ctx.tvx + ctx.tvy * ctx.tvy <= v * v;
}

/** A target moving slower than this share of MY cruise speed is slow: I
 *  outrun it by twice its speed or more, so the strafing run's dive, pass and
 *  swing-round come round fast enough, and the picker flies them as on a
 *  parked target (owner 2026-11-13/14: no toe-to-toe slugging). A ship's own
 *  number (its cruise), never a fixed u/s. Not higher: at 0.75 a fighter
 *  (sustained ~141–160 u/s) strafing a pilot at 90 u/s closed from behind at
 *  35–60 u/s and managed one pass in 30 s, and a robot (cruise 121) slowing
 *  in a turn turned the on-sight duel into straight runs (mean turn rate
 *  0.25 rad/s against the 0.35 bar). Faster targets are tailed; the Tail's
 *  close station and the face-off rule keep that out of formation. */
export const SLOW_SPEED_FRAC = 0.5;

/** Is the target slow (below `SLOW_SPEED_FRAC` × my cruise)? Every parked
 *  target is slow. */
export function targetSlow(ctx: TacticalContext): boolean {
  const v = SLOW_SPEED_FRAC * ctx.cruiseSpeed;
  return ctx.tvx * ctx.tvx + ctx.tvy * ctx.tvy < v * v;
}

/** A ship's guns bear on what sits within this cos of its bow (~60°): the
 *  heavy-fire Break rule's arc (`HEAVY_FIRE_BOW_COS`), applied from either
 *  side. */
export const GUNS_BEAR_COS = 0.5;


/** Uniform float in [0, 1) from the context's stream. */
export function rngUnit(ctx: TacticalContext): number {
  return ctx.rng.u32() / 4294967296;
}

/** One way of fighting a target. Stateful per brain; never allocates. */
export interface IManoeuvre {
  readonly id: ManoeuvreId;
  /** Called once when the picker switches to this manoeuvre. */
  begin(ctx: TacticalContext): void;
  /** Write this tick's interest into `maps` (already cleared) and fill `out`. */
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void;
  /** True once the manoeuvre has run its course (the picker then re-decides
   *  at once). Open-ended manoeuvres return false. */
  isDone(ctx: TacticalContext): boolean;
}
