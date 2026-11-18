import {
  type AiEntity,
  type AiIntent,
  type AiWorldView,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';
import { getWeapon, type WeaponMode } from '../combat/WeaponCatalogue.js';
import { hasTurretFireControl, mountWeaponReach } from '../combat/mountReach.js';
import { shipHitBound, shipHullDistance } from '../combat/shipHitShape.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import {
  isOnSightHostile,
  isFriendly,
  isNpcAllegianceId,
  ON_SIGHT_ENGAGE_RANGE,
  PLAYERS_SIDE,
  type AllegianceSide,
} from '../../shared-types/allegiances.js';
import { type MountTargetView } from './WeaponMountController.js';
import { arrive, makeSteerOutput, type SteerOutput } from './steering.js';
import { HullAvoid } from './hullAvoid.js';
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
import {
  FACE_AIM_LEAD,
  FACE_MOVE,
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_KITE,
  makeManoeuvreGoal,
  makeTacticalContext,
  MANOEUVRE_FALL_BACK,
  MANOEUVRE_FLEE,
  MANOEUVRE_HOLD,
  type IManoeuvre,
  type ManoeuvreGoal,
  type ManoeuvreId,
  type TacticalContext,
  JOB_COURSE, JOB_FLOCK, JOB_GUARD, JOB_LEAVING, JOB_ORBIT, JOB_SEARCH, JOB_TRAVEL,
  JOB_ORDER_NO_FLOCK, JOB_ORDER_REPORT, JOB_ORDER_TICK, MODE_GOAL_MOVE_TO, makePilotModeContext, makePilotModeGoal,
  type IPilotMode, type PilotJobId, type PilotModeContext, type PilotModeGoal,
} from './tactics/manoeuvre.js';
import { FlockMode } from './modes/flockMode.js';
import { GuardReturnMode } from './modes/guardReturnMode.js';
import { LeavingMode } from './modes/leavingMode.js';
import { PatrolMode } from './modes/patrolMode.js';
import { SearchMode } from './modes/searchMode.js';
import { TravelMode } from './modes/travelMode.js';
import { hullFireCone } from './hullFireCone.js';
import { PilotMorale } from './pilot/pilotMorale.js';
import { PilotSenses } from './pilot/pilotSenses.js';
import { TargetPick } from './pilot/targetPick.js';
import { BroadsideHelm } from './tactics/broadside.js';
import { TacticalFill } from './tactics/tacticalFill.js';
import { AttackRunManoeuvre, BreakManoeuvre, HoldManoeuvre, TailManoeuvre } from './tactics/manoeuvres.js';
import { FallBackManoeuvre, FleeManoeuvre, KiteManoeuvre, OrbitManoeuvre } from './tactics/stanceManoeuvres.js';
import {
  MORALE_OUTCOME,
  MoraleTracker,
  type MoraleOutcome,
} from './tactics/morale.js';
import { decisionDue, isTailed, ManoeuvrePicker } from './tactics/utility.js';
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
  FireLaneSteer,
  fireLaneAvoidanceOn,
  NUDGE_MAX_OFF,
  NUDGE_SPEED_FRAC,
} from './tactics/fireLanes.js';
import {
  DRONE_AIM_TOLERANCE,
  DRONE_AIM_TOLERANCE_CLOSE,
  POINT_BLANK_RATIO,
  DEFAULT_AIM_RADIUS,
  ENGAGE_DISTANCE_RATIO,
  COMBAT_PILOT_PARAMS,
  RUN_PILOT_PARAMS,
  RUN_NOW_PILOT_PARAMS,
  BOOST_RESERVE_FRAC,
  FORGET_TICKS,
  CALM_CRUISE_FRAC,
  MOVE_ARRIVE_SLOW_RADIUS,
  LEADER_CRUISE_THROTTLE,
  COMBAT_NEIGHBOUR_K,
  COMBAT_SEP_REACH,
  COMBAT_SEP_CORE,
  COMBAT_CROWD_SPEED,
  FACE_MOVE_ENTER,
  FACE_MOVE_EXIT,
  FACE_MOVE_MIN_SPEED,
  WARP_OUT_SENSOR_MUL,
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

export { hullFireCone } from './hullFireCone.js';
export { BLOCK_HALF_LIFE_TICKS } from './tactics/fireLanes.js';

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

  /** Leader-led flocking (non-combat herding): a FOLLOWER (`leaderId !== null`,
   *  set by the director via `setFlockFollow`) flocks to its leader's live pose
   *  each tick (`modes/flockMode.ts`). */
  private readonly _flock = new FlockMode();

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
   *  (`modes/searchMode.ts`). Plain fields (#14). */
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
  /** The target pick: candidate buffer + reused pick options (`ai/pilot/targetPick.ts`). */
  private readonly _targets: TargetPick;
  /** Decision-time senses (`ai/pilot/pilotSenses.ts`). */
  private readonly _senses: PilotSenses;

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
  private readonly _tacFill = new TacticalFill();
  private readonly _lanes = new FireLaneSteer();
  private readonly _broadsideHelm = new BroadsideHelm();
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
  /** Morale timers and the die (`ai/pilot/pilotMorale.ts`). */
  private readonly _moraleP = new PilotMorale(this._morale);
  /** fnv1a32 of the entity id (seeds the picker and the morale die). */
  private _idHash = 0;
  /** Warp-outs requested (test-visible). */
  private _warpOuts = 0;
  /** Peacetime modes (`ai/modes/`), preallocated (#14). */
  private readonly _leaving = new LeavingMode();
  private readonly _patrol = new PatrolMode();
  private readonly _guardReturn = new GuardReturnMode();
  private readonly _travel: TravelMode;
  private readonly _search: SearchMode;
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
    this._travel = new TravelMode({
      broadside: this.broadside, fireRange: this.fireRange, leadMuzzleSpeed: this.leadMuzzleSpeed,
      shotRadius: this.shotRadius, maxTurretHalfArc: this.maxTurretHalfArc,
    }, this._fireScratch);
    this._search = new SearchMode(this.sensorRange);
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
    this._targets = new TargetPick(this.hostileTo, this.allegiance, this.onSightPlayers, this.foesOfPlayers, this.ownerId, this.sensorRange);
    this._senses = new PilotSenses(this._nbIdx, this.allegiance, this.friendlyToPilots, this.sensorRange, this.fireRange);
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
    this._senses.noteHit(atTick);
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
  setMoraleRoll(fn: MoraleRollFn): void { this._moraleP.roll = fn; }
  /** Test-visible: the last morale roll's outcome (-1 = none yet). */
  getLastMoraleOutcome(): MoraleOutcome | -1 { return this._moraleP.last; }
  /** Test-visible: how many times this ship asked to warp out. */
  getWarpOutCount(): number { return this._warpOuts; }

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
    const tp = this._targets;
    const cand = tp.cand;
    // On sight (slice 6): a hunter sights out to its sensor range; Defensive
    // (`engageOnSight` off) sights nothing and fights only its ledger.
    const engageR = this.hunting ? this.sensorRange : ON_SIGHT_ENGAGE_RANGE;
    const engageR2 = engageR * engageR;
    const onSight = this.engageOnSight;
    const ordered = this.orderedTargetId;
    const n = tp.build(self, view, engageR2, onSight, ordered);
    let anyHostile = tp.anyHostile;
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
    const target = tp.pick(
      self, n, this.prevTargetId, sinceTicks, ordered, orderedLive, leash, this.guardX, this.guardY, this.guardR, anyHostile,
    );
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
    if (this.hunting) this._search.reset = true;
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
      if (this._flock.leaderId !== null) return JOB_FLOCK;
      if (this.guardOn) return JOB_GUARD;
      return JOB_ORBIT;
    }
    if (order === JOB_ORDER_TICK && this._flock.leaderId !== null) return JOB_FLOCK;
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
      case JOB_TRAVEL: return this.tickTravel(self, view, null);
      case JOB_FLOCK:
        // Leader gone (or no resolver): the next job, flock skipped.
        if (!this._flock.sense(view)) return this.tickJob(self, view, JOB_ORDER_NO_FLOCK);
        this.modeCtx(self, view.tick, job);
        return this.runMode(this._flock, self);
      default: // leaving, search, guard, course, orbit: mode files
        this.modeCtx(self, view.tick, job);
        return this.runMode(
          job === JOB_LEAVING ? this._leaving : job === JOB_SEARCH ? this._search : job === JOB_GUARD ? this._guardReturn : this._patrol,
          self,
        );
    }
  }

  /** Refresh the reused mode context (#14). */
  private modeCtx(self: AiEntity, tick: number, job: PilotJobId): PilotModeContext {
    const c = this._modeCtx;
    c.tick = tick; c.job = job; c.self = self; c.energy = this.energy; c.energyMax = this.energyMax;
    c.escapeX = this._flee.dirX; c.escapeY = this._flee.dirY; c.moveTarget = this.moveTarget;
    c.guardOn = this.guardOn; c.guardX = this.guardX; c.guardY = this.guardY;
    c.travelX = this.travelX; c.travelY = this.travelY;
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
      this._tacFill.fill(this._tac, self, view.tick, target, dist, ux, uy, aimX, aimY, desiredAngle, bearingError, along, boostOk,
        this.handling.cruiseSpeed, this.kind.maxHealth);
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
      const ln = this._lanes, tick = this._tac.tick;
      if (aims !== undefined && ln.addAllyLanes(self, nb, aims, this._nbIdx, this._ctxMaps, tick, this.fireRange,
        this.handling.cruiseSpeed, this.kind.radius, this.allegiance)) nudging = true;
      if (ln.writeBlockedNudge(self, ux, uy, this._ctxMaps, tick, this.combatSeparation,
        this._picker.current, this._attackRun.diving, this._kite.running)) nudging = true;
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

  /** Test-visible: combat ticks spent inside a wingman's fire lane. */
  getLaneExitTicks(): number { return this._lanes.laneExitTicks; }

  /** Test-visible: combat ticks spent side-stepping a blocked line. */
  getNudgeTicks(): number { return this._lanes.nudgeTicks; }

  /** Test-visible: ticks spent dodging a hull (hull avoidance). */
  getAvoidTicks(): number { return this._avoidTicks; }

  /** Dodge thrust (u/s²): the afterburner while the pool allows it. */
  private avoidAccel(): number {
    const boostMul = this.energy >= BOOST_RESERVE_FRAC * this.energyMax ? (this.kind.boostMultiplier ?? 1) : 1;
    return this.handling.thrustAccel * 60 * boostMul;
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
      this._lod = !this._senses.pilotNear(self, view);
      c.recentHits = this._senses.recentHitsAt(tick);
      c.recentBlocks = this.getRecentBlocks(tick);
      this._senses.countSides(self, nb, c);
      this._senses.scanSensors(self, nb, c);
      if (view.stats !== undefined) view.stats.decisions++;
      if (isTailed(c)) this._tailedDecisions++;
      // Morale: a trigger (hull 50 / 25 %, burst, capital lost, outnumbered)
      // rolls the die; FallBack / Flee then run locked. A fleeing ship keeps
      // fleeing.
      const outcome = this._moraleP.decide(
        tick, c, p.current === MANOEUVRE_FLEE, this._senses, this.kind.radius, this.role.moraleWeights, this._idHash,
      );
      if (outcome === MORALE_OUTCOME.FallBack) {
        this.switchManoeuvre(MANOEUVRE_FALL_BACK, tick);
        return;
      }
      if (outcome === MORALE_OUTCOME.Flee) {
        this.switchManoeuvre(MANOEUVRE_FLEE, tick);
        return;
      }
      // Fight on (or no roll): normal scoring below.
      if (p.current === MANOEUVRE_FLEE) return;
      if (p.current === MANOEUVRE_FALL_BACK) {
        // Regroup, then re-engage (owner 2026-11-14): held until it reaches
        // its friends (capped; the lock is its floor), and handed back to
        // the normal combat manoeuvres the moment it is among them or has
        // nobody to reach (`done`), lock or not: a ship held in FallBack at
        // its anchor parked beside an enemy.
        if (!done && (tick < this._moraleP.lockUntil || tick < this._moraleP.fallBackCapUntil)) return;
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
    this._moraleP.lockUntil = -1;
    this.switchManoeuvre(MANOEUVRE_HOLD, this._tac.tick);
    this.setMoveTarget(w.x, w.y);
    this._modeCtx.tick = this._tac.tick;
    this._leaving.begin(this._modeCtx);
  }

  /** Test-visible: the last combat context-steering resolve (null if the
   *  last combat tick had no neighbour query). */
  lastCombatSteer(): Readonly<ContextSteerOutput> | null {
    return this._ctxUsed ? this._ctxOut : null;
  }

  /** Test-visible: is the nose following the move heading (not the lead)? */
  isFacingMove(): boolean { return this._faceMove; }

  /** Broadside flying (`tactics/broadside.ts`); an attack order takes a
   *  guarding capital off its post (slice 8). */
  private tickBroadside(self: AiEntity, target: MountTargetView, dx: number, dy: number, dist: number, rangeDist: number): AiIntent {
    const b = this._broadsideHelm;
    if (this.guardOn && target.id !== this.orderedTargetId) b.guard(self, dx, dy, this.guardX, this.guardY, this.guardR, this.kind.maxSpeed);
    else b.fight(self, target, dx, dy, dist, rangeDist, this.fireRange, this.handling.cruiseSpeed);
    return this.fly(self, b.facing, b.wvx, b.wvy, b.boost, b.params);
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
    this._targets.setLeash(this.guardR, this.fireRange);
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
   *  nothing to fight the ship searches the sector (`modes/searchMode.ts`). A later
   *  guard post (a hold) ends the hunt. Server-only. */
  setHunt(on: boolean): void {
    if (on) {
      this.guardOn = false;
      this.moveTarget = null;
      this.travel = TRAVEL_NONE;
      this._flock.leaderId = null;
      this._flockLeaderCruise = false;
      if (!this.hunting) this._search.reset = true;
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
    this._targets.setLeash(this.guardR, this.fireRange);
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
      return this._flock.isWithPack(this.kind) ? 'guarding' : 'moving';
    }
    if (job === JOB_GUARD) {
      const dx = this._lastX - this.guardX;
      const dy = this._lastY - this.guardY;
      return dx * dx + dy * dy > this.guardR * this.guardR ? 'moving' : 'guarding';
    }
    return 'idle';
  }

  /** The flock leader this ship follows (null = none: it leads or flies
   *  alone). Server-only, test-visible. */
  getFlockLeaderId(): string | null { return this._flock.leaderId; }

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
    this._flock.leaderId = null;
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
    this._flock.leaderId = null;
    this._flockLeaderCruise = true;
    if (this.moveTarget === null) this.moveTarget = { x, y };
    else { this.moveTarget.x = x; this.moveTarget.y = y; }
  }

  clearMoveTarget(): void {
    this.moveTarget = null;
    this._flock.leaderId = null;
    this._flockLeaderCruise = false;
  }

  /** Leader-led flocking (non-combat herding): mark this drone a FOLLOWER of
   *  `leaderId`, herding to the leader's LIVE pose via cohesion/alignment/
   *  separation each tick (vs the old static wedge slot). `memberIds` (the
   *  squad) drives the separation rule. Copied into an owned buffer so the
   *  director may reuse its source array. Clears any leader course. */
  setFlockFollow(leaderId: string, memberIds: readonly string[]): void {
    this.moveTarget = null;
    // Following is the ship's job: it ends a travel and a hunt (RTS squads).
    this.travel = TRAVEL_NONE;
    this.hunting = false;
    this._flock.follow(leaderId, memberIds);
    this._flockLeaderCruise = false;
  }

  /** Fly to (tx, ty) and stop there: face the slot and ask the pilot for a
   *  speed it can still brake from (the arrive ramp), capped at the calm
   *  cruise (or `cruiseCap`: an owner's Move flies at the full cruise, a
   *  long leg at the top speed with `boostOk`, `modes/travelMode.ts`). At the slot
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

  /** Travel (`setTravel` / `setPatrolLeg`, `modes/travelMode.ts`): fly the
   *  leg; arrived, guard the point (the post ends the travel). `target`
   *  (picked this tick, or null): fired at only when already in the sights. */
  private tickTravel(self: AiEntity, view: AiWorldView, target: MountTargetView | null): AiIntent {
    const c = this.modeCtx(self, view.tick, JOB_TRAVEL);
    const tr = this._travel;
    if (tr.isDone(c)) {
      this.setGuardPost(c.travelX, c.travelY, 0);
      this.travel = TRAVEL_ARRIVED;
      return this.runMode(tr, self);
    }
    const intent = this.runMode(tr, self);
    if (target !== null && tr.fireOnTheWay(c, view, target, intent)) {
      this._aimValid = true;
      this._aimX = tr.aimX;
      this._aimY = tr.aimY;
    }
    return intent;
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
  // State lives in `tactics/fireLanes.ts` (`FireLaneSteer`).
  noteBlocked(tick: number, blockerX: number, blockerY: number): void { this._lanes.noteBlocked(tick, blockerX, blockerY); }
  /** Decaying count of recent blocks: halves every `BLOCK_HALF_LIFE_TICKS`. */
  getRecentBlocks(tick: number): number { return this._lanes.getRecentBlocks(tick); }
  /** Tick of the latest block (-1_000_000 when never blocked). */
  getLastBlockedTick(): number { return this._lanes.lastBlockedTick; }
  /** World position of the latest blocking ally. */
  getLastBlockerX(): number { return this._lanes.blockerX; }
  getLastBlockerY(): number { return this._lanes.blockerY; }
}

