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
import type { AiEntity } from '../../contracts/IAiBehaviour.js';
import type { ShipKind } from '../../../shared-types/shipKinds.js';
import type { PilotHandling, PilotParams } from '../virtualPilot.js';

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
  /** The throttle must change at once (an attack run opening the range from
   *  nose to nose: thrust held on toward the target for the combat throttle
   *  hold flew it ~8 ticks the wrong way). The pilot skips its throttle hold;
   *  cleared before each `writeGoal` like `spendReserve`. */
  throttleNow: boolean;
}

export function makeManoeuvreGoal(): ManoeuvreGoal {
  return { speed: 0, facing: FACE_AUTO, boost: false, spendReserve: false, throttleNow: false };
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
  /** The target's nose (unit); (0, 0) when its facing is unknown. */
  tFwdX: number; tFwdY: number;
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
  /** `shipTuning(kind).shieldPad`: ships collide as their shield bubbles
   *  (hull radius + pad), see `hullClearance` (#18). */
  shieldPad: number;
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
  /** The target was under the parked / slow bar within the last
   *  `TARGET_STILL_MEMORY_S` (the brain's memory of it, reset when the target
   *  changes): `targetParked` / `targetSlow` count it still while true. */
  tParkedHeld: boolean;
  tSlowHeld: boolean;
  /** The target's speed as `targetSlow` reads it: the brain's smoothed
   *  value (u/s), or −1 to use the raw velocity (tests, scratch). */
  targetSpeed: number;
  /** Per-ship seeded stream (mulberry32, reseeded from the entity id). */
  readonly rng: Rng;
}

export function makeTacticalContext(): TacticalContext {
  return {
    tick: 0,
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, fwdX: 0, fwdY: 1,
    tx: 0, ty: 0, tvx: 0, tvy: 0, targetIsShip: true,
    dist: 0, ux: 0, uy: 0, aimX: 0, aimY: 0, leadAngle: 0, offBoresight: 0,
    closing: 0, targetAspectCos: 0, threatBearingCos: 0, targetBowCos: 1, tFwdX: 0, tFwdY: 0,
    fireRange: 1, cruiseSpeed: 1, maxSpeed: 1, overshoot: 1,
    maxAngvel: 1, accel: 1, brakeAccel: 1, radius: 1, shieldPad: 0,
    hullFrac: 1, recentHits: 0, recentBlocks: 0, allies: 0, enemies: 0,
    bandMin: 0, bandMax: 1, turretHalfArc: 0, sensorRange: 1,
    sensorEnemies: 0, threatX: 0, threatY: 0, hasAnchor: false, anchorX: 0, anchorY: 0,
    holdAlong: 0, holdBoost: false,
    tParkedHeld: false, tSlowHeld: false, targetSpeed: -1,
    rng: new Rng(1),
  };
}

/** A target moving slower than this share of MY cruise speed is parked: it
 *  has no heading, no six to sit on, and cannot be tailing me (~14 u/s for a
 *  fighter at cruise ~141 u/s; a pilot who lets go of the stick drifts under
 *  it within seconds of linear damping). */
export const PARKED_SPEED_FRAC = 0.1;

/** A parked or slow target counts as one until it has stayed above the bar
 *  this long (s): a nudge is not a getaway. Judged on the instant, a pilot
 *  who sat still and lurched 40–150 u toward a robot for ~0.5 s each time it
 *  drew off (the filmed fleet-melee script, take 6, 2026-11-14) read as a
 *  moving ship on every lurch: the Robot Orb broke off its extend (Break: the
 *  pilot came at it from behind), tailed it, braked beside it as it stopped,
 *  and crawled into the next run ~130 u off it; it never extended past ~5 ship
 *  lengths. The brain fills `tParkedHeld` / `tSlowHeld`. */
export const TARGET_STILL_MEMORY_S = 1;

/** …and a parked one only once it has sat under the parked bar this long (s):
 *  "parked" also means "cannot be tailing me" (`isTailed`, the Break gate),
 *  so a ship that has just started from rest is a threat the moment it
 *  moves. (The slow memory only changes how it is fought: no Tail.) Remembered from the instant, a robot set on a fighter's six from
 *  rest read as parked for its first second, and the fighter turned to strafe
 *  it instead of breaking (dogfightOnSight, 2026-11-14). The filmed pilot sat
 *  still ~0.7–2 s between lurches. */
export const TARGET_STILL_MIN_S = 0.5;

/** Is the target parked (below `PARKED_SPEED_FRAC` × my cruise, now or within
 *  `TARGET_STILL_MEMORY_S`)? */
export function targetParked(ctx: TacticalContext): boolean {
  if (ctx.tParkedHeld) return true;
  const v = PARKED_SPEED_FRAC * ctx.cruiseSpeed;
  return ctx.tvx * ctx.tvx + ctx.tvy * ctx.tvy <= v * v;
}

/** Squared target speed for the slow-target call: the smoothed
 *  `ctx.targetSpeed` when the brain set one, else the raw velocity. A parked
 *  call stays on the raw velocity: "parked" also gates being tailed
 *  (`isTailed`), and a robot pulling onto my six from rest must count at
 *  once (dogfightOnSight Break scene). */
