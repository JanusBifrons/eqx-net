import {
  type AiEntity,
  type AiIntent,
  type AiWorldView,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';
import { getWeapon, type WeaponMode } from '../combat/WeaponCatalogue.js';
import { hasTurretFireControl, mountWeaponReach } from '../combat/mountReach.js';
import { FC_MOUNT_FIRE_TOLERANCE } from '../combat/fireControlBearing.js';
import { shipAimRadius, shipHitBound, shipHullDistance } from '../combat/shipHitShape.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import {
  isOnSightHostile,
  isFriendly,
  isNpcAllegianceId,
  ON_SIGHT_ENGAGE_RANGE,
  PLAYERS_SIDE,
  type AllegianceSide,
} from '../../shared-types/allegiances.js';
import { pickTarget, type MountTargetView, type PickTargetOptions } from './WeaponMountController.js';
import { arrive, makeSteerOutput, type SteerOutput } from './steering.js';
import { HullAvoid } from './hullAvoid.js';
import {
  type FlockAccumulator,
  type FlockOutput,
  makeFlockAccumulator,
  makeFlockOutput,
  resetFlock,
  addCohesion,
  addAlignment,
  addSeparation,
  resolveFlock,
  FLOCK_COHESION_GAIN,
} from './flocking.js';
import type { AiEntityPoseOut, AiShipActivity, IAiNavRoutes } from '../contracts/IAiBehaviour.js';
import { shipBodyMass, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { AI_INPUT_BOOST, AI_INPUT_TURN_LEFT, AI_INPUT_TURN_RIGHT } from '../contracts/IAiBehaviour.js';
import { BOOST_TICK_COST, canAfford, regenEnergyStep, spendEnergy } from '../combat/Energy.js';
import {
  brakingSpeed,
  DEFAULT_PILOT_PARAMS,
  facingOf,
  makePilotHandling,
  makePilotState,
  pilotInputs,
  wrapAngle,
  type PilotHandling,
  type PilotParams,
  type PilotState,
} from './virtualPilot.js';
import { missileArmedProfile, roleProfile, roleSensorRange, type RoleProfile } from './tactics/roleProfiles.js';
import { TARGET_CLAIM_WEIGHT } from './tactics/targetClaims.js';
import {
  FACE_AIM_LEAD,
  FACE_MOVE,
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_KITE,
  MANOEUVRE_ORBIT,
  MANOEUVRE_TAIL,
  makeManoeuvreGoal,
  makeTacticalContext,
  MANOEUVRE_FALL_BACK,
  MANOEUVRE_FLEE,
  MANOEUVRE_HOLD,
  PARKED_SPEED_FRAC,
  SLOW_SPEED_FRAC,
  TARGET_STILL_MEMORY_S,
  TARGET_STILL_MIN_S,
  type IManoeuvre,
  type ManoeuvreGoal,
  type ManoeuvreId,
  type TacticalContext,
  JOB_COURSE, JOB_FLOCK, JOB_GUARD, JOB_LEAVING, JOB_ORBIT, JOB_SEARCH, JOB_TRAVEL,
  JOB_ORDER_NO_FLOCK, JOB_ORDER_REPORT, JOB_ORDER_TICK, MODE_GOAL_MOVE_TO, makePilotModeContext, makePilotModeGoal,
  type IPilotMode, type PilotJobId, type PilotModeContext, type PilotModeGoal,
} from './tactics/manoeuvre.js';
import { LeavingMode } from './modes/leavingMode.js';
import { PatrolMode } from './modes/patrolMode.js';
import { AttackRunManoeuvre, BreakManoeuvre, HoldManoeuvre, TailManoeuvre } from './tactics/manoeuvres.js';
import { FallBackManoeuvre, FleeManoeuvre, KiteManoeuvre, OrbitManoeuvre } from './tactics/stanceManoeuvres.js';
import {
  MORALE_LOCK_TICKS,
  MORALE_OUTCOME,
  MoraleTracker,
  moraleSeed,
  rollMorale,
  type MoraleOutcome,
} from './tactics/morale.js';
import { decisionDue, isTailed, LOD_PILOT_RANGE_MUL, ManoeuvrePicker } from './tactics/utility.js';
import { fnv1a32 } from '../random/rng.js';
import {
  addDangerFromPoint,
  addInterestToward,
  clearContextMaps,
  createContextMaps,
  makeContextOutput,
  resolveContext,
  type ContextMaps,
  type ContextSteerOutput,
} from './contextSteering.js';
import type { IAiAimBoard, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import {
  addAllyLaneDanger,
  ALLY_LANE_K,
  ALLY_LANE_LOOKAHEAD_S,
  ALLY_LANE_RADIUS_MUL,
  ALLY_LANE_WEIGHT,
  blockedNudgeSide,
  fireLaneAvoidanceOn,
  insideAllyLane,
  NUDGE_MAX_OFF,
  NUDGE_MIN_BLOCKS,
  NUDGE_SPEED_FRAC,
  NUDGE_TICKS,
  NUDGE_WEIGHT,
} from './tactics/fireLanes.js';
import {
  DRONE_AIM_TOLERANCE,
  DRONE_AIM_TOLERANCE_CLOSE,
  POINT_BLANK_RATIO,
  DEFAULT_AIM_RADIUS,
  ENGAGE_DISTANCE_RATIO,
  BROADSIDE_RANGE_STEER,
  BROADSIDE_SPEED,
  BROADSIDE_RANGE_DEADBAND,
  GUARD_HOLD_FRAC,
  GUARD_RETURN_FRAC,
  GUARD_RETURN_SPEED,
  GUARD_PILOT_PARAMS,
  TARGET_SPEED_GAIN,
  COMBAT_PILOT_PARAMS,
  RUN_PILOT_PARAMS,
  RUN_NOW_PILOT_PARAMS,
  BOOST_RESERVE_FRAC,
  FORGET_TICKS,
  DRONE_TARGET_HEALTH_WEIGHT,
  DRONE_TARGET_DWELL_TICKS,
  STRUCTURE_PRIORITY_BIAS,
  ORDERED_TARGET_PRIORITY,
  CALM_CRUISE_FRAC,
  MOVE_ARRIVE_SLOW_RADIUS,
  TRAVEL_LONG_LEG_GUARD_MUL,
  TRAVEL_ARRIVE_SPEED_FRAC,
  HUNT_LEG_SPACING_MUL,
  HUNT_EDGE_FRAC,
  LEADER_CRUISE_THROTTLE,
  FLOCK_ACTIVITY_GAP_MUL,
  FLOCK_CATCH_UP,
  COMBAT_NEIGHBOUR_K,
  COMBAT_SEP_REACH,
  COMBAT_SEP_CORE,
  COMBAT_CROWD_SPEED,
  NUDGE_ARRIVED,
  NUDGE_SHAPE,
  FACE_MOVE_ENTER,
  FACE_MOVE_EXIT,
  FACE_MOVE_MIN_SPEED,
  TICKS_PER_S_SIM,
  HIT_HALF_LIFE_TICKS,
  COUNT_RANGE_MUL,
  WARP_OUT_SENSOR_MUL,
  FALLBACK_MAX_TICKS,
  NEVER_RUN_MORALE,
  BROADSIDE_STANDOFF,
  TRAVEL_NONE,
  TRAVEL_ON_THE_WAY,
  TRAVEL_ARRIVED,
  type TravelState,
  type MoraleRollFn,
  type DroneState,
  type ShipEnergyPool,
  type HostileDroneBehaviourOptions,
} from './hostileDroneTuning.js';
export {
  BROADSIDE_STANDOFF,
  TRAVEL_NONE,
  TRAVEL_ON_THE_WAY,
  TRAVEL_ARRIVED,
  type TravelState,
  type MoraleRollFn,
  type DroneState,
  type ShipEnergyPool,
  type HostileDroneBehaviourOptions,
} from './hostileDroneTuning.js';

/**
 * Fixed-gun trigger discipline (owner 2026-11-14: fire only when the shot will
 * hit; pilot skill, not a special power). The cone (rad) the target's hull
 * covers seen from `dist`: atan(hitRadius / dist), never wider than the
 * player's fixed-gun window `FC_MOUNT_FIRE_TOLERANCE`. `hitRadius` is the
 * target's hit circle plus the shot's own radius; Infinity ⇒ the window.
 */
export function hullFireCone(hitRadius: number, dist: number): number {
  if (!(dist > 0)) return FC_MOUNT_FIRE_TOLERANCE;
  const c = Math.atan(hitRadius / dist);
  return c < FC_MOUNT_FIRE_TOLERANCE ? c : FC_MOUNT_FIRE_TOLERANCE;
}

/** Mutable twin of `MoraleInputs` (one scratch per brain, #14). */
interface MoraleInputsScratch {
  hullFrac: number;
  recentDamageRate: number;
  alliesNear: number;
  enemiesNear: number;
  ownSize: number;
  enemySize: number;
  isCapitalNearbyFriendly: boolean;
}

/**
 * Hostile drone: steers toward nearest player and fires hitscan when in range
 * and roughly aimed. Cooldown matches the player weapon (10 ticks @ 60 Hz).
 *
 * It flies with a player's controls only (owner rule 2026-11-13): every
 * movement mode picks a facing and a wanted velocity and the virtual pilot
 * (`virtualPilot.ts`) turns them into thrust / reverse / turn / boost keys,
 * which the worker runs through `applyShipInput` with the drone's own kind —
 * so each kind flies with its own handling. Forward is `(-sin θ, cos θ)`.
 */

export class HostileDroneBehaviour implements IAiBehaviour {
  private readonly kind: ShipKind;

  /** Roaming-formation (Phase 5): the in-sector point the director wants this
   *  drone to fly to while IDLE (its formation slot / the squad destination for
   *  the leader). `null` ⇒ default origin orbit. Server-only — set via the
   *  `setMoveTarget` hook; the client never ticks the drone brain. */
  private moveTarget: { x: number; y: number } | null = null;
  /** True when this drone is a flock LEADER cruising a course (set by
   *  `setFlockLeaderCourse`, cleared by `setMoveTarget`/`setFlockFollow`). While
   *  set, `tickMoveTo` throttles forward thrust by `LEADER_CRUISE_THROTTLE` so
   *  the leader travels slower than its full-cruise followers and they tighten
   *  into the herd. A plain `setMoveTarget` (lone drone / tests) is full-thrust. */
  private _flockLeaderCruise = false;
  /** Reused arrive() output (alloc-free hot path, invariant #14). */
  private readonly _steerScratch: SteerOutput = makeSteerOutput();
  /** This tick's routes round rock (`view.nav`, navigation slice 7), debris and tick, for `tickMoveTo`. */
  private _nav: IAiNavRoutes | null = null; private _debris: IAiNeighbourQuery | undefined; private _viewTick = 0;

  /** Leader-led flocking (non-combat herding). When `leaderId !== null` this
   *  drone is a FOLLOWER and flocks to the leader's live pose each tick instead
   *  of orbiting / chasing a static slot. Set by the director via
   *  `setFlockFollow`; cleared by `setMoveTarget` (leader role) / `clearMoveTarget`. */
  private leaderId: string | null = null;
  /** Squad member ids for the separation rule. Owned (copied on assignment) so
   *  the director may reuse its source array. */
  private readonly _flockMemberIds: string[] = [];
  /** Alloc-free flocking scratch (invariant #14) — all allocated once here. */
  private readonly _flockAcc: FlockAccumulator = makeFlockAccumulator();
  private readonly _flockOut: FlockOutput = makeFlockOutput();
  private readonly _leaderScratch: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  /** Squared distance to the flock leader at the last flock tick (Infinity
   *  until one), and the leader it was measured to: the panel's activity. */
  private _flockGap2 = Infinity;
  private _flockLeaderPrev: string | null = null;
  private readonly _neighborScratch: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

  // ── Phase 1: hostility / state machine ────────────────────────────────
  /** Behaviour state. Driven by `markHostile`/`purgeHostility` external
   *  events and the time-based forget at the top of `tick()`. */
  private state: DroneState = 'IDLE';
  /** Set of player ids the drone is actively hostile toward. Populated
   *  via `markHostile(shooterId, atTick)` from damage events both sides
   *  receive (server `applyDamage`, client `handleDamage`). */
  private readonly hostileTo = new Set<string>();
  /** Last server-tick at which each hostile player damaged this drone.
   *  Used to time-decay hostility when a player has been clean for
   *  `FORGET_TICKS` ticks. */
  private readonly lastHitByPlayer = new Map<string, number>();
  /** Previously-picked target id, used by `pickTarget` to apply sticky
   *  hysteresis (Phase 4a). Pre-refactor the drone re-picked nearest hostile
   *  every tick, which oscillated between two near-equidistant players. Per-
   *  instance so it's lockstep-safe in the same way `lastHitByPlayer` is —
   *  reset purely by `markHostile`/`purgeHostility`/time-decay, both of
   *  which fire symmetrically on server and client. */
  private prevTargetId: string | null = null;
  /** Server tick at which `prevTargetId` was last (re)acquired — drives the
   *  `DRONE_TARGET_DWELL_TICKS` switch-delay in the body target pick. */
  private prevTargetSinceTick = 0;
  /** Wave-system Phase 2 — reusable merged COMBAT candidate buffer (players +
   *  hostile structures). Filled IN PLACE every tick from `view.players` +
   *  `view.structures`; objects are created only when the buffer grows, never
   *  per-tick (#14, this is the hot AI loop). Structures carry `vx=vy=0`
   *  (static) + their class `priority`; players carry `priority 0`. Server-only
   *  (the client never ticks the drone brain). */
  private readonly _combatTargets: Array<{
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Facing (rad); undefined when unknown (structures, views without it). */
    angle?: number;
    health?: number;
    maxHealth?: number;
    kindId?: string | null;
    shieldUp?: boolean;
    priority: number;
    /** Spread targets: brains of my side already on it (0 without `view.claims`). */
    claims: number;
    /** A ship (pilot hull or swarm combatant), not a structure. */
    ship: boolean;
    /** The hit circle a fixed gun aims at (`shipAimRadius` of the view's
     *  hull shape; the default kind's bubble without one); Infinity for a
     *  structure (the player window applies). */
    hitRadius: number;
    /** Per-candidate hostility (allegiances P0) — ALWAYS set before the pick,
     *  so `pickTarget` reads it instead of the callback. For a drones-only view
     *  it equals `hostileTo.has(id)` ⇒ byte-identical to pre-P0. */
    hostile: boolean;
    /** Hostile through the retaliation ledger (`hostileTo`), not on sight:
     *  the guard leash reaches these out to guard radius + weapon reach. */
    ledger: boolean;
  }> = [];
  /** Allegiances P0 — this entity's NPC side (from its kind) and whether that
   *  side attacks players ON SIGHT (robots do; drones don't — drones are driven
   *  by waves + retaliation through `hostileTo`). */
  private readonly allegiance: AllegianceSide;
  private readonly onSightPlayers: boolean;
  /** Players side only: a swarm ship that attacks players on sight is an enemy. */
  private readonly foesOfPlayers: boolean;
  /** The owning player (null for an unowned ship). */
  private readonly ownerId: string | null;
  /** Phase 4c (2026-05-11) — half-arc of the widest rotating mount in
   *  this kind's primary slot, used to widen the body-aim fire gate so
   *  drones with turrets fire even when the body is off-aim by less than
   *  the mount's reach. For single-mount legacy kinds (zero arc) this is
   *  0 and the gate collapses to the pre-4c body-only tolerance. */
  private readonly maxTurretHalfArc: number;
  /** Capitals fight broadside: hold a stand-off at main-battery reach with the
   *  beam toward the target so fore and aft turrets bear. Their turrets fire
   *  under WeaponMountTicker fire control, never with the hull's aim. */
  private readonly broadside: boolean;
  /** Guard post (server-only, set by a director via `setGuardPost`): a
   *  broadside capital with a post fights FROM it instead of holding the
   *  stand-off (which under real naval ranges is ~29 km away from what it
   *  guards). Every other ship takes it as a LEASH on its target pick (RTS
   *  Part B slice 5, `guardLeash`). Plain fields, no object, so set/clear
   *  never allocates (#14). */
  private guardOn = false;
  private guardX = 0;
  private guardY = 0;
  private guardR = 0;
  /** The ship the guard post follows (owner 2026-11-15, flagship escorts:
   *  "the zone follows the flagship"); null ⇒ a fixed post. Resolved each
   *  tick into `_guardAnchorScratch` (`followGuardAnchor`). */
  private guardAnchorId: string | null = null;
  private readonly _guardAnchorScratch: AiEntityPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  /** On-sight engagement (RTS Part B slice 6, `setEngageOnSight`): off ⇒ this
   *  ship fights only what is on its retaliation ledger (`hostileTo`), the
   *  Defensive attitude. Drones and robots keep it on. */
  private engageOnSight = true;
  /** Hold fire (RTS Part B slice 7, `setHoldFire`): on ⇒ this ship picks no
   *  target at all (no on-sight, no retaliation, no trigger) and keeps flying
   *  its job. `markHostile` still records attackers, so a switch back to
   *  Defensive / Aggressive answers one that hit within `FORGET_TICKS`. */
  private holdFire = false;
  /** Hunt (RTS Part B slice 6, `setHunt`): no leash, on-sight engagement out
   *  to the sensor range, and with nothing to fight the ship searches the
   *  sector in an expanding square round where the search began
   *  (`tickSearch`). Plain fields (#14). */
  private hunting = false;
  /** RTS Part B slice 8 (`setOrderedTarget`): the owner's attack-order target.
   *  On the retaliation ledger (never forgotten while ordered, so a Defensive
   *  ship fights a neutral), `ORDERED_TARGET_PRIORITY` in the pick, and free of
   *  the guard leash and the sensor cap. Null = no order. */
  private orderedTargetId: string | null = null;
  /** The ledger tick the order wrote for its target (-1 = none): lifting the
   *  order forgets the mark unless the target hit this ship since. */
  private orderMarkTick = -1;
  /** Travel (RTS Part B slice 9, `setTravel`): an owner's Move / Retreat.
   *  On the way the ship flies to (`travelX`, `travelY`) and never turns to
   *  fight: it still picks a target (locks, the trigger) and fires only at
   *  one already in its sights. Arrived ⇒ it guards the point. Set / cleared
   *  by the job setters (a guard post, a hunt, a stop). */
  private travel: TravelState = TRAVEL_NONE;
  private travelX = 0;
  private travelY = 0;
  /** Patrol leg (RTS Part B slice 11, `setPatrolLeg`): a travel that FIGHTS.
   *  The leash is the guard radius round the nearest point of the leg (from
   *  (`legFromX`, `legFromY`) to the travel point): on the route that is the
   *  ship's own position, so it engages what it sees near it (Aggressive) or
   *  answers an attacker (Defensive), and lets go of a target that drags it
   *  a guard radius off its route, then flies the leg on. Plain fields (#14). */
  private travelFights = false;
  private legFromX = 0;
  private legFromY = 0;
  /** Squared distance to the target picked this tick, and this ship's
   *  position last tick (activity read-out). */
  private _targetDist2 = 0;
  private _lastX = 0;
  private _lastY = 0;
  /** The search (re)starts from where the ship is on its next idle tick. */
  private searchReset = true;
  /** Current leg (0-based), its unit direction and its end point. */
  private searchLeg = 0;
  private searchDirX = 0;
  private searchDirY = 1;
  private searchWpX = 0;
  private searchWpY = 0;

  // ── Weapon-aware engagement (weapons/energy/AI overhaul §4) ───────────
  // Computed once in the constructor from this drone's bound weapon (no
  // per-tick allocation, no wire divergence — all derived from `this.kind`).
  /** Mode of the drone's bound weapon (first mount). Drives the steering
   *  branch in tickCombat. */
  private readonly weaponMode: WeaponMode;
  /** The bound weapon winds up a 'locked-direction' charge, through which
   *  the pilot holds its line (`view.isCharging`). Such a wind-up starts only
   *  outside the attack run's pull-off distance (`_tac.overshoot`). */
  private readonly chargeHoldsLine: boolean;
  /** Distance (world units) at/under which the drone fires. Beam → very
   *  close (~225); bolt → medium (~560); missile → long (~1400). */
  private readonly fireRange: number;
  /** STOP_DIST = fireRange × this. Beam bores in (0.5); bolt dogfights
   *  (0.6); missile kites far (0.9). */
  private readonly stopDistFactor: number;
  /** Missile only: actively thrust AWAY when the target closes inside
   *  fireRange × this (artillery "stay away when engaging"). 0 for
   *  beam/bolt. */
  private readonly backoffInsideFactor: number;
  /** Muzzle speed used for the lead-aim time-to-target (`t = dist /
   *  leadMuzzleSpeed`). The bound weapon's REAL projectile speed for
   *  bolts/missiles (so the bolt is actually aimed at the intercept
   *  point); a huge value for hitscan so `t ≈ 0` (instantaneous beams
   *  need no lead). 2026-06-03 — replaces the single hardcoded
   *  LEAD_AIM_MUZZLE_SPEED, which 2×-over-led the 1600 u/s bolt. */
  private readonly leadMuzzleSpeed: number;
  /** The shot's own radius (a bolt sweeps a circle; 0 for a beam): widens the
   *  hull cone a fixed gun fires inside. */
  private readonly shotRadius: number;
  /** Sensor range (world units): NEW body-target picks are capped here
   *  (`roleSensorRange(kind.aiRole, fireRange)`, AI overhaul slice 3). A held
   *  target is kept beyond it, and a known (ledger) hostile beyond it is still
   *  picked when nothing is in range, so director-ordered hunters still go. */
  private readonly sensorRange: number;
  /** Reused body-pick options (alloc-free, #14); `ticksSincePrevTarget` is
   *  written each tick. */
  private readonly _pickOpts: PickTargetOptions;
  /** Same options without the sensor cap: the out-of-sensor fallback pick. */
  private readonly _pickOptsUncapped: PickTargetOptions;
  /** The guard-leash pick (a non-broadside ship with a post): measured from
   *  the POST, new picks AND the held target only inside the guard radius. */
  private readonly _pickOptsGuard: PickTargetOptions;
  /** The guard-leash pick for RETALIATION targets only (slice 6): a ship being
   *  shot answers out to its guard radius plus its weapon reach, so it fires
   *  back from the edge of its area. */
  private readonly _pickOptsGuardRetaliate: PickTargetOptions;
  /** Bound once (no per-tick closure). Unused while every candidate carries
   *  its own `hostile` flag, kept for the pickTarget signature. */
  private readonly _isHostile = (id: string): boolean => this.hostileTo.has(id);

  /** 2026-05-31 — pooled per-instance scratches (Invariant #14). Pre-fix
   *  this class returned a fresh AiIntent literal per tick (~15 drones ×
   *  60 Hz = 900 allocs/sec from the AI brain alone); combined with the
   *  parallel `swarmEntitySnapshot` literal, V8 was running major GC
   *  every ~1 s for 100-334 ms stop-the-world pauses, blocking the
   *  server's `update()` loop → user-reported `recv_gap_long` 227-461 ms.
   *  Capture `hlqxy6` + `tests/diag/server-dispatch-gap-probe.ts`.
   *  Caller (AiController.runEntity) reads fields immediately + does not
   *  retain the reference, so mutating a single per-instance scratch
   *  across every `tick` call is safe. `fire` sub-object is its own
   *  pooled slot; we re-attach by reference each tick when firing. */
  private readonly _intentScratch: AiIntent = {
    fx: 0, fy: 0, torque: 0, setAngvel: undefined, fire: undefined, warpOut: undefined,
  };
  /** Reused warp-out request (attached on the one tick it is asked). */
  private readonly _warpScratch = { x: 0, y: 0 };
  private readonly _fireScratch: { dirX: number; dirY: number; targetId: string; cone: number } = { dirX: 0, dirY: 0, targetId: '', cone: 0 };
  /** The kind's handling as the virtual pilot sees it (body mass as spawned). */
  private readonly handling: PilotHandling;
  /** Virtual-pilot state (reaction latch), owned per drone. */
  private readonly _pilot: PilotState = makePilotState();
  /** Ship energy (server-only): the ship's one pool (`opts.energyPool`, else
   *  its own, full at the kind's max), regenerated each tick and spent per
   *  boosted tick AND per weapon slot trigger (`trySpendEnergy`, called by the
   *  fire resolvers) with the shared `Energy.ts` helpers, as a pilot's. Every
   *  read and write goes through `energy`, the one accessor. */
  private readonly _energyPool: ShipEnergyPool;
  private get energy(): number { return this._energyPool.energy; }
  private set energy(v: number) { this._energyPool.energy = v; }
  private readonly energyMax: number;
  private readonly energyRegen: number;
  /** Combat context steering (slice 2c): maps, output and neighbour buffer,
   *  allocated once (#14). */
  private readonly _ctxMaps: ContextMaps = createContextMaps();
  private readonly _ctxOut: ContextSteerOutput = makeContextOutput();
  private readonly _nbIdx = new Int32Array(COMBAT_NEIGHBOUR_K);
  /** `shipTuning(kind).combatSeparation`, cached. */
  private readonly combatSeparation: number;
  /** `shipTuning(kind).shieldPad`, cached: ships collide as their shield
   *  bubbles (hull radius + pad), so hull avoidance clears the bubbles. */
  private readonly shieldPad: number;
  /** Pilot hulls count as same-side neighbours only for a side friendly to players. */
  private readonly friendlyToPilots: boolean;
  /** Facing latch: true while the nose follows the move heading, not the lead. */
  private _faceMove = false;
  /** Hull avoidance (ships and debris; latches its dodge side). */
  private readonly _avoid = new HullAvoid();
  /** Test-visible: ticks spent dodging a hull. */
  private _avoidTicks = 0;
  /** Ticks flown with the afterburner lit (test-visible). */
  private _boostTicks = 0;
  /** The target the still-memory is about, and the last ticks it was under
   *  the parked / slow bar (`TARGET_STILL_MEMORY_S`). */
  private _stillTargetId: string | null = null;
  private _tParkedTick = -1_000_000;
  private _tSlowTick = -1_000_000;
  /** Start of the target's current stretch under the parked bar (-1 while
   *  above it): it counts toward the parked memory only after
   *  `TARGET_STILL_MIN_S`. */
  private _tParkedSince = -1;
  /** Turn-key reversals (test-visible) and the last turn key held (1 L, −1 R). */
  private _turnReversals = 0;
  private _lastTurnKey = 0;
  /** Decisions taken while tailed (`isTailed`), and Breaks begun (test-visible). */
  private _tailedDecisions = 0;
  private _breaksBegun = 0;
  private _breakRefused = 0;
  /** Test-visible: did the last combat tick resolve through context steering? */
  private _ctxUsed = false;

  // ── Decision layer (slice 4): manoeuvres + utility picker ─────────────
  /** The role's tactics profile (`kind.aiRole`). */
  private role: RoleProfile;
  /** Reused tactical context + goal (#14). */
  private readonly _tac: TacticalContext = makeTacticalContext();
  private readonly _goal: ManoeuvreGoal = makeManoeuvreGoal();
  /** Preallocated manoeuvres, indexed by `ManoeuvreId`. */
  private readonly _flee = new FleeManoeuvre();
  private readonly _fallBack = new FallBackManoeuvre();
  private readonly _manoeuvres: readonly IManoeuvre[] = [
    new HoldManoeuvre(), new TailManoeuvre(), new AttackRunManoeuvre(), new BreakManoeuvre(),
    new OrbitManoeuvre(), new KiteManoeuvre(), this._fallBack, this._flee,
  ];
  /** The attack run (its dive phase takes the fire-lane nudge, slice 5b). */
  private readonly _attackRun = this._manoeuvres[MANOEUVRE_ATTACK_RUN] as AttackRunManoeuvre;
  /** The kite (backing off nose on takes the fire-lane nudge; running does not). */
  private readonly _kite = this._manoeuvres[MANOEUVRE_KITE] as KiteManoeuvre;
  // ── Morale (slice 6b, owner's "roll a dice") ──────────────────────────
  private readonly _morale = new MoraleTracker();
  private readonly _moraleIn: MoraleInputsScratch = {
    hullFrac: 1, recentDamageRate: 0, alliesNear: 0, enemiesNear: 0, ownSize: 1, enemySize: 0, isCapitalNearbyFriendly: false,
  };
  private _moraleRoll: MoraleRollFn = rollMorale;
  /** A forced FallBack holds until this tick (Flee holds until the warp). */
  private _moraleLockUntil = -1;
  /** No morale roll before this tick: every roll, Fight on included, holds
   *  `MORALE_LOCK_TICKS`. Triggers are not checked meanwhile, so one that
   *  arms inside the lock still rolls once it ends. */
  private _moraleNextRollAt = -1;
  /** A FallBack still on its way to its friends gives up at this tick. */
  private _fallBackCapUntil = -1;
  /** Last roll's outcome (-1 = never rolled). */
  private _lastMorale: MoraleOutcome | -1 = -1;
  /** fnv1a32 of the entity id (seeds the picker and the morale die). */
  private _idHash = 0;
  /** Sensor scan (decision time): allies within sensor range, the enemies'
   *  summed radii, a friendly capital seen. */
  private _sensorAllies = 0;
  private _enemySize = 0;
  private _capitalNear = false;
  /** Warp-outs requested (test-visible). */
  private _warpOuts = 0;
  /** Peacetime modes (`ai/modes/`), preallocated (#14). */
  private readonly _leaving = new LeavingMode();
  private readonly _patrol = new PatrolMode();
  private _modeCtx!: PilotModeContext;
  private readonly _modeGoal: PilotModeGoal = makePilotModeGoal(DEFAULT_PILOT_PARAMS);
  private readonly _picker = new ManoeuvrePicker();
  /** Seeded from the entity id on the first combat tick. */
  private _seeded = false;
  /** Decision-cadence slot (staggers the pack's re-scores across ticks). */
  private _slot = 0;
  /** AI LOD: no pilot near ⇒ slower decision cadence. */
  private _lod = false;
  /** A switch waiting out the role's reaction time (-1 = none). */
  private _pendingId = -1;
  private _pendingAt = 0;
  /** The body target's speed smoothed over ~`TARGET_SPEED_TAU_TICKS` (reset
   *  on a new target): the slow-target call reads it (`targetSlow`). */
  private _tSpeedAvg = 0;
  private _tSpeedId: string | null = null;
  /** Recent-hit counter (decays with `HIT_HALF_LIFE_TICKS`), from `markHostile`. */
  private _hitsVal = 0;
  private _hitsTick = 0;

  constructor(kind?: ShipKind | string, opts?: HostileDroneBehaviourOptions) {
    // Accept the kind as either a `ShipKind` record or a kind id (string), so
    // tests that don't care about kind tuning can still construct with no
    // arg (`new HostileDroneBehaviour()` falls back to the catalogue default).
    this.kind = typeof kind === 'object' && kind !== null
      ? kind
      : getShipKind(typeof kind === 'string' ? kind : null);
    const a = this.kind.allegiance;
    const playersSide = opts?.side === PLAYERS_SIDE;
    this.allegiance = playersSide ? PLAYERS_SIDE : a !== undefined && isNpcAllegianceId(a) ? a : 'drones';
    this.onSightPlayers = isOnSightHostile(this.allegiance, PLAYERS_SIDE);
    // The players side holds every pilot friendly (player-vs-player is the
    // players' own choice, never this brain's: retaliation still applies).
    this.friendlyToPilots = playersSide || isFriendly(this.allegiance, PLAYERS_SIDE);
    this.foesOfPlayers = playersSide;
    this.ownerId = opts?.ownerId ?? null;
    this.combatSeparation = shipTuning(this.kind).combatSeparation;
    this.shieldPad = shipTuning(this.kind).shieldPad;
    this.role = roleProfile(this.kind.aiRole);
    // The body's mass is the ship kind's (`shipBodyMass`), same as a pilot's.
    this.handling = makePilotHandling(this.kind, shipBodyMass(this.kind));
    this._modeCtx = makePilotModeContext(this.kind, this.handling);
    this.energyMax = this.kind.energyMax ?? 100;
    this.energyRegen = this.kind.energyRegenRate ?? 0.25;
    this._energyPool = opts?.energyPool ?? { energy: this.energyMax };
    // Compute the half-arc of the widest rotating mount across the kind's
    // mounts. `arcMax - arcMin` is the FULL arc; halving it gives the
    // distance the mount can swing from `baseAngle` in either direction.
    // For interceptor wings (±π/6), this is π/6 ≈ 30°. For gunship rear
    // (±π/2), this is π/2 ≈ 90°. Multi-mount kinds use the maximum across
    // their mounts (e.g. gunship's rear dominates over the forward's ±π/4).
    let maxHalf = 0;
    for (const m of this.kind.mounts ?? []) {
      if (m.rotationSpeed <= 0) continue;
      const half = (m.arcMax - m.arcMin) / 2;
      if (half > maxHalf) maxHalf = half;
    }
    this.maxTurretHalfArc = maxHalf;

    // Weapon-aware engagement profile (weapons/energy/AI overhaul §4).
    const firstWeapon = getWeapon(this.kind.mounts?.[0]?.weaponId ?? 'hitscan');
    this.weaponMode = firstWeapon.mode;
    this.chargeHoldsLine = (firstWeapon.chargeTicks ?? 0) > 0
      && (firstWeapon.chargeRelease ?? 'locked-direction') === 'locked-direction'
      && !hasTurretFireControl(this.kind);
    // Lead-aim muzzle speed: real projectile speed for bolts/missiles,
    // ~instant for hitscan (no lead). Drives the intercept in tickCombat.
    this.leadMuzzleSpeed = firstWeapon.mode === 'hitscan' ? 1e6 : firstWeapon.speed;
    this.shotRadius = firstWeapon.mode === 'hitscan' ? 0 : firstWeapon.radius;
    if (firstWeapon.mode === 'hitscan') {
      // Beam: very close range — bore in to ~90 % of the beam's reach.
      this.fireRange = firstWeapon.range * 0.9;
      this.stopDistFactor = 0.5;
      this.backoffInsideFactor = 0;
    } else if (firstWeapon.mode === 'projectile') {
      // Bolt: medium dogfight range ≈ half the projectile's max travel.
      this.fireRange = (firstWeapon.speed * firstWeapon.maxTicks / 60) * 0.5;
      this.stopDistFactor = 0.6;
      this.backoffInsideFactor = 0;
    } else {
      // Missile: long-range artillery; kite the target, fire from afar.
      this.fireRange = 1400;
      this.stopDistFactor = 0.9;
      this.backoffInsideFactor = 0.4;
    }
    this.broadside = hasTurretFireControl(this.kind);
    if (this.broadside) {
      // Engage at the longest gun's reach (the main battery).
      let reach = 0;
      for (const m of this.kind.mounts ?? []) reach = Math.max(reach, mountWeaponReach(m));
      this.fireRange = reach;
      this.stopDistFactor = BROADSIDE_STANDOFF;
      this.backoffInsideFactor = 0;
    }
    // A ship whose guns are missiles holds its distance whatever its role:
    // Kite is its best manoeuvre (`missileArmedProfile`).
    if (this.weaponMode === 'missile' && !this.broadside) this.role = missileArmedProfile(this.kind.aiRole);
    // A players-side ship never runs: every morale roll comes out Fight on.
    if (playersSide) this.role = Object.freeze({ ...this.role, moraleWeights: NEVER_RUN_MORALE });
    this.sensorRange = roleSensorRange(this.kind.aiRole, this.fireRange);
    const tac = this._tac;
    tac.fireRange = this.fireRange;
    tac.cruiseSpeed = this.handling.cruiseSpeed;
    tac.maxSpeed = this.handling.maxSpeed;
    tac.overshoot = shipTuning(this.kind).attackRunOvershoot;
    tac.bandMin = this.role.rangeBand.min * this.fireRange;
    tac.bandMax = this.role.rangeBand.max * this.fireRange;
    tac.turretHalfArc = this.maxTurretHalfArc;
    tac.sensorRange = this.sensorRange;
    tac.maxAngvel = this.handling.maxAngvel;
    tac.accel = this.handling.thrustAccel * 60;
    tac.brakeAccel = this.handling.reverseAccel * 60;
    tac.radius = this.kind.radius;
    tac.shieldPad = this.shieldPad;
    this._pickOpts = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      claimWeight: TARGET_CLAIM_WEIGHT,
      maxDistance: this.sensorRange,
      prevMaxDistance: Infinity,
    };
    this._pickOptsUncapped = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      claimWeight: TARGET_CLAIM_WEIGHT,
    };
    this._pickOptsGuard = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      claimWeight: TARGET_CLAIM_WEIGHT,
      maxDistance: 0,
      prevMaxDistance: 0,
    };
    this._pickOptsGuardRetaliate = { ...this._pickOptsGuard };
  }

  /** Test-visible engagement profile. */
  getFireRange(): number { return this.fireRange; }
  getSensorRange(): number { return this.sensorRange; }
  /** Test-visible: top speed on thrust alone (the pilot handling's cruise). */
  getCruiseSpeed(): number { return this.handling.cruiseSpeed; }
  /** Test-visible: the body target currently held (null = none). */
  getTargetId(): string | null { return this.prevTargetId; }
  getWeaponMode(): WeaponMode { return this.weaponMode; }

  /** Test-visible peek at the current state. */
  getState(): DroneState {
    return this.state;
  }

  /**
   * External event: a player just damaged this drone. Records the player
   * in `hostileTo` and bumps `lastHitByPlayer`. Flips state to COMBAT.
   * Called from both server (`SectorRoom.applyDamage`) and client
   * (`ColyseusClient.handleDamage`) so the per-instance state stays
   * lockstep-consistent without a wire-format bump.
   */
  markHostile(shooterId: string, atTick: number): void {
    if (!shooterId || shooterId === this.ownerId) return;
    this.hostileTo.add(shooterId);
    this.lastHitByPlayer.set(shooterId, atTick);
    this.state = 'COMBAT';
    // Decision layer: every damage hit lands here (swarmDamageStrategy), so it
    // doubles as the "under fire" signal. Director aggro marks count once too.
    this._hitsVal = this.recentHitsAt(atTick) + 1;
    this._hitsTick = atTick;
  }

  /** Morale: damage this ship took (server damage path → AiController). */
  noteDamage(amount: number, atTick: number, maxHull?: number): void {
    this._morale.noteDamage(atTick, amount, maxHull !== undefined && maxHull > 0 ? maxHull : this.kind.maxHealth);
  }

  /** Morale: the squad's capital died (the next decision rolls). */
  noteCapitalLost(): void {
    this._morale.noteCapitalLost();
  }

  /** Test seam: replace the morale die (deterministic outcomes in tests). */
  setMoraleRoll(fn: MoraleRollFn): void { this._moraleRoll = fn; }
  /** Test-visible: the last morale roll's outcome (-1 = none yet). */
  getLastMoraleOutcome(): MoraleOutcome | -1 { return this._lastMorale; }
  /** Test-visible: how many times this ship asked to warp out. */
  getWarpOutCount(): number { return this._warpOuts; }

  /** The decaying recent-hit count at `tick`. */
  private recentHitsAt(tick: number): number {
    if (this._hitsVal <= 0) return 0;
    const age = tick - this._hitsTick;
    return age <= 0 ? this._hitsVal : this._hitsVal * Math.pow(0.5, age / HIT_HALF_LIFE_TICKS);
  }

  /** Test-visible: the running dogfight manoeuvre (`MANOEUVRE_*`). */
  getManoeuvre(): ManoeuvreId { return this._picker.current; }
  /** Test-visible: re-scores made so far (the `aiDecisionsPerTick` source). */
  getDecisionCount(): number { return this._picker.decisions; }
  /** Test-visible: decisions taken while tailed (the Break trigger held). */
  getTailedDecisionCount(): number { return this._tailedDecisions; }
  /** Test-visible: Breaks begun so far. */
  getBreakCount(): number { return this._breaksBegun; }
  /** Test-visible: decisions taken while tailed with a Break on offer that
   *  picked something else (a role whose Break weight loses to its fight). */
  getBreakRefusedCount(): number { return this._breakRefused; }
  /** Test-visible: the last decision's scores, indexed by `MANOEUVRE_*`. */
  lastManoeuvreScores(): Readonly<Float32Array> { return this._picker.scores; }

  /** Render-side query: is this drone currently treating `playerId` as
   *  a hostile target? Pure, side-effect-free — safe to poll every frame. */
  isHostileToPlayer(playerId: string, truce = false): boolean {
    // Allegiances P0 (hostile-review A6): an on-sight-hostile allegiance (robots)
    // is hostile to every player by STANCE, not only once it has been hit — so
    // the snapshot `drones[].hostile` bit, liveCounts, and player turret aim all
    // see a robot as hostile from first sight. Derived from the kind, so the
    // client's own ledger (same kind, same table) agrees (invariant #15).
    // P2 — a player with a TRUCE (robot rep ≥ ROBOT_TRUCE_AT) is only hostile
    // via the retaliation ledger, never on sight.
    return (this.onSightPlayers && !truce) || this.hostileTo.has(playerId);
  }

  /**
   * External event: a player left the sector (transit out, disconnect).
   * Drops them from the hostile set; if no hostile remain, return to
   * IDLE so the drone resumes patrolling.
   */
  purgeHostility(playerId: string): void {
    if (!playerId) return;
    this.hostileTo.delete(playerId);
    this.lastHitByPlayer.delete(playerId);
    // If the purged player was the sticky target, drop the sticky pin so
    // the next `pickTarget` call doesn't try to keep them.
    if (this.prevTargetId === playerId) this.prevTargetId = null;
    if (this.hostileTo.size === 0) this.state = 'IDLE';
  }

  tick(self: AiEntity, view: AiWorldView): AiIntent {
    this._aimValid = false;
    this._nav = view.nav ?? null; this._debris = view.debris; this._viewTick = view.tick;
    this._lastX = self.x;
    this._lastY = self.y;
    this._pilot.turn.aimCone = 0;
    // Boost energy regenerates every tick, as a pilot's pool does.
    this.energy = regenEnergyStep(this.energy, this.energyMax, this.energyRegen);
    // Asked to warp out: run on along the escape line while the room spools
    // the warp, as a pilot's ship flies on through its spool (take 7: it
    // eased to the calm cruise and looked parked, then vanished).
    if (this.pilotJob(JOB_ORDER_TICK) === JOB_LEAVING) {
      if (!this._leaving.isDone(this.modeCtx(self, view.tick, JOB_LEAVING))) return this.runMode(this._leaving, self);
      this._leaving.until = -1;
    }
    // An anchored guard post sits on its anchor's live pose this tick.
    if (this.guardAnchorId !== null) this.followGuardAnchor(view);
    // Spread targets: drop my claim; the combat pick below re-claims, so while
    // I pick, `view.claims` counts only the OTHER brains of my side.
    view.claims?.claim(self.id, this.allegiance, null);
    // 1) Time-decay: drop hostiles whose last hit aged past FORGET_TICKS.
    //    `view.tick` is `serverTick` on the server and `inputTick` on the
    //    client.
    if (this.hostileTo.size > 0) {
      for (const [pid, lastHit] of this.lastHitByPlayer) {
        if (view.tick - lastHit > FORGET_TICKS && pid !== this.orderedTargetId) {
          this.lastHitByPlayer.delete(pid);
          this.hostileTo.delete(pid);
          // Drop the sticky pin if the decayed player was our target.
          if (this.prevTargetId === pid) this.prevTargetId = null;
        }
      }
      if (this.hostileTo.size === 0) this.state = 'IDLE';
    }

    // 2) IDLE → flock (follower) or patrol (leader / lone drone). A FOLLOWER
    //    (leaderId set by the director) herds to its leader's LIVE pose via
    //    continuous flocking; everyone else patrols (the leader follows its
    //    `moveTarget` course; a lone drone orbits). Server-only — the client
    //    never ticks the drone brain.
    //    Allegiances P0: an IDLE entity may still engage ON SIGHT (robots vs
    //    players; drones vs robots) — only when the view could contain such a
    //    target. A drones-only sector (`view.swarms` absent, drones not on-sight
    //    to players) takes the pre-P0 fast path, byte-identical.
    // 2a) Hold fire (RTS Part B slice 7): no target, no chase, no trigger; the
    //     ship carries on with its job (post / move / search / flock). The
    //     ledger above keeps recording and decaying, so lifting hold fire
    //     answers a recent attacker. An ATTACK ORDER is the exception: the
    //     ordered target alone is engaged (chase, lock, fire); every other
    //     contact stays ignored (narrowed after the candidate build below).
    const holdOrder = this.holdFire && this.orderedTargetId !== null;
    if (this.holdFire && !holdOrder) {
      this.prevTargetId = null;
      if (this._picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
      return this.tickJob(self, view, JOB_ORDER_TICK);
    }
    const canEngageOnSight = this.engageOnSight && (this.onSightPlayers || (view.swarms !== undefined && view.swarms.length > 0));
    if (this.state === 'IDLE' && !canEngageOnSight) {
      if (this._picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
      return this.tickJob(self, view, JOB_ORDER_TICK);
    }

    // 3) COMBAT — pick the *hostile* player to engage. Non-hostile players
    //    are invisible to a drone in combat (so a bystander flying through
    //    a fight isn't suddenly targeted). Phase 4a (2026-05-11): delegate
    //    to the shared `WeaponMountController.pickTarget`, which adds sticky
    //    hysteresis so the drone doesn't flap between two near-equidistant
    //    targets every tick. The same module powers the player-turret AI
    //    coming in Phase 4b — single ownership site for the targeting
    //    policy. When no hostile is in view this frame, fall back to patrol
    //    motion but stay in COMBAT state until the time-decay clears the set.
    // Part C — smarter selection: bias toward the lowest-health hostile and
    // hold the choice for DRONE_TARGET_DWELL_TICKS before re-evaluating (so a
    // pack focus-fires the wounded instead of all flipping targets per tick).
    // Wave-system Phase 2: build the merged candidate buffer (players + hostile
    // structures) in place. With no structures this is just the players copied
    // through with priority 0, so the pick is byte-identical to pre-Phase-2
    // (priorityBias has no effect when every priority is 0). Structures only
    // appear here when the server's faction-filtered view includes them AND
    // they're in this drone's `hostileTo` set (so a neutral base is never hit).
    const cand = this._combatTargets;
    // On sight (slice 6): a hunter sights out to its sensor range; Defensive
    // (`engageOnSight` off) sights nothing and fights only its ledger.
    const engageR = this.hunting ? this.sensorRange : ON_SIGHT_ENGAGE_RANGE;
    const engageR2 = engageR * engageR;
    const onSight = this.engageOnSight;
    const ownerId = this.ownerId;
    const ownerFoe = view.hostileToPlayer;
    const ordered = this.orderedTargetId;
    let n = 0;
    let anyHostile = false;
    for (const p of view.players) {
      let c = cand[n];
      if (!c) {
        c = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: undefined, priority: 0, ship: true, hostile: false, ledger: false, claims: 0, hitRadius: 0 };
        cand[n] = c;
      }
      c.id = p.id;
      c.x = p.x;
      c.y = p.y;
      c.vx = p.vx;
      c.vy = p.vy;
      c.angle = p.angle;
      c.health = p.health;
      c.maxHealth = p.maxHealth;
      c.kindId = p.kindId;
      c.shieldUp = p.shieldUp;
      c.priority = p.id === ordered ? ORDERED_TARGET_PRIORITY : 0;
      c.ship = true;
      c.hitRadius = p.kindId != null ? shipAimRadius(p.kindId, p.shieldUp === true) : DEFAULT_AIM_RADIUS;
      let h = this.hostileTo.has(p.id) || (p.ownerId !== undefined && this.hostileTo.has(p.ownerId));
      if (h && this.ownerId !== null && (p.id === this.ownerId || p.ownerId === this.ownerId)) h = false;
      c.ledger = h;
      if (!h && onSight && this.onSightPlayers && p.truce !== true) {
        const dx = p.x - self.x;
        const dy = p.y - self.y;
        h = dx * dx + dy * dy <= engageR2;
      }
      c.hostile = h;
      if (h) anyHostile = true;
      n++;
    }
    const structs = view.structures;
    if (structs) {
      for (const s of structs) {
        let c = cand[n];
        if (!c) {
          c = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: undefined, priority: 0, ship: true, hostile: false, ledger: false, claims: 0, hitRadius: 0 };
          cand[n] = c;
        }
        c.id = s.id;
        c.x = s.x;
        c.y = s.y;
        c.vx = 0;
        c.vy = 0;
        c.angle = undefined;
        c.health = s.health;
        c.maxHealth = s.maxHealth;
        c.kindId = undefined;
        c.shieldUp = undefined;
        c.priority = s.id === ordered ? Math.max(s.priority, ORDERED_TARGET_PRIORITY) : s.priority;
        c.ship = false;
        c.hitRadius = Infinity; // a footprint box, not a hull: the player window
        c.hostile = this.hostileTo.has(s.id);
        c.ledger = c.hostile;
        if (c.hostile) anyHostile = true;
        n++;
      }
    }
    // Allegiances P0 — other-allegiance swarm combatants. Only HOSTILE ones are
    // appended (stance on-sight within range, or retaliation via `hostileTo`),
    // keeping the candidate list small in a mixed sector.
    const swarms = view.swarms;
    if (swarms) {
      for (const s of swarms) {
        if (s.id === self.id) continue;
        let h = this.hostileTo.has(s.id);
        const ledger = h;
        // On sight: the stance table, a players-side ship's foes of players,
        // and (owned ships) anything hostile to the OWNER (slice 6).
        if (!h && onSight && isNpcAllegianceId(s.allegiance)
          && (isOnSightHostile(this.allegiance, s.allegiance)
            || (this.foesOfPlayers && isOnSightHostile(s.allegiance, PLAYERS_SIDE))
            || (ownerId !== null && ownerFoe !== undefined && ownerFoe(s.id, ownerId)))) {
          const dx = s.x - self.x;
          const dy = s.y - self.y;
          h = dx * dx + dy * dy <= engageR2;
        }
        if (!h) continue;
        let c = cand[n];
        if (!c) {
          c = { id: '', x: 0, y: 0, vx: 0, vy: 0, angle: undefined, priority: 0, ship: true, hostile: false, ledger: false, claims: 0, hitRadius: 0 };
          cand[n] = c;
        }
        c.id = s.id;
        c.x = s.x;
        c.y = s.y;
        c.vx = s.vx;
        c.vy = s.vy;
        c.angle = s.angle;
        c.health = s.health;
        c.maxHealth = s.maxHealth;
        c.kindId = s.kindId;
        c.shieldUp = s.shieldUp;
        c.priority = s.id === ordered ? ORDERED_TARGET_PRIORITY : 0;
        c.ship = true;
        c.hitRadius = s.kindId != null ? shipAimRadius(s.kindId, s.shieldUp === true) : DEFAULT_AIM_RADIUS;
        c.hostile = true;
        c.ledger = ledger;
        anyHostile = true;
        n++;
      }
    }
    if (cand.length !== n) cand.length = n;
    // Hold fire under an attack order: the ordered target is the only foe.
    if (holdOrder) {
      anyHostile = false;
      for (let i = 0; i < n; i++) {
        const c = cand[i]!;
        c.hostile = c.ledger = c.id === ordered && c.hostile;
        if (c.hostile) anyHostile = true;
      }
      if (!anyHostile) {
        this.prevTargetId = null;
        if (this._picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
        return this.tickJob(self, view, JOB_ORDER_TICK);
      }
    }
    // Spread targets (owner 2026-11-14): how many of my side already hold each
    // hostile candidate; the pick scores a held one worse, so a free enemy wins
    // and the surplus doubles up only when we outnumber them.
    const claims = view.claims;
    let orderedLive = false;
    for (let i = 0; i < n; i++) {
      const c = cand[i]!;
      c.claims = claims !== undefined && c.hostile ? claims.count(this.allegiance, c.id) : 0;
      if (c.hostile && c.id === ordered) orderedLive = true;
    }

    // An IDLE entity with nothing on-sight-hostile in range keeps patrolling /
    // flocking (it never entered COMBAT; no state change).
    if (this.state === 'IDLE' && !anyHostile) {
      if (this._picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
      return this.tickJob(self, view, JOB_ORDER_TICK);
    }

    // Sensor cap (AI overhaul slice 3): NEW picks only within the role's
    // sensor range; the held target stays eligible at any range
    // (`prevMaxDistance: Infinity`). Nothing in range and nothing held ⇒ fall
    // back to the uncapped pick, so a director-ordered / retaliation contact
    // (`hostileTo`, set via markHostile) across the sector is still hunted.
    // On-sight candidates never reach the fallback beyond ON_SIGHT_ENGAGE_RANGE
    // (they aren't hostile there), and the sensor range is floored at it.
    // Guard leash (RTS Part B slice 5): a ship with a guard post (not a
    // broadside capital, which flies its own guard) picks by distance from
    // the POST, only inside the guard radius, held target included, and no
    // uncapped fallback: what leaves the radius is let go.
    const sinceTicks = view.tick - this.prevTargetSinceTick;
    // A patrol leg (slice 11) leashes round the nearest point of its leg.
    const roam = this.travel === TRAVEL_ON_THE_WAY && this.travelFights && !this.broadside;
    if (roam) this.legLeashCentre(self);
    const leash = this.guardLeash() || roam;
    let target: MountTargetView | null;
    if (orderedLive) {
      // Attack order (slice 8): go and get it. The ordered target is free of
      // the sensor cap and the guard leash; it wins on its priority inside the
      // usual pick. Every other target keeps the leash (inside the guard
      // radius round the post), narrowed in place (the pick is the last reader).
      if (leash) {
        const r2 = this.guardR * this.guardR;
        for (let i = 0; i < n; i++) {
          const c = cand[i]!;
          if (!c.hostile || c.id === ordered) continue;
          const dx = c.x - this.guardX;
          const dy = c.y - this.guardY;
          if (dx * dx + dy * dy > r2) c.hostile = false;
        }
      }
      this._pickOptsUncapped.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, this.prevTargetId, this._isHostile, this._pickOptsUncapped);
    } else if (leash) {
      this._pickOptsGuard.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(this.guardX, this.guardY, cand, this.prevTargetId, this._isHostile, this._pickOptsGuard);
      // Slice 6: a ship being shot answers. Nothing inside the radius ⇒ a
      // RETALIATION target out to the radius plus the weapon reach (so it
      // fires back from the edge of its area); on-sight ones stay inside.
      // Narrows `hostile` to the ledger in place: the pick is the buffer's
      // last reader this tick.
      if (target === null && this.hostileTo.size > 0) {
        for (let i = 0; i < n; i++) { const c = cand[i]!; c.hostile = c.ledger; }
        this._pickOptsGuardRetaliate.ticksSincePrevTarget = sinceTicks;
        target = pickTarget(this.guardX, this.guardY, cand, this.prevTargetId, this._isHostile, this._pickOptsGuardRetaliate);
      }
    } else {
      this._pickOpts.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, this.prevTargetId, this._isHostile, this._pickOpts);
    }
    if (target === null && anyHostile && !leash && !orderedLive) {
      this._pickOptsUncapped.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, this.prevTargetId, this._isHostile, this._pickOptsUncapped);
    }
    const newId = target?.id ?? null;
    if (newId !== this.prevTargetId) this.prevTargetSinceTick = view.tick;
    this.prevTargetId = newId;
    view.claims?.claim(self.id, this.allegiance, newId);
    if (target === null) {
      if (this._picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
      // A follower with nothing to shoot keeps with its pack (RTS Part B
      // slice 10): under fire from out of reach it must not drop out of the
      // flock and fly its old post / the origin orbit.
      return this.tickJob(self, view, JOB_ORDER_TICK);
    }

    const tdx = target.x - self.x;
    const tdy = target.y - self.y;
    this._targetDist2 = tdx * tdx + tdy * tdy;
    // Travel (slice 9): keep going, shoot only what is already in the sights.
    // A patrol leg (slice 11) turns and fights it, then flies the leg on; a
    // broadside capital keeps its route and lets its turrets fight.
    if (this.travel === TRAVEL_ON_THE_WAY && (!this.travelFights || this.broadside)) return this.tickTravel(self, view, target);
    // A hunter that found a fight searches again from wherever it ends.
    if (this.hunting) this.searchReset = true;
    return this.tickCombat(self, view, target);
  }

  /**
   * A fleeing ship with no hostile target left (it outran the on-sight reach
   * of its enemies, or they died): it is clear. Keep running along the escape
   * line at full speed with boost and warp out once Flee's clear time (or its
   * cap) is up. Filmed take 5 (perf-dogfight-3v3, 2026-11-14): with the
   * warp-out asked only in the combat branch, a ship that lost its target
   * patrolled instead and drifted in the sector, never warping.
   */
  private tickFleeClear(self: AiEntity, tick: number): AiIntent {
    const f = this._flee;
    f.noteClear(tick);
    this._tac.tick = tick;
    const v = this.handling.maxSpeed;
    const boostOk = this.energy >= BOOST_RESERVE_FRAC * this.energyMax;
    const intent = this.fly(self, Math.atan2(-f.dirX, f.dirY), f.dirX * v, f.dirY * v, boostOk, RUN_PILOT_PARAMS);
    if (f.wantsWarpOut(tick)) this.requestWarpOut(self, intent);
    return intent;
  }

  // ── Peacetime jobs ──────────────────────────────────────────────────
  /** The one place that decides the pilot's peacetime job, in the order
   *  `order` names (`JOB_ORDER_*`, ai-pilots.md "pilotJob() precedence"). */
  private pilotJob(order: number): PilotJobId {
    if (this._leaving.until >= 0) return JOB_LEAVING;
    if (order === JOB_ORDER_REPORT) {
      if (this.travel === TRAVEL_ON_THE_WAY) return JOB_TRAVEL;
      if (this.hunting) return JOB_SEARCH;
      if (this.leaderId !== null) return JOB_FLOCK;
      if (this.guardOn) return JOB_GUARD;
      return JOB_ORBIT;
    }
    if (order === JOB_ORDER_TICK && this.leaderId !== null) return JOB_FLOCK;
    if (this.travel === TRAVEL_ON_THE_WAY) return JOB_TRAVEL;
    if (this.moveTarget !== null) return JOB_COURSE;
    // Guard leash: nothing to fight ⇒ back to the post.
    if (this.guardLeash()) return JOB_GUARD;
    // Hunt: nothing to fight ⇒ search the sector.
    if (this.hunting) return JOB_SEARCH;
    return JOB_ORBIT;
  }

  /** Fly the peacetime job: a mode file (`ai/modes/`) or a brain helper. */
  private tickJob(self: AiEntity, view: AiWorldView, order: number): AiIntent {
    const job = this.pilotJob(order);
    switch (job) {
      case JOB_FLOCK: return this.tickFlock(self, view);
      case JOB_TRAVEL: return this.tickTravel(self, null, null);
      case JOB_GUARD: return this.tickMoveTo(self, this.guardX, this.guardY);
      case JOB_SEARCH: return this.tickSearch(self);
      default: // leaving, course, orbit: mode files
        this.modeCtx(self, view.tick, job);
        return this.runMode(job === JOB_LEAVING ? this._leaving : this._patrol, self);
    }
  }

  /** Refresh the reused mode context (#14). */
  private modeCtx(self: AiEntity, tick: number, job: PilotJobId): PilotModeContext {
    const c = this._modeCtx;
    c.tick = tick; c.job = job; c.self = self; c.energy = this.energy; c.energyMax = this.energyMax;
    c.escapeX = this._flee.dirX; c.escapeY = this._flee.dirY; c.moveTarget = this.moveTarget;
    c.guardOn = this.guardOn; c.guardX = this.guardX; c.guardY = this.guardY;
    return c;
  }

  /** Run a mode on the context `modeCtx` just filled: it writes a goal, the
   *  brain flies it (the shared fly-to for a point). */
  private runMode(mode: IPilotMode, self: AiEntity): AiIntent {
    const g = this._modeGoal;
    mode.writeGoal(this._modeCtx, g);
    if (g.kind === MODE_GOAL_MOVE_TO) return this.tickMoveTo(self, g.tx, g.ty, g.cruiseCap, g.boost);
    return this.fly(self, g.facing, g.vx, g.vy, g.boost, g.params);
  }

  // ── Combat ──────────────────────────────────────────────────────────
  /**
   * Pursue-and-fire. The decision (target, lead point, stand-off, fire gate)
   * is unchanged from the impulse era; the actuation is the virtual pilot:
   * face the lead point, and fly a wanted velocity along the target line —
   * the target's own speed along that line plus a closing speed the pilot
   * can still brake from by the stop distance (missile kites back off).
   */
  private tickCombat(self: AiEntity, view: AiWorldView, target: MountTargetView): AiIntent {
    // Raw geometry to the live target — used for distance-based gating.
    const rawDx = target.x - self.x;
    const rawDy = target.y - self.y;
    const dist = Math.hypot(rawDx, rawDy);
    if (dist < 1e-3) return this.fly(self, self.angle, target.vx, target.vy, false);
    // Range to the target's HULL (the shape the fire gate measures to), so a
    // capital is engaged once a gun reaches its side, not its centre. Cheap
    // first: past bound + fireRange the centre distance minus the bound is
    // already out of range; only near range is the polygon measured.
    let rangeDist = dist;
    if (target.kindId != null) {
      const far = dist - shipHitBound(target.kindId);
      rangeDist = far > this.fireRange
        ? far
        : shipHullDistance(target.kindId, target.shieldUp === true, self.x, self.y, target.x, target.y, target.angle ?? 0);
    }
    if (this.broadside) return this.tickBroadside(self, target, rawDx, rawDy, dist, rangeDist);

    // Lead-aim: first-order intercept in the SHOOTER's frame. The bolt
    // inherits the shooter's velocity at spawn (self.v + dir·speed), so the
    // lead uses the target's velocity RELATIVE to the shooter and the
    // weapon's real muzzle speed (hitscan → leadMuzzleSpeed huge → t≈0 →
    // no lead).
    const t = dist / this.leadMuzzleSpeed;
    const aimX = target.x + (target.vx - self.vx) * t;
    const aimY = target.y + (target.vy - self.vy) * t;
    const aimDx = aimX - self.x;
    const aimDy = aimY - self.y;
    // Fire-lane awareness (slice 5b): publish where this gun points while it
    // can shoot, so wingmen keep out of the lane.
    if (rangeDist <= this.fireRange) view.aims?.write(self.id, aimX, aimY, view.tick);

    // Bearing toward the lead-aim point, not the target's current pose.
    const desiredAngle = facingOf(aimDx, aimDy);
    const bearingError = wrapAngle(desiredAngle - self.angle);
    // Fixed guns: the cone the target's hull covers at the lead point (plus the
    // bolt's own radius), capped at the player's window. In range, the pilot
    // eases the nose into it with one-tick taps (`aimCone`) and fires only
    // inside it (below), so a shot is pulled only when it will hit.
    // Turret kinds send the same cone with the shot: the resolver narrows each
    // barrel's window to it.
    const hullCone = hullFireCone(((target as { hitRadius?: number }).hitRadius ?? DEFAULT_AIM_RADIUS) + this.shotRadius, Math.hypot(aimDx, aimDy));
    if (this.maxTurretHalfArc <= 0 && rangeDist <= this.fireRange) this._pilot.turn.aimCone = hullCone;
    this._aimValid = true;
    this._aimX = aimX;
    this._aimY = aimY;

    // Weapon-aware stand-off (weapons/energy/AI overhaul §4): beam bores to
    // ~50 % of its short reach, bolt holds the mid-range dogfight, missile
    // kites at ~90 % of its long reach and backs off when the target closes
    // inside `fireRange × backoffInsideFactor`. Expressed as a wanted speed
    // along the target line (+ = closing), on top of the target's own speed
    // along it, so a moving target is matched rather than chased past.
    const ux = rawDx / dist;
    const uy = rawDy / dist;
    const h = this.handling;
    const STOP_DIST = this.fireRange * this.stopDistFactor;
    const targetAlong = target.vx * ux + target.vy * uy;
    let closing: number;
    let boostOk = false;
    if (this.backoffInsideFactor > 0 && rangeDist < this.fireRange * this.backoffInsideFactor) {
      // Missile kite — too close for artillery: open the gap.
      closing = -h.cruiseSpeed;
    } else if (rangeDist > this.fireRange * ENGAGE_DISTANCE_RATIO) {
      // Far engagement — close at full speed, boosting while it can.
      closing = Math.min(h.maxSpeed, brakingSpeed(h, rangeDist - STOP_DIST));
      boostOk = true;
    } else if (rangeDist > STOP_DIST) {
      // Approach window: never faster than it can brake from by STOP_DIST
      // (the "flies past way too quickly… never approaches" fix, now by the
      // pilot's own reverse instead of an AI-only brake impulse).
      closing = Math.min(h.cruiseSpeed, brakingSpeed(h, rangeDist - STOP_DIST));
    } else {
      // Inside the stop distance — hold the range (brake any closing speed).
      closing = 0;
    }
    let along = targetAlong + closing;
    if (along > h.maxSpeed) along = h.maxSpeed;
    else if (along < -h.maxSpeed) along = -h.maxSpeed;
    const nb = view.neighbours;
    this._ctxUsed = false;
    let intent: AiIntent;
    if (view.isCharging?.(self.id) === true) {
      // A charge is winding up: the shot leaves down the barrel when it ends,
      // so hold the line (nose on the lead, matching the target's velocity)
      // instead of flying the manoeuvre. A strafing pass carried the ship
      // ~400 u sideways in the 1.2 s wind-up and the shot missed even a
      // parked pilot (chargeLaser.test.ts). The target can still dodge.
      this._faceMove = false;
      intent = this.fly(self, desiredAngle, target.vx, target.vy, false);
    } else if (nb === undefined) {
      // No neighbour index: the pre-2c stand-off path exactly (A/B control).
      this._faceMove = false;
      intent = this.fly(self, desiredAngle, ux * along, uy * along, boostOk);
    } else {
      // Decision layer (slice 4): the running manoeuvre writes the goal, the
      // utility picker re-decides on its cadence.
      this.fillTactical(self, view.tick, target, dist, ux, uy, aimX, aimY, desiredAngle, bearingError, along, boostOk);
      this.runDecision(self, view, nb);
      clearContextMaps(this._ctxMaps);
      this._goal.spendReserve = false;
      this._goal.throttleNow = false;
      this._manoeuvres[this._picker.current]!.writeGoal(this._tac, this._ctxMaps, this._goal);
      intent = this.flyCombatContext(self, nb, view.debris, view.aims, ux, uy, desiredAngle, rangeDist <= this.fireRange, this._goal);
      if (this._picker.current === MANOEUVRE_FLEE && this._flee.wantsWarpOut(view.tick)) {
        this.requestWarpOut(self, intent);
        return intent;
      }
    }

    // Fire gating: standard 14° cone at normal distance widens to 26° at
    // point-blank so brawls actually trade fire instead of dancing
    // around each other waiting for a perfect line-up.
    //
    // Phase 4c (2026-05-11): kinds with rotating mounts add the widest
    // mount's half-arc to the body-aim tolerance, so a drone fires when
    // a turret can reach the target even when the body itself is off.
    //
    // Fixed guns (no turning mount) fire only when the nose is inside the
    // cone the target's hull covers (`hullCone`, never wider than the
    // player's `FC_MOUNT_FIRE_TOLERANCE` window): the shot leaves down the
    // drawn barrel (owner 2026-11-14), and a nose up to 0.2 rad off the lead
    // missed a fighter at range ~40 % of the time. A turret kind keeps the
    // wide request; the resolver fires only the barrels that bear.
    const baseTolerance = rangeDist < this.fireRange * POINT_BLANK_RATIO
      ? DRONE_AIM_TOLERANCE_CLOSE
      : DRONE_AIM_TOLERANCE;
    const aimTolerance = this.maxTurretHalfArc > 0
      ? baseTolerance + this.maxTurretHalfArc
      : hullCone;

    const aimed = Math.abs(bearingError) <= aimTolerance;
    const inRange = rangeDist <= this.fireRange;
    // The trigger is HELD while aimed and in range, as a pilot holds fire: the
    // resolver owns the cooldown, the lock, the line of fire, the barrel
    // bearing and the energy, and fires the moment they all allow. A brain-side
    // cooldown spent here on a shot the resolver then held (a turret not yet
    // bearing) left the gun silent for a whole cooldown (0 hits a pass).
    // A charge wind-up is held on its line (above), so it starts only outside
    // the attack run's pull-off distance: inside it the pass swings beside the
    // target, and holding the line there parked a Robot Orb ~2.5 lengths off a
    // parked pilot for the whole 1.2 s wind-up (strafeParkedRobots). The
    // pilot saves the charge for the next dive.
    const windUpRoom = !this.chargeHoldsLine || rangeDist >= this._tac.overshoot
      || view.isCharging?.(self.id) === true;
    const willFire = aimed && inRange && windUpRoom;
    if (willFire) {
      const f = this._fireScratch;
      // Fire along the EXACT lead vector, NOT the body-forward axis. The
      // body only turns toward the lead at a rate-limited angvel and is
      // allowed to fire anywhere inside the (wide) aim cone, so body-forward
      // ≈ lead but off by up to the tolerance — enough to miss a moving
      // target at range. Aiming the shot itself at the intercept point
      // decouples accuracy from the imperfect body aim (2026-06-03).
      const aimLen = Math.hypot(aimDx, aimDy);
      if (aimLen > 1e-6) {
        f.dirX = aimDx / aimLen;
        f.dirY = aimDy / aimLen;
      } else {
        f.dirX = -Math.sin(self.angle);
        f.dirY = Math.cos(self.angle);
      }
      f.targetId = target.id;
      f.cone = hullCone;
      intent.fire = f;
    }
    return intent;
  }

  /**
   * Combat movement through context steering (AI steering plan slice 2c).
   * The running manoeuvre (slice 4) has written its INTEREST into the maps
   * and its speed / facing mode / boost into `goal` (Hold is the pre-slice-4
   * stand-off: a lobe along the target line at speed `|along|`).
   * Same-side neighbours inside `combatSeparation × COMBAT_SEP_REACH` add
   * DANGER toward themselves (full inside `COMBAT_SEP_CORE`), so a ship whose
   * approach line runs through a wingman picks the nearest clear heading
   * instead. Crowded ships also get interest straight away from the crowd and
   * a floor speed, so a pack holding range drifts apart rather than sitting
   * nose to tail. Obstacles are not written yet (no cheap per-tick query).
   *
   * Facing (one nose): the goal's AIM_LEAD / FACE_MOVE, or with FACE_AUTO the
   * lead point while in fire range, so it still shoots; the move heading when
   * out of range, or when the move runs more than ~90° off the target bearing
   * at a real speed (with hysteresis) — the ship turns away to reposition and
   * comes back round. Allocation-free.
   */
  private flyCombatContext(
    self: AiEntity,
    nb: IAiNeighbourQuery,
    debris: IAiNeighbourQuery | undefined,
    aims: IAiAimBoard | undefined,
    ux: number,
    uy: number,
    leadAngle: number,
    inRange: boolean,
    goal: ManoeuvreGoal,
  ): AiIntent {
    // Fine aim only while the nose is held on the lead (set again below): a
    // nose on the move course, a nudge or a dodge has nothing to line up.
    const aimCone = this._pilot.turn.aimCone;
    this._pilot.turn.aimCone = 0;
    // The running manoeuvre has already written its interest into the maps.
    const m = this._ctxMaps;
    const goalSpeed = goal.speed;

    const sep = this.combatSeparation;
    const reach = sep * COMBAT_SEP_REACH;
    const core = sep * COMBAT_SEP_CORE;
    const idx = this._nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, reach, COMBAT_NEIGHBOUR_K, idx, self.id);
    let pushX = 0;
    let pushY = 0;
    let crowd = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      if (nb.isPilotAt(i) ? !this.friendlyToPilots : nb.sideAt(i) !== this.allegiance) continue;
      const dx = nb.xAt(i) - self.x;
      const dy = nb.yAt(i) - self.y;
      const d = Math.hypot(dx, dy);
      addDangerFromPoint(m, dx, dy, d, core, reach - core, 1);
      if (d < sep && d > 1e-6) {
        const c = 1 - d / sep;
        pushX -= (dx / d) * c;
        pushY -= (dy / d) * c;
        if (c > crowd) crowd = c;
      }
    }
    if (crowd > 0) addInterestToward(m, pushX, pushY, crowd, 1);

    // Fire lanes (slice 5b, `tactics/fireLanes.ts`): keep out of wingmen's
    // lines of fire, and side-step off a line the gate keeps holding.
    // `nudging`: a short reposition (blocked, or sitting in a wingman's
    // lane): the nose may swing off the lead so the ship can actually move
    // sideways (a ship only thrusts along its nose).
    let nudging = false;
    if (fireLaneAvoidanceOn()) {
      if (aims !== undefined && this.addAllyLanes(self, nb, aims)) nudging = true;
      if (this.writeBlockedNudge(self, ux, uy)) nudging = true;
    }

    const out = resolveContext(m, this._ctxOut);
    this._ctxUsed = true;
    const h = this.handling;
    const crowdSpeed = crowd * COMBAT_CROWD_SPEED * h.cruiseSpeed;
    let speed = goalSpeed > crowdSpeed ? goalSpeed : crowdSpeed;
    if (nudging && speed < NUDGE_SPEED_FRAC * h.cruiseSpeed) speed = NUDGE_SPEED_FRAC * h.cruiseSpeed;
    // The resolved heading carries the speed; the crowd push adds an opening
    // velocity on top (a lateral wingman masks no forward slot, so the
    // heading alone would never open a side-by-side gap).
    const pushGain = COMBAT_CROWD_SPEED * h.cruiseSpeed;
    let wvx = out.dirX * speed + pushX * pushGain;
    let wvy = out.dirY * speed + pushY * pushGain;
    const wv = Math.hypot(wvx, wvy);
    if (wv > h.maxSpeed) {
      wvx *= h.maxSpeed / wv;
      wvy *= h.maxSpeed / wv;
    }
    // Collision course with a hull (the target included) or a wreck piece?
    // Dodge it first.
    if (!h.torqueTurn && this._avoid.check(self, h, this.kind.radius, this.shieldPad, this.avoidAccel(), this._tac.tick, nb, debris)) {
      this._avoidTicks++;
      this._faceMove = true;
      const g = h.maxSpeed, av = this._avoid;
      return this.fly(self, facingOf(av.x, av.y), self.vx + av.x * g, self.vy + av.y * g,
        this.energy >= BOOST_RESERVE_FRAC * this.energyMax, COMBAT_PILOT_PARAMS);
    }
    const moveAngle = wv > 1e-6 ? facingOf(wvx, wvy) : out.angle;

    // Facing (one nose). The manoeuvre may ask for it outright (an attack
    // run's pull-off and extend, a break: explicit, time-limited choices).
    // FACE_AUTO (Hold) is the 2c rule: in fire range the nose stays on the
    // lead point, so the ship keeps shooting; the separation still acts
    // through thrust and reverse along it. Out of range it points along the
    // move while closing, or when wingmen force a detour > 100° off the GOAL
    // heading. (perf:counts fleet-fight, 2026-11-13: turning the nose to the
    // move in range had ships facing away ~60 % of in-range ticks and halved
    // the hits.)
    const moving = wv > FACE_MOVE_MIN_SPEED * h.cruiseSpeed;
    if (goal.facing === FACE_AIM_LEAD) {
      this._faceMove = false;
    } else if (goal.facing === FACE_MOVE) {
      this._faceMove = moving;
    } else {
      const along = this._tac.holdAlong;
      const sgn = along < 0 ? -1 : 1;
      let off = wrapAngle(moveAngle - facingOf(ux * sgn, uy * sgn));
      if (off < 0) off = -off;
      const thresh = this._faceMove ? FACE_MOVE_EXIT : FACE_MOVE_ENTER;
      this._faceMove = moving && !inRange && (along > 0 || off > thresh);
    }
    let facing = this._faceMove ? moveAngle : leadAngle;
    if (nudging && !this._faceMove) {
      // The gate holds the shot anyway, so a nose held on the lead may swing
      // toward the side-step (a ship flies along its nose), but no further
      // than NUDGE_MAX_OFF off the lead: it comes straight back to shoot.
      // A nose already following the move (Orbit, a running Kite, a Tail
      // circling to the six, FallBack, Flee) can already side-step: left as is.
      const off = wrapAngle(moveAngle - leadAngle);
      facing = leadAngle + (off > NUDGE_MAX_OFF ? NUDGE_MAX_OFF : off < -NUDGE_MAX_OFF ? -NUDGE_MAX_OFF : off);
    } else if (!this._faceMove) {
      this._pilot.turn.aimCone = aimCone;
    }
    // Afterburner: whenever the manoeuvre wants it, above the reserve; a
    // Break, or a ship running from a tailer (`spendReserve`), may spend the
    // reserve (the pool itself still runs dry).
    const boost = goal.boost
      && (this.energy >= BOOST_RESERVE_FRAC * this.energyMax || this._picker.current === MANOEUVRE_BREAK
        || goal.spendReserve);
    return this.fly(self, facing, wvx, wvy, boost,
      goal.throttleNow ? RUN_NOW_PILOT_PARAMS : goal.spendReserve ? RUN_PILOT_PARAMS : COMBAT_PILOT_PARAMS);
  }

  /**
   * Ally fire lanes (slice 5b): for up to `ALLY_LANE_K` same-side AI-flown
   * wingmen within fire range that aimed this tick or the last few, danger
   * along wingman → its aim point (lane half-width = own radius ×
   * `ALLY_LANE_RADIUS_MUL` + the wingman's radius; look-ahead 1 s at
   * max(cruise, own speed)). Same side = `sideAt === allegiance`, pilot slot
   * or not: a player-owned AI-flown hull sits in a pilot slot on the players
   * side (RTS Part B), and its squadmates keep out of its lane. AI-flown =
   * an aim on the board: a human pilot posts none, so no lane is ever made
   * from a human's nose. Returns true when this ship sits INSIDE a lane (it
   * must get out: the caller lets the nose swing toward the exit). Alloc-free
   * (reuses `_nbIdx`).
   */
  private addAllyLanes(self: AiEntity, nb: IAiNeighbourQuery, aims: IAiAimBoard): boolean {
    const idx = this._nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, this.fireRange, COMBAT_NEIGHBOUR_K, idx, self.id);
    const tick = this._tac.tick;
    const sp = Math.hypot(self.vx, self.vy);
    const lookahead = ALLY_LANE_LOOKAHEAD_S * (sp > this.handling.cruiseSpeed ? sp : this.handling.cruiseSpeed);
    let used = 0;
    let inside = false;
    for (let k = 0; k < n && used < ALLY_LANE_K; k++) {
      const i = idx[k]!;
      if (nb.sideAt(i) !== this.allegiance) continue;
      // Only an AI-flown ship posts its aim; a human pilot has none.
      if (!aims.read(nb.idAt(i), tick)) continue;
      used++;
      const hw = ALLY_LANE_RADIUS_MUL * this.kind.radius + nb.radiusAt(i);
      const ax = nb.xAt(i);
      const ay = nb.yAt(i);
      addAllyLaneDanger(this._ctxMaps, self.x, self.y, ax, ay, aims.readX, aims.readY, hw, lookahead, ALLY_LANE_WEIGHT);
      if (!inside && insideAllyLane(self.x, self.y, ax, ay, aims.readX, aims.readY, hw)) inside = true;
    }
    if (inside) this._laneExitCount++;
    return inside;
  }

  /** Test-visible: combat ticks spent inside a wingman's fire lane. */
  getLaneExitTicks(): number { return this._laneExitCount; }

  /**
   * Blocked-fire nudge (slice 5b): while the line-of-fire gate held a shot in
   * the last `NUDGE_TICKS` (and the decayed count is at least
   * `NUDGE_MIN_BLOCKS`), Hold, Tail and an attack run's dive add interest toward a point one
   * `combatSeparation` aside of the target line, on the side away from the
   * ally in the way (latched per block). Ends early once there. Returns
   * whether it is nudging. A run's pull-off / extend and a break fly their own course.
   */
  private writeBlockedNudge(self: AiEntity, ux: number, uy: number): boolean {
    // The shooting stances side-step: Hold, Tail, a run's dive, Orbit and a
    // Kite backing off nose on (Orbit / Kite replaced Hold for gunships and
    // missile boats, slice 6b). A run's pull-off / extend, a Break, a running
    // Kite, FallBack and Flee fly their own course.
    const cur = this._picker.current;
    if (cur !== MANOEUVRE_HOLD && cur !== MANOEUVRE_TAIL && cur !== MANOEUVRE_ORBIT
      && !(cur === MANOEUVRE_ATTACK_RUN && this._attackRun.diving)
      && !(cur === MANOEUVRE_KITE && !this._kite.running)) return false;
    const tick = this._tac.tick;
    if (tick - this._lastBlockedTick > NUDGE_TICKS || this.getRecentBlocks(tick) < NUDGE_MIN_BLOCKS) return false;
    if (this._nudgeFromTick !== this._lastBlockedTick) {
      // A fresh block: pick the side and the reposition point.
      const side = blockedNudgeSide(self.x, self.y, ux, uy, this._blockerX, this._blockerY, self.vx, self.vy);
      this._nudgeFromTick = this._lastBlockedTick;
      this._nudgeGoalX = self.x - uy * side * this.combatSeparation;
      this._nudgeGoalY = self.y + ux * side * this.combatSeparation;
    }
    const gx = this._nudgeGoalX - self.x;
    const gy = this._nudgeGoalY - self.y;
    if (gx * gx + gy * gy < NUDGE_ARRIVED * NUDGE_ARRIVED * this.combatSeparation * this.combatSeparation) return false;
    addInterestToward(this._ctxMaps, gx, gy, NUDGE_WEIGHT, NUDGE_SHAPE);
    this._nudgeCount++;
    return true;
  }

  /** Test-visible: combat ticks spent side-stepping a blocked line. */
  getNudgeTicks(): number { return this._nudgeCount; }

  /** Test-visible: ticks spent dodging a hull (hull avoidance). */
  getAvoidTicks(): number { return this._avoidTicks; }

  /** Dodge thrust (u/s²): the afterburner while the pool allows it. */
  private avoidAccel(): number {
    const boostMul = this.energy >= BOOST_RESERVE_FRAC * this.energyMax ? (this.kind.boostMultiplier ?? 1) : 1;
    return this.handling.thrustAccel * 60 * boostMul;
  }

  /** Refresh the tactical context for this combat tick (plain writes, #14). */
  private fillTactical(
    self: AiEntity,
    tick: number,
    target: MountTargetView,
    dist: number,
    ux: number,
    uy: number,
    aimX: number,
    aimY: number,
    leadAngle: number,
    bearingError: number,
    along: number,
    boostOk: boolean,
  ): void {
    const c = this._tac;
    c.tick = tick;
    c.x = self.x; c.y = self.y; c.vx = self.vx; c.vy = self.vy;
    c.angle = self.angle;
    c.fwdX = -Math.sin(self.angle);
    c.fwdY = Math.cos(self.angle);
    c.tx = target.x; c.ty = target.y; c.tvx = target.vx; c.tvy = target.vy;
    const tsNow = Math.hypot(target.vx, target.vy);
    if (target.id !== this._tSpeedId) {
      this._tSpeedId = target.id;
      this._tSpeedAvg = tsNow;
    } else {
      this._tSpeedAvg += (tsNow - this._tSpeedAvg) * TARGET_SPEED_GAIN;
    }
    c.targetSpeed = this._tSpeedAvg;
    c.targetIsShip = (target as { ship?: boolean }).ship !== false;
    c.dist = dist; c.ux = ux; c.uy = uy;
    c.aimX = aimX; c.aimY = aimY;
    c.leadAngle = leadAngle;
    c.offBoresight = bearingError < 0 ? -bearingError : bearingError;
    // d(dist)/dt = (v_target − v_self)·u; closing is its negative.
    c.closing = -((target.vx - self.vx) * ux + (target.vy - self.vy) * uy);
    const ts = tsNow;
    // Still-memory: a nudge does not make a parked / slow target a moving one.
    if (target.id !== this._stillTargetId) {
      this._stillTargetId = target.id;
      this._tParkedTick = -1_000_000;
      this._tSlowTick = -1_000_000;
      this._tParkedSince = -1;
    }
    const cruise = this.handling.cruiseSpeed;
    const minStill = TARGET_STILL_MIN_S * TICKS_PER_S_SIM;
    if (ts <= PARKED_SPEED_FRAC * cruise) {
      if (this._tParkedSince < 0) this._tParkedSince = tick;
      if (tick - this._tParkedSince >= minStill) this._tParkedTick = tick;
    } else {
      this._tParkedSince = -1;
    }
    if (ts < SLOW_SPEED_FRAC * cruise) this._tSlowTick = tick;
    const mem = TARGET_STILL_MEMORY_S * TICKS_PER_S_SIM;
    c.tParkedHeld = tick - this._tParkedTick <= mem;
    c.tSlowHeld = tick - this._tSlowTick <= mem;
    c.targetAspectCos = ts > PARKED_SPEED_FRAC * this.handling.cruiseSpeed ? -(target.vx * ux + target.vy * uy) / ts : 0;
    c.threatBearingCos = c.fwdX * ux + c.fwdY * uy;
    // The same bearing from the target's side: its nose vs target → me.
    const ta = (target as { angle?: number }).angle;
    const known = ta !== undefined && !Number.isNaN(ta);
    c.targetBowCos = known ? Math.sin(ta) * ux - Math.cos(ta) * uy : 1;
    c.tFwdX = known ? -Math.sin(ta) : 0;
    c.tFwdY = known ? Math.cos(ta) : 0;
    const hp = self.health;
    c.hullFrac = hp === undefined ? 1 : Math.max(0, Math.min(1, hp / this.kind.maxHealth));
    c.holdAlong = along;
    c.holdBoost = boostOk;
  }

  /**
   * The decision layer's cadence: re-score every `DECIDE_PERIOD` ticks
   * (slot-staggered; `LOD_DECIDE_PERIOD` with no pilot near) or at once when
   * the running manoeuvre is done. A change of mind waits out the role's
   * `reactionTicks` (a Break included: noticing the bandit takes time); a
   * finished manoeuvre is replaced at once.
   */
  private runDecision(self: AiEntity, view: AiWorldView, nb: IAiNeighbourQuery): void {
    const c = this._tac;
    const p = this._picker;
    const tick = view.tick;
    if (!this._seeded) {
      const h = fnv1a32(self.id);
      this._idHash = h;
      c.rng.reseed(h);
      p.seed(c.rng);
      this._slot = h % 60;
      this._seeded = true;
    }
    const done = this._manoeuvres[p.current]!.isDone(c);
    if (done || decisionDue(tick, this._slot, this._lod)) {
      this._lod = !this.pilotNear(self, view);
      c.recentHits = this.recentHitsAt(tick);
      c.recentBlocks = this.getRecentBlocks(tick);
      this.countSides(self, nb);
      this.scanSensors(self, nb);
      if (view.stats !== undefined) view.stats.decisions++;
      if (isTailed(c)) this._tailedDecisions++;
      // Morale: a trigger (hull 50 / 25 %, burst, capital lost, outnumbered)
      // rolls the die; FallBack / Flee then run locked. A fleeing ship keeps
      // fleeing.
      const trig = tick >= this._moraleNextRollAt ? this._morale.update(tick, c.hullFrac, c.allies, c.enemies) : -1;
      if (trig !== -1 && p.current !== MANOEUVRE_FLEE) {
        const outcome = this.rollMoraleNow(tick, c.hullFrac);
        this._moraleNextRollAt = tick + MORALE_LOCK_TICKS;
        this._lastMorale = outcome;
        if (outcome === MORALE_OUTCOME.FallBack) {
          this.switchManoeuvre(MANOEUVRE_FALL_BACK, tick);
          this._moraleLockUntil = tick + MORALE_LOCK_TICKS;
          this._fallBackCapUntil = tick + FALLBACK_MAX_TICKS;
          return;
        }
        if (outcome === MORALE_OUTCOME.Flee) {
          this.switchManoeuvre(MANOEUVRE_FLEE, tick);
          return;
        }
        // Fight on: normal scoring below.
      }
      if (p.current === MANOEUVRE_FLEE) return;
      if (p.current === MANOEUVRE_FALL_BACK) {
        // Regroup, then re-engage (owner 2026-11-14): held until it reaches
        // its friends (capped; the lock is its floor), and handed back to
        // the normal combat manoeuvres the moment it is among them or has
        // nobody to reach (`done`), lock or not: a ship held in FallBack at
        // its anchor parked beside an enemy.
        if (!done && (tick < this._moraleLockUntil || tick < this._fallBackCapUntil)) return;
        // Regrouped, or the cap ran out: choose afresh.
        this.switchManoeuvre(p.decide(c, this.role, true), tick);
        return;
      }
      // A running Kite is already getting out from under its attacker: a
      // Break across the line would hand the gap back (take 6: the Heavy
      // flipped Kite / Break every 1-2 s).
      const want = p.decide(c, this.role, done, !(p.current === MANOEUVRE_KITE && this._kite.running));
      // Tailed with a Break on offer (not cooling down) yet another pick won.
      if (want !== MANOEUVRE_BREAK && p.scores[MANOEUVRE_BREAK]! > 0 && isTailed(c)) this._breakRefused++;
      if (done) {
        this.switchManoeuvre(want, tick);
      } else if (want !== p.current) {
        if (this._pendingId !== want) {
          this._pendingId = want;
          this._pendingAt = tick + this.role.reactionTicks;
        }
      } else {
        this._pendingId = -1;
      }
    }
    if (this._pendingId >= 0 && tick >= this._pendingAt) this.switchManoeuvre(this._pendingId as ManoeuvreId, tick);
  }

  private switchManoeuvre(id: ManoeuvreId, tick: number): void {
    if (id === MANOEUVRE_BREAK && this._picker.current !== MANOEUVRE_BREAK) this._breaksBegun++;
    this._picker.switchTo(id, tick);
    this._manoeuvres[id]!.begin(this._tac);
    this._avoid.resetSide();
    this._pendingId = -1;
  }

  /**
   * Sensor picture at decision time (one K ≤ 8 grid query within sensor
   * range): same-side ships (their centroid, the nearest friendly capital:
   * the fall-back anchor) and enemies (count, summed radii, radius-weighted
   * centroid: what Flee runs from). Plain writes into the context (#14).
   */
  private scanSensors(self: AiEntity, nb: IAiNeighbourQuery): void {
    const c = this._tac;
    const idx = this._nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, this.sensorRange, COMBAT_NEIGHBOUR_K, idx, self.id);
    let allies = 0, ax = 0, ay = 0;
    let enemies = 0, ew = 0, ex = 0, ey = 0;
    let capD2 = Infinity, capX = 0, capY = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      const x = nb.xAt(i), y = nb.yAt(i);
      const pilot = nb.isPilotAt(i);
      const side = nb.sideAt(i);
      if (pilot ? this.friendlyToPilots : side === this.allegiance) {
        allies++;
        ax += x; ay += y;
        // A friendly capital anchors morale whoever flies it (a pilot's too).
        if (nb.isCapitalAt(i)) {
          const d2 = (x - self.x) * (x - self.x) + (y - self.y) * (y - self.y);
          if (d2 < capD2) { capD2 = d2; capX = x; capY = y; }
        }
      } else if (pilot ? !this.friendlyToPilots : !isNpcAllegianceId(side) || !isFriendly(this.allegiance, side)) {
        const r = nb.radiusAt(i) > 1 ? nb.radiusAt(i) : 1;
        enemies++;
        ew += r; ex += x * r; ey += y * r;
      }
    }
    this._sensorAllies = allies;
    this._enemySize = ew;
    this._capitalNear = capD2 < Infinity;
    c.sensorEnemies = enemies;
    if (enemies > 0) { c.threatX = ex / ew; c.threatY = ey / ew; }
    if (this._capitalNear) { c.hasAnchor = true; c.anchorX = capX; c.anchorY = capY; }
    else if (allies > 0) { c.hasAnchor = true; c.anchorX = ax / allies; c.anchorY = ay / allies; }
    else c.hasAnchor = false;
  }

  /** Roll the morale die from the current sensor picture (alloc-free). */
  private rollMoraleNow(tick: number, hullFrac: number): MoraleOutcome {
    const m = this._moraleIn;
    m.hullFrac = hullFrac;
    m.recentDamageRate = this._morale.windowDamageFrac(tick);
    m.alliesNear = this._sensorAllies;
    m.enemiesNear = this._tac.sensorEnemies;
    m.ownSize = this.kind.radius;
    m.enemySize = this._enemySize;
    m.isCapitalNearbyFriendly = this._capitalNear;
    return this._moraleRoll(m, this.role.moraleWeights, moraleSeed(this._idHash, this._morale.triggerCount));
  }

  /**
   * Flee's end: ask the server to warp out along the escape heading
   * (`intent.warpOut`), then stand down: forget every hostility, leave the
   * squad's flock and hold at the drop point (the same move-to a director
   * order uses). A server without the hook leaves the ship disengaged.
   */
  private requestWarpOut(self: AiEntity, intent: AiIntent): void {
    const d = WARP_OUT_SENSOR_MUL * this.sensorRange;
    const w = this._warpScratch;
    w.x = self.x + this._flee.dirX * d;
    w.y = self.y + this._flee.dirY * d;
    intent.warpOut = w;
    intent.fire = undefined;
    this._warpOuts++;
    this.hostileTo.clear();
    this.lastHitByPlayer.clear();
    this.state = 'IDLE';
    this.prevTargetId = null;
    this._moraleLockUntil = -1;
    this.switchManoeuvre(MANOEUVRE_HOLD, this._tac.tick);
    this.setMoveTarget(w.x, w.y);
    this._modeCtx.tick = this._tac.tick;
    this._leaving.begin(this._modeCtx);
  }

  /** Any pilot hull within `LOD_PILOT_RANGE_MUL` × sensor range? */
  private pilotNear(self: AiEntity, view: AiWorldView): boolean {
    const r = LOD_PILOT_RANGE_MUL * this.sensorRange;
    const r2 = r * r;
    const ps = view.players;
    for (let i = 0; i < ps.length; i++) {
      const dx = ps[i]!.x - self.x;
      const dy = ps[i]!.y - self.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  /** Same-side and other ships within `COUNT_RANGE_MUL` × fire range (K ≤ 8). */
  private countSides(self: AiEntity, nb: IAiNeighbourQuery): void {
    const idx = this._nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, this.fireRange * COUNT_RANGE_MUL, COMBAT_NEIGHBOUR_K, idx, self.id);
    let allies = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      if (nb.isPilotAt(i) ? this.friendlyToPilots : nb.sideAt(i) === this.allegiance) allies++;
    }
    this._tac.allies = allies;
    this._tac.enemies = n - allies;
  }

  /** Test-visible: the last combat context-steering resolve (null if the
   *  last combat tick had no neighbour query). */
  lastCombatSteer(): Readonly<ContextSteerOutput> | null {
    return this._ctxUsed ? this._ctxOut : null;
  }

  /** Test-visible: is the nose following the move heading (not the lead)? */
  isFacingMove(): boolean { return this._faceMove; }

  /**
   * Capital engagement (plan prancy-squishing-donut Phase 3). Out of reach:
   * close bow-first (the wanted velocity points at the target, so while the
   * target is abaft the beam the pilot backs its engines: reverse brakes the
   * way it carries AWAY and backs it toward the target while the bow comes
   * round — showcase-capital-duel, 2026-11-12). In reach: turn the beam toward
   * the target (whichever side is nearer the current heading) so fore AND aft
   * turrets bear, biased in or out to hold `fireRange × BROADSIDE_STANDOFF`,
   * steaming along that heading at a speed that grows with the range error, so
   * the hull circles its target. Turning is the kind's own torque turn (slow
   * to start and stop). Never fires: the turrets do, under WeaponMountTicker
   * fire control. Allocation-free.
   */
  private tickBroadside(self: AiEntity, target: MountTargetView, dx: number, dy: number, dist: number, rangeDist: number): AiIntent {
    // An attack order takes a guarding capital off its post (slice 8).
    if (this.guardOn && target.id !== this.orderedTargetId) return this.tickGuardBroadside(self, dx, dy);
    const bearing = facingOf(dx, dy);
    const cruise = this.handling.cruiseSpeed;
    if (rangeDist > this.fireRange) {
      const s = cruise / dist;
      return this.fly(self, bearing, dx * s, dy * s, rangeDist > this.fireRange * ENGAGE_DISTANCE_RATIO);
    }
    const port = wrapAngle(bearing + Math.PI / 2);
    const stbd = wrapAngle(bearing - Math.PI / 2);
    const usePort = Math.abs(wrapAngle(port - self.angle)) <= Math.abs(wrapAngle(stbd - self.angle));
    const standoff = this.fireRange * BROADSIDE_STANDOFF;
    // + when too far (turn in toward the target), − when too close; 0 inside
    // the dead-band (at the stand-off: hold the beam, keys off).
    const raw = Math.max(-1, Math.min(1, (rangeDist - standoff) / standoff));
    const over = Math.max(0, Math.abs(raw) - BROADSIDE_RANGE_DEADBAND) / (1 - BROADSIDE_RANGE_DEADBAND);
    const err = raw < 0 ? -over : over;
    const bias = err * BROADSIDE_RANGE_STEER;
    const desired = usePort ? wrapAngle(port - bias) : wrapAngle(stbd + bias);
    // Hold station: steam only to correct range (none at the stand-off), or
    // the hull carries itself out of its own guns' reach. The target's own
    // motion is matched so a moving target stays in reach.
    const speed = cruise * BROADSIDE_SPEED * Math.abs(err);
    const hx = -Math.sin(desired);
    const hy = Math.cos(desired);
    return this.fly(self, desired, hx * speed + target.vx, hy * speed + target.vy, false);
  }

  /**
   * A guarding capital in combat (owner decision 2026-11-11: "It should stay
   * close to the thing it's defending, obviously"). It never chases the
   * stand-off or a target out of reach: it keeps station at its post and lets
   * the turrets do the fighting. Station-keeping: the wanted velocity is zero
   * inside `GUARD_HOLD_FRAC` of the radius and grows toward the post beyond it;
   * the pilot thrusts or reverses along the hull axis (the only axis a ship
   * thrusts on) to close the gap. Inside `GUARD_RETURN_FRAC` of the radius the
   * hull turns its beam to the target so fore and aft turrets bear; beyond it,
   * it turns its axis (bow or stern, whichever is nearer) to the correction so
   * thrust or reverse can bring it back. Never fires itself. Allocation-free.
   */
  private tickGuardBroadside(self: AiEntity, dx: number, dy: number): AiIntent {
    const px = this.guardX - self.x;
    const py = this.guardY - self.y;
    const dPost = Math.hypot(px, py);
    const r = this.guardR;
    const vMax = this.kind.maxSpeed;
    const hold = r * GUARD_HOLD_FRAC;
    let want = 0;
    if (dPost > hold) want = vMax * GUARD_RETURN_SPEED * Math.min(1, (dPost - hold) / (r - hold));
    const ux = dPost > 1e-6 ? px / dPost : 0;
    const uy = dPost > 1e-6 ? py / dPost : 0;
    const wvx = ux * want;
    const wvy = uy * want;
    const ex = wvx - self.vx;
    const ey = wvy - self.vy;
    let desired: number;
    if (dPost > r * GUARD_RETURN_FRAC && Math.hypot(ex, ey) > 1e-6) {
      const ahead = facingOf(ex, ey);
      const astern = wrapAngle(ahead + Math.PI);
      desired = Math.abs(wrapAngle(ahead - self.angle)) <= Math.abs(wrapAngle(astern - self.angle)) ? ahead : astern;
    } else {
      const bearing = facingOf(dx, dy);
      const port = wrapAngle(bearing + Math.PI / 2);
      const stbd = wrapAngle(bearing - Math.PI / 2);
      desired = Math.abs(wrapAngle(port - self.angle)) <= Math.abs(wrapAngle(stbd - self.angle)) ? port : stbd;
    }
    return this.fly(self, desired, wvx, wvy, false, GUARD_PILOT_PARAMS);
  }

  /** Give this drone a GUARD POST: the area (centre + radius) it was sent to
   *  defend. A broadside capital with a post fights from it (see
   *  `tickGuardBroadside`) instead of holding its gun stand-off; any other
   *  ship engages only targets inside the radius (measured from the post)
   *  and flies back to the post when it has none (the guard leash). The radius is
   *  at least `shipTuning(kind).guardRadiusMin` (#18), so a big hull has room
   *  to turn. Independent of the move target / flock roles (those steer the
   *  IDLE drone). Server-only: the client never ticks the drone brain.
   *
   *  `anchorId` makes the post FOLLOW that ship (an escort guards round
   *  the ship it escorts): each tick the post moves to the anchor's live pose
   *  (`view.resolveEntityInto`); while the anchor can't be resolved the post
   *  holds its last known spot ((x, y) until the first resolve); the post is
   *  cleared when the anchor leaves the AI controller (`noteEntityGone`).
   *  Omitted / null ⇒ a fixed post at (x, y). */
  setGuardPost(x: number, y: number, radius: number, anchorId: string | null = null): void {
    this.guardOn = true;
    this.guardAnchorId = anchorId;
    this.guardX = x;
    this.guardY = y;
    this.guardR = Math.max(radius, shipTuning(this.kind).guardRadiusMin);
    this._pickOptsGuard.maxDistance = this.guardR;
    this._pickOptsGuard.prevMaxDistance = this.guardR;
    this._pickOptsGuardRetaliate.maxDistance = this.guardR + this.fireRange;
    this._pickOptsGuardRetaliate.prevMaxDistance = this.guardR + this.fireRange;
    // A post is a hold: it ends a hunt and a travel.
    this.hunting = false;
    this.travel = TRAVEL_NONE;
  }

  clearGuardPost(): void {
    this.guardOn = false;
    this.guardAnchorId = null;
  }

  /** Another AI ship left the controller (died / despawned): a guard post
   *  anchored to it is cleared. */
  noteEntityGone(entityId: string): void {
    if (this.guardAnchorId === entityId) this.clearGuardPost();
  }

  /** Move an anchored guard post onto its anchor's live pose; an unresolved
   *  anchor leaves the post at its last known spot. Alloc-free (#14). */
  private followGuardAnchor(view: AiWorldView): void {
    const resolve = view.resolveEntityInto;
    if (!this.guardOn || resolve === undefined || !resolve(this.guardAnchorId!, this._guardAnchorScratch)) return;
    this.guardX = this._guardAnchorScratch.x;
    this.guardY = this._guardAnchorScratch.y;
  }

  /** The guard post leashes this ship's target pick: every ship with a post
   *  but a broadside capital (that one keeps `tickGuardBroadside`). */
  private guardLeash(): boolean {
    return this.guardOn && !this.broadside;
  }

  /** On-sight engagement on / off (RTS Part B slice 6): the Aggressive
   *  attitude engages anything hostile it sees; Defensive (off) only hits back
   *  at what is on its retaliation ledger (`markHostile`). Default on, so
   *  drones and robots are unchanged. Server-only. */
  setEngageOnSight(on: boolean): void {
    this.engageOnSight = on;
  }

  /** Hold fire on / off (RTS Part B slice 7): on ⇒ no target pick at all, so
   *  no fire, no chase and no turning toward an attacker; the ship keeps
   *  flying its job. Attackers still land on the retaliation ledger
   *  (`markHostile`), so lifting it under Defensive answers one that hit
   *  within `FORGET_TICKS`. An attack order (`setOrderedTarget`) is still
   *  obeyed: that target alone is chased and fired on. Independent of `setEngageOnSight`, which keeps
   *  the attitude to return to. Default off. Server-only. */
  setHoldFire(on: boolean): void {
    this.holdFire = on;
  }

  /**
   * RTS Part B slice 8: the owner's ATTACK ORDER target (null lifts it). The
   * target goes on the retaliation ledger (so a Defensive ship fights even a
   * neutral) and stays there while ordered; inside the usual pick it carries
   * `ORDERED_TARGET_PRIORITY` (spread targets, dwell and stickiness intact)
   * and is free of the sensor cap and the guard leash (a guarding capital
   * leaves its post for it). When it dies or the order is replaced the ship
   * goes back to its job: the post, move target and hunt are untouched.
   * Under hold fire the ordered target is the ONLY one engaged (no other
   * pick, no retaliation); when the order ends hold fire resumes. A re-keyed ship (its owner took
   * or let go of the controls) keeps its sticky pick. Server-only.
   */
  setOrderedTarget(id: string | null, atTick: number): void {
    const next = id === this.ownerId ? null : id;
    const prev = this.orderedTargetId;
    if (next === prev) return;
    if (prev !== null) {
      // Forget the order's ledger mark unless the target hit this ship since.
      if (this.orderMarkTick >= 0 && this.lastHitByPlayer.get(prev) === this.orderMarkTick) {
        this.hostileTo.delete(prev);
        this.lastHitByPlayer.delete(prev);
      }
      if (this.prevTargetId === prev) this.prevTargetId = next;
    }
    this.orderedTargetId = next;
    this.orderMarkTick = -1;
    if (next !== null) {
      this.hostileTo.add(next);
      if (!this.lastHitByPlayer.has(next)) {
        this.lastHitByPlayer.set(next, atTick);
        this.orderMarkTick = atTick;
      }
      this.state = 'COMBAT';
    } else if (this.hostileTo.size === 0) this.state = 'IDLE';
  }

  /** Test-visible: the attack-order target (null = none). */
  getOrderedTarget(): string | null { return this.orderedTargetId; }

  /** Test-visible: holding fire? */
  isHoldingFire(): boolean { return this.holdFire; }

  /** Hunt on / off (RTS Part B slice 6): on lifts the guard leash and the
   *  move target, widens on-sight engagement to the sensor range, and with
   *  nothing to fight the ship searches the sector (`tickSearch`). A later
   *  guard post (a hold) ends the hunt. Server-only. */
  setHunt(on: boolean): void {
    if (on) {
      this.guardOn = false;
      this.moveTarget = null;
      this.travel = TRAVEL_NONE;
      this.leaderId = null;
      this._flockLeaderCruise = false;
      if (!this.hunting) this.searchReset = true;
    }
    this.hunting = on;
  }

  /** Test-visible: hunting? */
  isHunting(): boolean { return this.hunting; }

  /**
   * RTS Part B slice 9: an owner's Move (or a Retreat) to (x, y). The ship
   * flies there at its full cruise (a long leg at its top speed, boosting
   * while the pool pays) and does not stop to fight: it still picks a target
   * (its locks and trigger follow it) but fires only at one already in its
   * sights, never turning toward it or chasing. Arrived (inside
   * `shipTuning.wingmanArrive`, nearly stopped) it guards the point
   * (`getTravelState` ⇒ arrived). Ends a hunt and the guard post (the
   * leash would hold it to the old post); a guard post, a hunt or a stop
   * ends the travel. Hold fire still wins (no target, no trigger).
   * Server-only.
   */
  setTravel(x: number, y: number): void {
    this.setMoveTarget(x, y);
    this.guardOn = false;
    this.guardAnchorId = null;
    this.hunting = false;
    this.travel = TRAVEL_ON_THE_WAY;
    this.travelX = x;
    this.travelY = y;
    this.travelFights = false;
  }

  /**
   * RTS Part B slice 11: one leg of an owner's Patrol, from (fromX, fromY) to
   * (x, y) (the room steps the fleet route with `stepRoute`). A travel that
   * fights: Aggressive engages what it sees within its guard radius
   * (`shipTuning.guardRadiusMin`) of the leg, Defensive answers an attacker
   * out to that radius plus its weapon reach, hold fire just flies; a fight
   * is let go a guard radius off the route and the leg flies on. Activity
   * `patrolling`. Arrival is the travel's. Server-only.
   */
  setPatrolLeg(fromX: number, fromY: number, x: number, y: number): void {
    this.setTravel(x, y);
    this.travelFights = true;
    this.legFromX = fromX;
    this.legFromY = fromY;
    this.guardR = shipTuning(this.kind).guardRadiusMin;
    this._pickOptsGuard.maxDistance = this.guardR;
    this._pickOptsGuard.prevMaxDistance = this.guardR;
    this._pickOptsGuardRetaliate.maxDistance = this.guardR + this.fireRange;
    this._pickOptsGuardRetaliate.prevMaxDistance = this.guardR + this.fireRange;
  }

  /** Test-visible: flying a patrol leg? */
  isPatrolling(): boolean { return this.travel === TRAVEL_ON_THE_WAY && this.travelFights; }

  /** Patrol leg: the leash centre (`guardX`, `guardY`, unused while no post
   *  is held) = the nearest point of the leg to the ship. */
  private legLeashCentre(self: AiEntity): void {
    const ax = this.legFromX;
    const ay = this.legFromY;
    const bx = this.travelX - ax;
    const by = this.travelY - ay;
    const l2 = bx * bx + by * by;
    let t = l2 > 1e-9 ? ((self.x - ax) * bx + (self.y - ay) * by) / l2 : 1;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    this.guardX = ax + bx * t;
    this.guardY = ay + by * t;
  }

  /** Travel state: `TRAVEL_NONE`, `TRAVEL_ON_THE_WAY` or `TRAVEL_ARRIVED`
   *  (stays until the next job: a guard post, a hunt, a new travel). */
  getTravelState(): TravelState { return this.travel; }

  /**
   * RTS Part B slice 9: Stop. The ship brakes to a halt along its course and
   * guards the spot it stops on: the post is where the pilot's brakes
   * (reverse plus damping, this kind's handling) bring it from (vx, vy) at
   * (x, y), so the nose stays on course and it never turns back for a point
   * it has already passed. Ends a travel and a hunt. Server-only.
   */
  stopAt(x: number, y: number, vx: number, vy: number): void {
    const v = Math.hypot(vx, vy);
    const h = this.handling;
    const a = h.reverseAccel * 60;
    const k = h.linearDamping;
    let d = 0;
    if (v > 1e-6) {
      if (a <= 0) d = k > 0 ? v / k : 0;
      else if (k <= 1e-9) d = (v * v) / (2 * a);
      else d = v / k - (a / (k * k)) * Math.log(1 + (k * v) / a);
    }
    const px = v > 1e-6 ? x + (vx / v) * d : x;
    const py = v > 1e-6 ? y + (vy / v) * d : y;
    this.setMoveTarget(px, py);
    this.setGuardPost(px, py, 0);
  }

  /**
   * What the ship is doing, for the owner's fleet panel (RTS Part B slice 9),
   * from this brain's own state: travelling ⇒ `moving`; fighting ⇒
   * `chasing` (target beyond its fire range) or `attacking`; hunting with
   * nothing found ⇒ `searching`; a post ⇒ `guarding` (`moving` while
   * flying back to it); a warp-out run ⇒ `retreating`; else `idle`.
   * Hold fire picks no target, so it reports the job it flies.
   */
  getActivity(): AiShipActivity {
    const job = this.pilotJob(JOB_ORDER_REPORT);
    if (job === JOB_LEAVING) return 'retreating';
    if (job === JOB_TRAVEL && (!this.travelFights || this.prevTargetId === null)) {
      return this.travelFights ? 'patrolling' : 'moving';
    }
    if (this.prevTargetId !== null) {
      return this._targetDist2 > this.fireRange * this.fireRange ? 'chasing' : 'attacking';
    }
    if (job === JOB_SEARCH) return 'searching';
    if (job === JOB_FLOCK) {
      // With its pack (RTS squads / escorts): guarding once it is close.
      const r = FLOCK_ACTIVITY_GAP_MUL * shipTuning(this.kind).flockFollow;
      return this._flockGap2 > r * r ? 'moving' : 'guarding';
    }
    if (job === JOB_GUARD) {
      const dx = this._lastX - this.guardX;
      const dy = this._lastY - this.guardY;
      return dx * dx + dy * dy > this.guardR * this.guardR ? 'moving' : 'guarding';
    }
    return 'idle';
  }

  /**
   * Hunt search: an expanding square (the standard search pattern) round
   * where the search began, legs `HUNT_LEG_SPACING_MUL` sighting ranges
   * apart (d, d, 2d, 2d, 3d, ...; each turn 90° left), the first leg along
   * the nose. Each leg is a plain fly-to (`tickMoveTo`, player controls); a
   * leg counts as flown once inside the arrive radius, so the ship rolls on
   * without stopping. Waypoints are clamped inside the sector; once the
   * square outgrows the sector the search starts again from where the ship
   * is. A fight that ends restarts it from there (`searchReset`, set by
   * the combat branch).
   */
  private tickSearch(self: AiEntity): AiIntent {
    const lim = SECTOR_PLAYABLE_HALF_EXTENT * HUNT_EDGE_FRAC;
    const d = HUNT_LEG_SPACING_MUL * this.sensorRange;
    if (this.searchReset) {
      this.searchReset = false;
      this.searchLeg = 0;
      this.searchDirX = -Math.sin(self.angle);
      this.searchDirY = Math.cos(self.angle);
      this.searchWpX = self.x;
      this.searchWpY = self.y;
      this.nextSearchLeg(d, lim);
    }
    // This leg flown (or clamped to where the ship already is): the next.
    for (let i = 0; i < 4; i++) {
      const dx = this.searchWpX - self.x;
      const dy = this.searchWpY - self.y;
      if (dx * dx + dy * dy > MOVE_ARRIVE_SLOW_RADIUS * MOVE_ARRIVE_SLOW_RADIUS) break;
      this.searchLeg++;
      // Turn 90° left: (x, y) → (-y, x).
      const t = this.searchDirX;
      this.searchDirX = -this.searchDirY;
      this.searchDirY = t;
      if ((Math.floor(this.searchLeg / 2) + 1) * d > 2 * lim) {
        // The square covers the sector: a new one from here.
        this.searchLeg = 0;
        this.searchWpX = self.x;
        this.searchWpY = self.y;
      }
      this.nextSearchLeg(d, lim);
    }
    return this.tickMoveTo(self, this.searchWpX, this.searchWpY);
  }

  /** The end of leg `searchLeg` from the last waypoint, clamped inside the
   *  sector. */
  private nextSearchLeg(d: number, lim: number): void {
    const len = (Math.floor(this.searchLeg / 2) + 1) * d;
    let x = this.searchWpX + this.searchDirX * len;
    let y = this.searchWpY + this.searchDirY * len;
    if (x > lim) x = lim; else if (x < -lim) x = -lim;
    if (y > lim) y = lim; else if (y < -lim) y = -lim;
    this.searchWpX = x;
    this.searchWpY = y;
  }

  /** The flock leader this ship follows (null = none: it leads or flies
   *  alone). Server-only, test-visible. */
  getFlockLeaderId(): string | null { return this.leaderId; }

  /** Test-visible: the effective guard radius (0 with no post). */
  getGuardRadius(): number {
    return this.guardOn ? this.guardR : 0;
  }

  /** Test-visible: the guard post's centre (null with no post). */
  getGuardPostX(): number | null { return this.guardOn ? this.guardX : null; }
  getGuardPostY(): number | null { return this.guardOn ? this.guardY : null; }

  /** Set/clear the in-sector move target — the LEADER's course (or a lone
   *  drone's destination). Setting a course clears any FOLLOWER role (you lead /
   *  move independently now), so a former follower promoted to leader stops
   *  flocking. The director re-issues the course each control tick. */
  setMoveTarget(x: number, y: number): void {
    this.leaderId = null;
    this._flockLeaderCruise = false;
    if (this.moveTarget === null) this.moveTarget = { x, y };
    else { this.moveTarget.x = x; this.moveTarget.y = y; }
  }

  /** Leader-led flocking (non-combat herding): assign this drone the LEADER's
   *  course. Same as `setMoveTarget` but flags it a flock leader so `tickMoveTo`
   *  THROTTLES its cruise (`LEADER_CRUISE_THROTTLE`) — the leader travels slower
   *  than its full-cruise followers so the herd tightens around it (replaces the
   *  old follower-boost; the user's "make the leader wait"). The director sets
   *  the course to the leader's OWN pose to make it hold while the flock gathers. */
  setFlockLeaderCourse(x: number, y: number): void {
    this.leaderId = null;
    this._flockLeaderCruise = true;
    if (this.moveTarget === null) this.moveTarget = { x, y };
    else { this.moveTarget.x = x; this.moveTarget.y = y; }
  }

  clearMoveTarget(): void {
    this.moveTarget = null;
    this.leaderId = null;
    this._flockLeaderCruise = false;
  }

  /** Leader-led flocking (non-combat herding): mark this drone a FOLLOWER of
   *  `leaderId`, herding to the leader's LIVE pose via cohesion/alignment/
   *  separation each tick (vs the old static wedge slot). `memberIds` (the
   *  squad) drives the separation rule. Copied into an owned buffer so the
   *  director may reuse its source array. Clears any leader course. */
  setFlockFollow(leaderId: string, memberIds: readonly string[]): void {
    this.leaderId = leaderId;
    this.moveTarget = null;
    // Following is the ship's job: it ends a travel and a hunt (RTS squads).
    this.travel = TRAVEL_NONE;
    this.hunting = false;
    if (this._flockLeaderPrev !== leaderId) this._flockGap2 = Infinity;
    this._flockLeaderPrev = leaderId;
    this._flockLeaderCruise = false;
    this._flockMemberIds.length = 0;
    for (let i = 0; i < memberIds.length; i++) this._flockMemberIds.push(memberIds[i]!);
  }

  /** Fly to (tx, ty) and stop there: face the slot and ask the pilot for a
   *  speed it can still brake from (the arrive ramp), capped at the calm
   *  cruise (or `cruiseCap`: an owner's Move flies at the full cruise, a
   *  long leg at the top speed with `boostOk`, `tickTravel`). At the slot
   *  the wanted velocity is zero and the nose stays put, so the pilot brakes
   *  to a stop with reverse instead of turning around.
   */
  private tickMoveTo(self: AiEntity, tx: number, ty: number, cruiseCap = -1, boostOk = false): AiIntent {
    const t = shipTuning(this.kind), nav = this._nav, h = this.handling, av = this._avoid;
    // A wreck piece or drifting rock on a collision course: dodge it first (navigation slice 8).
    if (!h.torqueTurn && av.check(self, h, this.kind.radius, this.shieldPad, this.avoidAccel(), this._viewTick, undefined, this._debris, true)) {
      this._avoidTicks++;
      return this.fly(self, facingOf(av.x, av.y), self.vx + av.x * h.maxSpeed, self.vy + av.y * h.maxSpeed, boostOk);
    }
    // Round rock: fly the route's next waypoint, braking for what lies ahead on it.
    if (nav !== null && nav.waypoint(self.id, self.x, self.y, tx, ty, t.navClearance, t.wingmanArrive)) {
      const w = arrive(self.x, self.y, nav.wpX, nav.wpY, 1, this._steerScratch), v = Math.min(cruiseCap >= 0 ? cruiseCap : this.handling.cruiseSpeed * CALM_CRUISE_FRAC, brakingSpeed(this.handling, nav.ahead));
      return this.fly(self, facingOf(w.dirX, w.dirY), w.dirX * v, w.dirY * v, boostOk);
    }
    const steer = arrive(self.x, self.y, tx, ty, MOVE_ARRIVE_SLOW_RADIUS, this._steerScratch);
    // Arrived: inside the distance one tap of thrust carries this hull before
    // damping stops it (live thrust per tick / damping), any press can only
    // overshoot the slot, so the pilot brakes to zero and lets go, as a player
    // who has arrived does. Without it a light hull (a fighter gains 18 u/s a
    // tick) taps forward and back across the slot for ever.
    const tapCoast = this.handling.linearDamping > 0 ? this.handling.thrustAccel / this.handling.linearDamping : 0;
    if (steer.thrustScale <= 0 || steer.dist <= tapCoast) return this.fly(self, self.angle, 0, 0, false);
    // A flock leader cruises SLOWER than its full-cruise followers so they
    // tighten into the herd around it (the "make the leader wait" lever).
    const cruise = cruiseCap >= 0
      ? cruiseCap
      : this.handling.cruiseSpeed * CALM_CRUISE_FRAC * (this._flockLeaderCruise ? LEADER_CRUISE_THROTTLE : 1);
    const speed = Math.min(cruise, brakingSpeed(this.handling, steer.dist));
    // Close in: keep the nose where it is and just brake (no turn-around for
    // an overshoot of a few lengths).
    const facing = steer.dist > t.flockFollow ? facingOf(steer.dirX, steer.dirY) : self.angle;
    return this.fly(self, facing, steer.dirX * speed, steer.dirY * speed, boostOk);
  }

  /**
   * Travel (RTS Part B slice 9, `setTravel`): fly the leg and arrive. The
   * full cruise; a leg longer than `TRAVEL_LONG_LEG_GUARD_MUL` guard radii
   * asks for the top speed and lets the pilot boost (its own gate: nose on
   * course, a real speed gap, the pool pays), the old wingman's long-leg
   * rule. Arrived (inside `wingmanArrive`, nearly stopped) ⇒ it guards the
   * point. `target` (picked this tick, or null): fired at only when it is
   * already in the sights; the ship never turns toward it.
   */
  private tickTravel(self: AiEntity, view: AiWorldView | null, target: MountTargetView | null): AiIntent {
    const x = this.travelX;
    const y = this.travelY;
    const t = shipTuning(this.kind);
    const h = this.handling;
    const dx = x - self.x;
    const dy = y - self.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= t.wingmanArrive * t.wingmanArrive
      && Math.hypot(self.vx, self.vy) <= h.maxSpeed * TRAVEL_ARRIVE_SPEED_FRAC) {
      // Arrived: guard the point (the post ends the travel).
      this.setGuardPost(x, y, 0);
      this.travel = TRAVEL_ARRIVED;
      return this.tickMoveTo(self, x, y);
    }
    const long = d2 > (TRAVEL_LONG_LEG_GUARD_MUL * t.guardRadiusMin) ** 2;
    const intent = this.tickMoveTo(self, x, y, long ? h.maxSpeed : h.cruiseSpeed, long);
    if (target !== null && view !== null) this.fireOnTheWay(self, view, target, intent);
    return intent;
  }

  /**
   * Travel's trigger: hold it at `target` only while the nose (or a turret's
   * arc) already covers the lead point and it is in range, by the same aim
   * rules as `tickCombat`'s fire gate (the hull cone for fixed guns, the
   * turret half-arc added for turret kinds). Never steers. A charge weapon
   * has no line to hold here (an owned hull's player pipeline has no
   * wind-up), so the charge rule does not apply.
   */
  private fireOnTheWay(self: AiEntity, view: AiWorldView, target: MountTargetView, intent: AiIntent): void {
    if (this.broadside) return;
    const rawDx = target.x - self.x;
    const rawDy = target.y - self.y;
    const dist = Math.hypot(rawDx, rawDy);
    if (dist < 1e-3) return;
    let rangeDist = dist;
    if (target.kindId != null) {
      const far = dist - shipHitBound(target.kindId);
      rangeDist = far > this.fireRange
        ? far
        : shipHullDistance(target.kindId, target.shieldUp === true, self.x, self.y, target.x, target.y, target.angle ?? 0);
    }
    if (rangeDist > this.fireRange) return;
    const lead = dist / this.leadMuzzleSpeed;
    const aimX = target.x + (target.vx - self.vx) * lead;
    const aimY = target.y + (target.vy - self.vy) * lead;
    const aimDx = aimX - self.x;
    const aimDy = aimY - self.y;
    const aimLen = Math.hypot(aimDx, aimDy);
    view.aims?.write(self.id, aimX, aimY, view.tick);
    const hullCone = hullFireCone(((target as { hitRadius?: number }).hitRadius ?? DEFAULT_AIM_RADIUS) + this.shotRadius, aimLen);
    const tolerance = this.maxTurretHalfArc > 0
      ? (rangeDist < this.fireRange * POINT_BLANK_RATIO ? DRONE_AIM_TOLERANCE_CLOSE : DRONE_AIM_TOLERANCE) + this.maxTurretHalfArc
      : hullCone;
    if (Math.abs(wrapAngle(facingOf(aimDx, aimDy) - self.angle)) > tolerance) return;
    this._aimValid = true;
    this._aimX = aimX;
    this._aimY = aimY;
    const f = this._fireScratch;
    if (aimLen > 1e-6) {
      f.dirX = aimDx / aimLen;
      f.dirY = aimDy / aimLen;
    } else {
      f.dirX = -Math.sin(self.angle);
      f.dirY = Math.cos(self.angle);
    }
    f.targetId = target.id;
    f.cone = hullCone;
    intent.fire = f;
  }

  /**
   * Leader-led flocking (non-combat herding) — the FOLLOWER path. Continuously
   * steer toward a standard boids blend resolved against LIVE poses every tick:
   * COHESION toward the leader with an ARRIVAL ramp (slows as it nears the
   * follow-distance — "slow down once close"), ALIGNMENT with the leader's
   * heading (the herd flies as one along the leader's course), and SEPARATION
   * from squad neighbours (holds spacing, spreads the blob into a herd). The
   * wanted velocity is the calm cruise scaled by the boids magnitude — NO
   * boost: the arrival ramp + the pilot's braking settle the follower into the
   * cluster with no overshoot/fling, and the LEADER is throttled / waits (see
   * `LEADER_CRUISE_THROTTLE` + the director) so a full-cruise follower can catch
   * it. Falls back to orbit when the leader / resolver is gone.
   */
  private tickFlock(self: AiEntity, view: AiWorldView): AiIntent {
    const resolve = view.resolveEntityInto;
    // Need the leader's live pose; without it (gone / no resolver) → orbit.
    if (!resolve || this.leaderId === null || !resolve(this.leaderId, this._leaderScratch)) {
      return this.tickJob(self, view, JOB_ORDER_NO_FLOCK);
    }
    const leaderX = this._leaderScratch.x;
    const leaderY = this._leaderScratch.y;
    const acc = this._flockAcc;
    resetFlock(acc);
    // COHESION toward the leader (its position is the herd's anchor — followers
    // bunch AROUND it) with the arrival ramp baked into addCohesion. SEPARATION
    // from every squad neighbour (incl. the leader) so they cluster around it at
    // a spacing rather than piling on. ALIGNMENT with the leader's heading so the
    // herd flies the course as one + keeps pace.
    const tuning = shipTuning(this.kind);
    addCohesion(acc, self.x, self.y, leaderX, leaderY, FLOCK_COHESION_GAIN, tuning.flockFollow);
    const gx = leaderX - self.x;
    const gy = leaderY - self.y;
    this._flockGap2 = gx * gx + gy * gy;
    for (let i = 0; i < this._flockMemberIds.length; i++) {
      const mid = this._flockMemberIds[i]!;
      if (mid === self.id) continue;
      const mx = mid === this.leaderId ? leaderX : (resolve(mid, this._neighborScratch) ? this._neighborScratch.x : NaN);
      if (Number.isNaN(mx)) continue;
      const my = mid === this.leaderId ? leaderY : this._neighborScratch.y;
      addSeparation(acc, self.x, self.y, mx, my, tuning.flockSeparation);
    }
    addAlignment(acc, this._leaderScratch.angle);
    const flock = resolveFlock(acc, this._flockOut);
    if (flock.thrustScale <= 1e-4) return this.fly(self, self.angle, 0, 0, false);
    // Calm cruise scaled by the boids desired-velocity magnitude. As the follower
    // settles at the follow-radius, cohesion ramps to ~0 and separation cancels
    // it, so the magnitude shrinks toward the alignment term alone → the pilot
    // eases off (and brakes the residual). A leader faster than that (a pilot
    // flying the squad's lead ship, RTS Part B slice 10; it cannot be made to
    // wait) sets the pace: a little over its speed so the pack closes up,
    // never over this ship's top speed and never boosting. An AI pilots' pack
    // leader is throttled below the calm cruise, so its pack is unchanged.
    const lv = Math.hypot(this._leaderScratch.vx, this._leaderScratch.vy);
    const pace = Math.min(this.handling.maxSpeed, Math.max(this.handling.cruiseSpeed * CALM_CRUISE_FRAC, lv * FLOCK_CATCH_UP));
    const speed = pace * flock.thrustScale;
    return this.fly(self, facingOf(flock.dirX, flock.dirY), flock.dirX * speed, flock.dirY * speed, false);
  }

  /**
   * Actuate through the virtual pilot: the control keys that face `facing`
   * and bring the velocity to (`wantVx`, `wantVy`), boosting when `boostOk`
   * and the NPC's energy pool can pay for the tick (same `BOOST_TICK_COST` a
   * pilot pays). Fills the pooled intent (input set, impulse fields zero, no
   * fire); the caller may attach `fire` afterwards.
   */
  private fly(
    self: AiEntity,
    facing: number,
    wantVx: number,
    wantVy: number,
    boostOk: boolean,
    params: Readonly<PilotParams> = DEFAULT_PILOT_PARAMS,
  ): AiIntent {
    const canBoost = boostOk && canAfford(this.energy, BOOST_TICK_COST);
    let bits = pilotInputs(
      this.handling, this._pilot, params,
      self.angle, self.angvel ?? 0, self.vx, self.vy,
      facing, wantVx, wantVy, canBoost,
    );
    // A latched decision may still hold boost the pool can no longer pay for.
    if ((bits & AI_INPUT_BOOST) !== 0) {
      if (canAfford(this.energy, BOOST_TICK_COST)) {
        this.energy = spendEnergy(this.energy, BOOST_TICK_COST);
        this._boostTicks++;
      } else bits &= ~AI_INPUT_BOOST;
    }
    // Turn-key reversals (left then right or back, releases between ignored).
    const turn = (bits & AI_INPUT_TURN_LEFT) !== 0 ? 1 : (bits & AI_INPUT_TURN_RIGHT) !== 0 ? -1 : 0;
    if (turn !== 0) {
      if (this._lastTurnKey !== 0 && turn !== this._lastTurnKey) this._turnReversals++;
      this._lastTurnKey = turn;
    }
    const out = this._intentScratch;
    out.fx = 0;
    out.fy = 0;
    out.torque = 0;
    out.setAngvel = undefined;
    out.input = bits;
    out.fire = undefined;
    out.warpOut = undefined;
    return out;
  }

  /** Test-visible: the ship's energy pool (boost AND weapons). */
  getEnergy(): number { return this.energy; }

  /** Test-visible: ticks flown with the afterburner lit. */
  getBoostTicks(): number { return this._boostTicks; }

  // ── Turret aim point (owner 2026-11-14: "The turrets also aren't turning
  // to shoot the direction they do") ─────────────────────────────────────
  // Where this pilot's guns want to point THIS tick: the lead point of its
  // combat target, whatever that is (a pilot, another ship, a structure).
  // The server's WeaponMountTicker slews turning mounts onto it, so a turret
  // ship's barrels follow the fight it is in, not only hostile pilots.
  // Cleared at the top of every tick; set only by combat. Plain fields (#14).
  private _aimValid = false;
  private _aimX = 0;
  private _aimY = 0;

  /** The lead point this tick's combat aims at (false = not in combat). */
  aimPoint(out: { x: number; y: number }): boolean {
    if (!this._aimValid) return false;
    out.x = this._aimX;
    out.y = this._aimY;
    return true;
  }

  /** Spend `cost` from the ship's one energy pool if it can pay (a player's
   *  `canAfford` → `spendEnergy`); false ⇒ nothing spent. The fire resolvers
   *  call this per slot trigger, so guns and boost share the pool. */
  trySpendEnergy(cost: number): boolean {
    if (!canAfford(this.energy, cost)) return false;
    this.energy = spendEnergy(this.energy, cost);
    return true;
  }

  /** The pool as a 0..1 fraction of the kind's `energyMax` (for tactics). */
  getEnergyFrac(): number { return this.energyMax > 0 ? this.energy / this.energyMax : 0; }
  /** Test-visible: turn-key reversals flown (left then right, or back). */
  getTurnReversals(): number { return this._turnReversals; }

  // ── Line-of-fire feedback (friendly fire; plan composed-harbor §4) ──────
  // The room's LineOfFireGate held this NPC's shot because a friendly body
  // was on the line. Plain fields only (#14); game ticks, never wall time
  // (#20). Read by later slices (the blocked-fire nudge + utility scoring).
  private _blockScore = 0;
  private _blockScoreTick = 0;
  private _lastBlockedTick = -1_000_000;
  private _blockerX = 0;
  private _blockerY = 0;
  /** Blocked-fire nudge (slice 5b): the block it was planned for and its
   *  reposition point. */
  private _nudgeFromTick = -1_000_000;
  private _nudgeGoalX = 0;
  private _nudgeGoalY = 0;
  private _nudgeCount = 0;
  private _laneExitCount = 0;

  /** At most one count per tick (a capital's barrels may each report). */
  noteBlocked(tick: number, blockerX: number, blockerY: number): void {
    this._blockerX = blockerX;
    this._blockerY = blockerY;
    if (tick === this._lastBlockedTick) return;
    this._blockScore = this.getRecentBlocks(tick) + 1;
    this._blockScoreTick = tick;
    this._lastBlockedTick = tick;
  }

  /** Decaying count of recent blocks: halves every `BLOCK_HALF_LIFE_TICKS`. */
  getRecentBlocks(tick: number): number {
    if (this._blockScore === 0) return 0;
    const age = tick - this._blockScoreTick;
    if (age <= 0) return this._blockScore;
    return this._blockScore * Math.pow(0.5, age / BLOCK_HALF_LIFE_TICKS);
  }

  /** Tick of the latest block (-1_000_000 when never blocked). */
  getLastBlockedTick(): number { return this._lastBlockedTick; }
  /** World position of the latest blocking ally. */
  getLastBlockerX(): number { return this._blockerX; }
  getLastBlockerY(): number { return this._blockerY; }
}

/** Line-of-fire feedback: the recent-block count halves every this many game
 *  ticks (0.5 s at 60 Hz). */
export const BLOCK_HALF_LIFE_TICKS = 30;