function targetSpeedSq(ctx: TacticalContext): number {
  const s = ctx.targetSpeed;
  return s >= 0 ? s * s : ctx.tvx * ctx.tvx + ctx.tvy * ctx.tvy;
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

/** Is the target slow (below `SLOW_SPEED_FRAC` × my cruise, now or within
 *  `TARGET_STILL_MEMORY_S`)? Every parked target is slow. */
export function targetSlow(ctx: TacticalContext): boolean {
  return ctx.tSlowHeld || ctx.tParkedHeld || targetSlowNow(ctx);
}

/** Is the target slow right now (no memory)? */
export function targetSlowNow(ctx: TacticalContext): boolean {
  const v = SLOW_SPEED_FRAC * ctx.cruiseSpeed;
  return targetSpeedSq(ctx) < v * v || targetParked(ctx);
}

/** Hull avoidance's clearance margin, in own hull radii. */
export const HULL_CLEAR_MARGIN_RADII = 1;

/** How far apart two ships' centres must pass for hull avoidance to leave
 *  them be: both shield bubbles (hull radii + 2 × my pad: the other's pad is
 *  taken as mine, a pad follows the size class) plus
 *  `HULL_CLEAR_MARGIN_RADII` × my radius. The one rule the dodge
 *  (`HostileDroneBehaviour`) and the strafing miss (`runMiss`) share. */
export function hullClearance(radius: number, otherRadius: number, shieldPad: number): number {
  return radius + otherRadius + 2 * shieldPad + HULL_CLEAR_MARGIN_RADII * radius;
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

// ── Peacetime modes ────────────────────────────────────────────────────
// A pilot's job when it is not fighting (leaving, a course, the patrol orbit,
// ...) runs with the SAME lifecycle as a manoeuvre: `begin` once when the job
// starts, `writeGoal` each tick, `isDone` to end it. Which job runs is the
// brain's `pilotJob()` (one precedence). Instances live in `ai/modes/`, are
// preallocated per brain, and the context is a reused scratch struct (#14).
// A peacetime goal is a plain facing + wanted velocity (or a fly-to point),
// not context-steering interest, so modes are not `IManoeuvre`s.

/** Peacetime job ids (dense; `pilotJob()` returns one). */
export const JOB_LEAVING = 0;
export const JOB_FLOCK = 1;
export const JOB_TRAVEL = 2;
/** A course to `moveTarget` (formation slot, leader course, post hold). */
export const JOB_COURSE = 3;
/** Back to / at the guard post. */
export const JOB_GUARD = 4;
export const JOB_SEARCH = 5;
/** The origin orbit (nothing else to do). */
export const JOB_ORBIT = 6;
export const JOB_COUNT = 7;
export type PilotJobId = number;

/** `pilotJob()` orders. TICK: what `tick()` flies when it does not fight
 *  (leaving, flock, travel / patrol leg, course, guard post, hunt search,
 *  orbit). NO_FLOCK: the same for a follower whose leader can't be resolved.
 *  REPORT: the order `getActivity()` reports by, which differs (travel and
 *  hunt before the flock, the post without the broadside exception, a bare
 *  course reads idle). */
export const JOB_ORDER_TICK = 0;
export const JOB_ORDER_NO_FLOCK = 1;
export const JOB_ORDER_REPORT = 2;

/** What a peacetime mode reads, refreshed by the brain before each call. */
export interface PilotModeContext {
  tick: number;
  /** The job this call runs for (one mode may serve two jobs). */
  job: PilotJobId;
  self: AiEntity;
  kind: ShipKind;
  handling: PilotHandling;
  energy: number;
  energyMax: number;
  /** Flee's escape line (unit). */
  escapeX: number;
  escapeY: number;
  moveTarget: { x: number; y: number } | null;
  guardOn: boolean;
  guardX: number;
  guardY: number;
}

/** Placeholder `self` until the brain's first mode call. */
const NO_SELF: AiEntity = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

export function makePilotModeContext(kind: ShipKind, handling: PilotHandling): PilotModeContext {
  return {
    tick: 0, job: JOB_ORBIT, self: NO_SELF, kind, handling, energy: 0, energyMax: 0,
    escapeX: 0, escapeY: 1, moveTarget: null, guardOn: false, guardX: 0, guardY: 0,
  };
}

/** Fly `facing` + (`vx`, `vy`) through the virtual pilot with `params`. */
export const MODE_GOAL_FLY = 0;
/** The brain's shared fly-to helper (`tickMoveTo(tx, ty, cruiseCap, boost)`). */
export const MODE_GOAL_MOVE_TO = 1;

/** A peacetime mode's goal for this tick, written in place. */
export interface PilotModeGoal {
  kind: number;
  facing: number;
  vx: number;
  vy: number;
  boost: boolean;
  params: Readonly<PilotParams>;
  tx: number;
  ty: number;
  /** Fly-to cruise cap (-1 = the calm cruise). */
  cruiseCap: number;
}

export function makePilotModeGoal(params: Readonly<PilotParams>): PilotModeGoal {
  return { kind: MODE_GOAL_FLY, facing: 0, vx: 0, vy: 0, boost: false, params, tx: 0, ty: 0, cruiseCap: -1 };
}

/** One peacetime job, with the manoeuvre lifecycle. Stateful per brain;
 *  never allocates. */
export interface IPilotMode {
  /** Called once when the job starts. */
  begin(ctx: PilotModeContext): void;
  /** Fill `out` with this tick's goal. */
  writeGoal(ctx: PilotModeContext, out: PilotModeGoal): void;
  /** True once the job has run its course; open-ended jobs return false. */
  isDone(ctx: PilotModeContext): boolean;
}
