import {
  type AiEntity,
  type AiIntent,
  type AiWorldView,
  type IAiBehaviour,
} from '../contracts/IAiBehaviour.js';
import { getWeapon, type WeaponMode } from '../combat/WeaponCatalogue.js';
import { hasTurretFireControl, mountWeaponReach } from '../combat/mountReach.js';
import { getShipKind, type ShipKind } from '../../shared-types/shipKinds.js';
import {
  isOnSightHostile,
  isFriendly,
  isNpcAllegianceId,
  ON_SIGHT_ENGAGE_RANGE,
  PLAYERS_SIDE,
  type NpcAllegianceId,
} from '../../shared-types/allegiances.js';
import { pickTarget, type MountTargetView, type PickTargetOptions } from './WeaponMountController.js';
import { arrive, makeSteerOutput, type SteerOutput } from './steering.js';
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
} from './flocking.js';
import type { AiEntityPoseOut } from '../contracts/IAiBehaviour.js';
import { massOf, NPC_MASS_FALLBACK, shipTuning } from '../../shared-types/shipScale/tuning.js';
import { AI_INPUT_BOOST } from '../contracts/IAiBehaviour.js';
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
import { roleProfile, roleSensorRange, type RoleProfile } from './tactics/roleProfiles.js';
import {
  FACE_AIM_LEAD,
  FACE_MOVE,
  makeManoeuvreGoal,
  makeTacticalContext,
  type IManoeuvre,
  type ManoeuvreGoal,
  type ManoeuvreId,
  type TacticalContext,
} from './tactics/manoeuvre.js';
import { AttackRunManoeuvre, BreakManoeuvre, HoldManoeuvre, TailManoeuvre } from './tactics/manoeuvres.js';
import { decisionDue, LOD_PILOT_RANGE_MUL, ManoeuvrePicker } from './tactics/utility.js';
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
import type { IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';

/** Aim cone (radians). Drones won't fire unless their nose is within this many radians of the target. */
const DRONE_AIM_TOLERANCE = 0.25; // ~14°
/** Wider fire arc used when the target is at point-blank (`< 0.4 ×
 *  DRONE_FIRE_RANGE`). At brawl distance even an off-cone shot tends to
 *  connect, so drones get to be more aggressive. */
const DRONE_AIM_TOLERANCE_CLOSE = 0.45; // ~26°
/** Distance threshold (relative to fire range) below which the wide
 *  point-blank arc kicks in. */
const POINT_BLANK_RATIO = 0.4;
/** Distance threshold (relative to fire range) above which the drone
 *  gets a thrust boost to close engagement faster. Tuned so the boost
 *  fires only when the drone is meaningfully out of combat range. */
const ENGAGE_DISTANCE_RATIO = 1.5;
/** Capital broadside (Phase 3): hold this fraction of main-battery reach. */
export const BROADSIDE_STANDOFF = 0.75;
/** Max heading bias (rad) toward / away from the target to keep the stand-off. */
const BROADSIDE_RANGE_STEER = 0.6;
/** Speed while broadside, per unit of range error (fraction of cruise). */
const BROADSIDE_SPEED = 0.6;
/** Guard post (owner decision 2026-11-11): a guarding capital fights from its
 *  post. Inside this share of its guard radius it holds station with its beam
 *  to the target; beyond it, it closes on the post. */
const GUARD_HOLD_FRAC = 0.5;
/** Beyond this share of the guard radius a guarding capital gives up its
 *  broadside heading and turns its axis to the post so thrust can bring it back. */
const GUARD_RETURN_FRAC = 0.8;
/** Station-keeping: the most a guarding capital steams toward its post, as a
 *  share of the kind's max speed (it must stop again inside the radius). */
const GUARD_RETURN_SPEED = 0.5;
/** Station-keeping pilot: a capital's thrust is the only brake it has on a
 *  course across its axis, so it may thrust with any nose (no thrust cone). */
const GUARD_PILOT_PARAMS: Readonly<PilotParams> = { ...DEFAULT_PILOT_PARAMS, thrustConeCos: -1 };
/** Forget a hostile player after this many ticks of no fresh damage from
 *  them. 1800 ticks @ 60 Hz = 30 s. Mirrors the player's own intuition that
 *  if they've been clean for half a minute, the drone has lost interest. */
const FORGET_TICKS = 1800;
/** Part C — bias the drone's target pick toward the lowest-health hostile
 *  ("gang up on the wounded one") instead of pure nearest. Moderate so a
 *  far-but-wounded player doesn't pull a drone across the sector past a
 *  point-blank threat — distance² still dominates at large gaps. No effect when
 *  the player view carries no health (e.g. older tests). */
const DRONE_TARGET_HEALTH_WEIGHT = 1.5;
/** Part C — hard switch-DELAY: once a drone commits to a target it holds it for
 *  this many ticks before re-evaluating, so a pack doesn't all flip targets in
 *  unison every tick as ranges cross. ~0.5 s at 60 Hz. Server-only (deterministic
 *  server tick; the client never ticks the drone brain). */
const DRONE_TARGET_DWELL_TICKS = 30;
/** Wave-system Phase 2 — how strongly a drone in COMBAT favours STRUCTURES over
 *  player ships (req #2 "structures primarily"). Fed to `pickTarget` as
 *  `priorityBias`; structures carry `priority 1`, players `priority 0`, so a
 *  structure's score is divided by `(1 + bias)`. With score ∝ d², a bias of 3
 *  means a structure up to 2× as far as a player still wins the pick. */
const STRUCTURE_PRIORITY_BIAS = 3;
/** Target orbit radius for IDLE patrol. Players spawn near the origin so
 *  this is comfortably outside the spawn zone without being so far that
 *  drones are off-screen most of the session. */
const PATROL_RADIUS = 1800;
/** Calm (non-combat) travel speed as a share of the kind's thrust cruise
 *  speed: patrols, squad courses and flock followers fly at it. The pilot
 *  layer (2026-11-13) gave NPCs their full player handling; out of combat they
 *  CHOOSE to cruise slower, at the pace the retired `ai.thrust` (≈0.45× the
 *  player thrust) used to give, so roaming squads keep their readable pace. */
const CALM_CRUISE_FRAC = 0.45;
/** Patrol speed as a share of the calm cruise, so the orbit stays slow and
 *  readable and the inward bias wins when a drone spirals back. */
const PATROL_SPEED_FRAC = 0.5;
/** Strength of the inward bias applied when the drone is outside
 *  `PATROL_RADIUS`. Blends from 0 at the radius to 1 at 2 × radius. */
const PATROL_INWARD_GAIN = 1.0;
/** Roaming-formation (Phase 5): distance to the assigned move target within
 *  which the drone ramps thrust down so per-kind damping brakes it to a stop
 *  (the "slow down and come to a stop in formation, don't float past" feel). */
const MOVE_ARRIVE_SLOW_RADIUS = 300;
/** Non-combat herding: a flock LEADER cruises its course at this fraction of the
 *  calm cruise, so its FOLLOWERS — moving at the full calm cruise
 *  — actually outrun it and tighten into the herd. Without the throttle the
 *  leader and followers share the same slow max-speed and the herd can never
 *  close the gap (the boost the old scheme used to paper over this is gone; the
 *  user's "make the leader wait" instead). ~0.55 = leader noticeably slower than
 *  the flock but still genuinely travelling. The director ALSO holds the leader
 *  outright when the squad is badly spread (course = its own pose). */
const LEADER_CRUISE_THROTTLE = 0.55;

// ── Combat context steering (AI steering plan slice 2c) ─────────────────
/** Neighbours read per combat tick (nearest first). */
const COMBAT_NEIGHBOUR_K = 8;
/** Query reach, × `combatSeparation`: danger fades out by here. */
const COMBAT_SEP_REACH = 1.25;
/** Full-strength neighbour danger inside this fraction of `combatSeparation`. */
const COMBAT_SEP_CORE = 0.5;
/** Speed a crowded ship drifts apart at, × cruise, at full crowding. */
const COMBAT_CROWD_SPEED = 0.6;
/** Out of fire range, facing switches to the move heading when the move is
 *  this far off the GOAL heading (radians; 100°), and back below
 *  `FACE_MOVE_EXIT` (80°): a detour forced by wingmen. */
const FACE_MOVE_ENTER = (100 * Math.PI) / 180;
const FACE_MOVE_EXIT = (80 * Math.PI) / 180;
/** Below this wanted speed (× cruise) the nose stays on the lead point:
 *  the pilot's reverse handles a slow back-off without turning away. */
const FACE_MOVE_MIN_SPEED = 0.25;

// ── Decision layer (AI overhaul slice 4) ────────────────────────────────
/** Recent-hit counter half-life (ticks): the "under heavy fire" signal. */
const HIT_HALF_LIFE_TICKS = 60;
/** Ally / enemy counts read at decision time within this × fire range. */
const COUNT_RANGE_MUL = 1.5;
/** A target counts as moving (it has a heading) above this share of our cruise. */
const ASPECT_MIN_SPEED_FRAC = 0.1;

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
/** Phase 1 state machine: drones either patrol idle (orbit origin) or
 *  pursue & shoot a hostile player. Future phases may add more states
 *  (FLEE, REGROUP, etc.) — the structure is intentionally minimal here. */
export type DroneState = 'IDLE' | 'COMBAT';

export class HostileDroneBehaviour implements IAiBehaviour {
  private lastFireTick = -1_000_000;
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
   *  instance so it's lockstep-safe in the same way `lastFireTick` is —
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
    health?: number;
    maxHealth?: number;
    priority: number;
    /** A ship (pilot hull or swarm combatant), not a structure. */
    ship: boolean;
    /** Per-candidate hostility (allegiances P0) — ALWAYS set before the pick,
     *  so `pickTarget` reads it instead of the callback. For a drones-only view
     *  it equals `hostileTo.has(id)` ⇒ byte-identical to pre-P0. */
    hostile: boolean;
  }> = [];
  /** Allegiances P0 — this entity's NPC side (from its kind) and whether that
   *  side attacks players ON SIGHT (robots do; drones don't — drones are driven
   *  by waves + retaliation through `hostileTo`). */
  private readonly allegiance: NpcAllegianceId;
  private readonly onSightPlayers: boolean;
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
   *  guards). Plain fields, no object, so set/clear never allocates (#14). */
  private guardOn = false;
  private guardX = 0;
  private guardY = 0;
  private guardR = 0;

  // ── Weapon-aware engagement (weapons/energy/AI overhaul §4) ───────────
  // Computed once in the constructor from this drone's bound weapon (no
  // per-tick allocation, no wire divergence — all derived from `this.kind`).
  /** Mode of the drone's bound weapon (first mount). Drives the steering
   *  branch in tickCombat. */
  private readonly weaponMode: WeaponMode;
  /** Distance (world units) at/under which the drone fires. Beam → very
   *  close (~225); bolt → medium (~560); missile → long (~1400). */
  private readonly fireRange: number;
  /** Cooldown of the bound weapon in ticks (beam/bolt 10, missile 90).
   *  Replaces the global WEAPON_COOLDOWN_TICKS so missile drones don't
   *  spam at the hitscan rate. */
  private readonly fireCooldownTicks: number;
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
    fx: 0, fy: 0, torque: 0, setAngvel: undefined, fire: undefined,
  };
  private readonly _fireScratch: { dirX: number; dirY: number; targetId: string } = { dirX: 0, dirY: 0, targetId: '' };
  /** The kind's handling as the virtual pilot sees it (body mass as spawned). */
  private readonly handling: PilotHandling;
  /** Virtual-pilot state (reaction latch), owned per drone. */
  private readonly _pilot: PilotState = makePilotState();
  /** Boost energy (server-only): the kind's pool, regenerated each tick and
   *  spent per boosted tick with the shared `Energy.ts` helpers, as a pilot's. */
  private energy: number;
  private readonly energyMax: number;
  private readonly energyRegen: number;
  /** Combat context steering (slice 2c): maps, output and neighbour buffer,
   *  allocated once (#14). */
  private readonly _ctxMaps: ContextMaps = createContextMaps();
  private readonly _ctxOut: ContextSteerOutput = makeContextOutput();
  private readonly _nbIdx = new Int32Array(COMBAT_NEIGHBOUR_K);
  /** `shipTuning(kind).combatSeparation`, cached. */
  private readonly combatSeparation: number;
  /** Pilot hulls count as same-side neighbours only for a side friendly to players. */
  private readonly friendlyToPilots: boolean;
  /** Facing latch: true while the nose follows the move heading, not the lead. */
  private _faceMove = false;
  /** Test-visible: did the last combat tick resolve through context steering? */
  private _ctxUsed = false;

  // ── Decision layer (slice 4): manoeuvres + utility picker ─────────────
  /** The role's tactics profile (`kind.aiRole`). */
  private readonly role: RoleProfile;
  /** Reused tactical context + goal (#14). */
  private readonly _tac: TacticalContext = makeTacticalContext();
  private readonly _goal: ManoeuvreGoal = makeManoeuvreGoal();
  /** Preallocated manoeuvres, indexed by `ManoeuvreId`. */
  private readonly _manoeuvres: readonly IManoeuvre[] = [
    new HoldManoeuvre(), new TailManoeuvre(), new AttackRunManoeuvre(), new BreakManoeuvre(),
  ];
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
  /** Recent-hit counter (decays with `HIT_HALF_LIFE_TICKS`), from `markHostile`. */
  private _hitsVal = 0;
  private _hitsTick = 0;

  constructor(kind?: ShipKind | string) {
    // Accept the kind as either a `ShipKind` record or a kind id (string), so
    // tests that don't care about kind tuning can still construct with no
    // arg (`new HostileDroneBehaviour()` falls back to the catalogue default).
    this.kind = typeof kind === 'object' && kind !== null
      ? kind
      : getShipKind(typeof kind === 'string' ? kind : null);
    const a = this.kind.allegiance;
    this.allegiance = a !== undefined && isNpcAllegianceId(a) ? a : 'drones';
    this.onSightPlayers = isOnSightHostile(this.allegiance, PLAYERS_SIDE);
    this.friendlyToPilots = isFriendly(this.allegiance, PLAYERS_SIDE);
    this.combatSeparation = shipTuning(this.kind).combatSeparation;
    this.role = roleProfile(this.kind.aiRole);
    // The body's mass is SwarmSpawner's: the kind's own, else NPC_MASS_FALLBACK.
    this.handling = makePilotHandling(this.kind, massOf(this.kind, NPC_MASS_FALLBACK));
    this.energyMax = this.kind.energyMax ?? 100;
    this.energyRegen = this.kind.energyRegenRate ?? 0.25;
    this.energy = this.energyMax;
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
    this.fireCooldownTicks = firstWeapon.cooldownTicks;
    // Lead-aim muzzle speed: real projectile speed for bolts/missiles,
    // ~instant for hitscan (no lead). Drives the intercept in tickCombat.
    this.leadMuzzleSpeed = firstWeapon.mode === 'hitscan' ? 1e6 : firstWeapon.speed;
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
    this.sensorRange = roleSensorRange(this.kind.aiRole, this.fireRange);
    const tac = this._tac;
    tac.fireRange = this.fireRange;
    tac.cruiseSpeed = this.handling.cruiseSpeed;
    tac.maxSpeed = this.handling.maxSpeed;
    tac.overshoot = shipTuning(this.kind).attackRunOvershoot;
    this._pickOpts = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
      maxDistance: this.sensorRange,
      prevMaxDistance: Infinity,
    };
    this._pickOptsUncapped = {
      healthWeight: DRONE_TARGET_HEALTH_WEIGHT,
      dwellTicks: DRONE_TARGET_DWELL_TICKS,
      ticksSincePrevTarget: 0,
      priorityBias: STRUCTURE_PRIORITY_BIAS,
    };
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
    if (!shooterId) return;
    this.hostileTo.add(shooterId);
    this.lastHitByPlayer.set(shooterId, atTick);
    this.state = 'COMBAT';
    // Decision layer: every damage hit lands here (swarmDamageStrategy), so it
    // doubles as the "under fire" signal. Director aggro marks count once too.
    this._hitsVal = this.recentHitsAt(atTick) + 1;
    this._hitsTick = atTick;
  }

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
    // Boost energy regenerates every tick, as a pilot's pool does.
    this.energy = regenEnergyStep(this.energy, this.energyMax, this.energyRegen);
    // 1) Time-decay: drop hostiles whose last hit aged past FORGET_TICKS.
    //    `view.tick` is `serverTick` on the server and `inputTick` on the
    //    client; same tolerance as the existing `lastFireTick` cooldown.
    if (this.hostileTo.size > 0) {
      for (const [pid, lastHit] of this.lastHitByPlayer) {
        if (view.tick - lastHit > FORGET_TICKS) {
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
    const canEngageOnSight = this.onSightPlayers || (view.swarms !== undefined && view.swarms.length > 0);
    if (this.state === 'IDLE' && !canEngageOnSight) {
      return this.leaderId !== null ? this.tickFlock(self, view) : this.tickPatrol(self);
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
    const engageR2 = ON_SIGHT_ENGAGE_RANGE * ON_SIGHT_ENGAGE_RANGE;
    let n = 0;
    let anyHostile = false;
    for (const p of view.players) {
      let c = cand[n];
      if (!c) {
        c = { id: '', x: 0, y: 0, vx: 0, vy: 0, priority: 0, ship: true, hostile: false };
        cand[n] = c;
      }
      c.id = p.id;
      c.x = p.x;
      c.y = p.y;
      c.vx = p.vx;
      c.vy = p.vy;
      c.health = p.health;
      c.maxHealth = p.maxHealth;
      c.priority = 0;
      c.ship = true;
      let h = this.hostileTo.has(p.id) || (p.ownerId !== undefined && this.hostileTo.has(p.ownerId));
      if (!h && this.onSightPlayers && p.truce !== true) {
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
          c = { id: '', x: 0, y: 0, vx: 0, vy: 0, priority: 0, ship: true, hostile: false };
          cand[n] = c;
        }
        c.id = s.id;
        c.x = s.x;
        c.y = s.y;
        c.vx = 0;
        c.vy = 0;
        c.health = s.health;
        c.maxHealth = s.maxHealth;
        c.priority = s.priority;
        c.ship = false;
        c.hostile = this.hostileTo.has(s.id);
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
        if (!h && isNpcAllegianceId(s.allegiance) && isOnSightHostile(this.allegiance, s.allegiance)) {
          const dx = s.x - self.x;
          const dy = s.y - self.y;
          h = dx * dx + dy * dy <= engageR2;
        }
        if (!h) continue;
        let c = cand[n];
        if (!c) {
          c = { id: '', x: 0, y: 0, vx: 0, vy: 0, priority: 0, ship: true, hostile: false };
          cand[n] = c;
        }
        c.id = s.id;
        c.x = s.x;
        c.y = s.y;
        c.vx = s.vx;
        c.vy = s.vy;
        c.health = s.health;
        c.maxHealth = s.maxHealth;
        c.priority = 0;
        c.ship = true;
        c.hostile = true;
        anyHostile = true;
        n++;
      }
    }
    if (cand.length !== n) cand.length = n;

    // An IDLE entity with nothing on-sight-hostile in range keeps patrolling /
    // flocking (it never entered COMBAT; no state change).
    if (this.state === 'IDLE' && !anyHostile) {
      return this.leaderId !== null ? this.tickFlock(self, view) : this.tickPatrol(self);
    }

    // Sensor cap (AI overhaul slice 3): NEW picks only within the role's
    // sensor range; the held target stays eligible at any range
    // (`prevMaxDistance: Infinity`). Nothing in range and nothing held ⇒ fall
    // back to the uncapped pick, so a director-ordered / retaliation contact
    // (`hostileTo`, set via markHostile) across the sector is still hunted.
    // On-sight candidates never reach the fallback beyond ON_SIGHT_ENGAGE_RANGE
    // (they aren't hostile there), and the sensor range is floored at it.
    const sinceTicks = view.tick - this.prevTargetSinceTick;
    this._pickOpts.ticksSincePrevTarget = sinceTicks;
    let target = pickTarget(self.x, self.y, cand, this.prevTargetId, this._isHostile, this._pickOpts);
    if (target === null && anyHostile) {
      this._pickOptsUncapped.ticksSincePrevTarget = sinceTicks;
      target = pickTarget(self.x, self.y, cand, this.prevTargetId, this._isHostile, this._pickOptsUncapped);
    }
    const newId = target?.id ?? null;
    if (newId !== this.prevTargetId) this.prevTargetSinceTick = view.tick;
    this.prevTargetId = newId;
    if (target === null) return this.tickPatrol(self);

    return this.tickCombat(self, view, target);
  }

  // ── Patrol ──────────────────────────────────────────────────────────
  /**
   * Idle behaviour: orbit the sector centre (0, 0) counter-clockwise at
   * `PATROL_RADIUS`. When the drone is outside the radius we blend an
   * inward bias into the desired heading so drones spiral back toward the
   * orbit instead of diverging — this is also the structural fix for the
   * "drone drifted to (4 133 782, -1 093 669) over a long session" bug.
   * Flown through the virtual pilot at a slow patrol speed.
   */
  private tickPatrol(self: AiEntity): AiIntent {
    // Roaming-formation (Phase 5): when the director has assigned a move target
    // (formation slot / squad destination), fly to it and slow to a stop there,
    // instead of the default origin orbit. This is how a roaming squad flies in
    // formation toward an arbitrary A→B destination.
    if (this.moveTarget !== null) return this.tickMoveTo(self, this.moveTarget.x, this.moveTarget.y);
    const r = Math.hypot(self.x, self.y);
    const safeR = Math.max(r, 1);

    // Tangent to the circle around origin (counter-clockwise: rotate the
    // outward-radial vector by +90°). At (x, y), the unit radial is
    // (x, y)/r and its CCW perpendicular is (-y, x)/r.
    let dirX = -self.y / safeR;
    let dirY = self.x / safeR;

    // Inward bias: outside the radius, blend the heading toward the origin
    // so the drone spirals back. Clamped to [0, 1] at 2× the patrol radius.
    if (r > PATROL_RADIUS) {
      const overshoot = (r - PATROL_RADIUS) / PATROL_RADIUS;
      const bias = Math.min(1, overshoot * PATROL_INWARD_GAIN);
      dirX = dirX * (1 - bias) + (-self.x / safeR) * bias;
      dirY = dirY * (1 - bias) + (-self.y / safeR) * bias;
      const len = Math.hypot(dirX, dirY);
      if (len > 1e-6) { dirX /= len; dirY /= len; }
    }

    const speed = this.handling.cruiseSpeed * CALM_CRUISE_FRAC * PATROL_SPEED_FRAC;
    return this.fly(self, facingOf(dirX, dirY), dirX * speed, dirY * speed, false);
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
    if (this.broadside) return this.tickBroadside(self, target, rawDx, rawDy, dist);

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

    // Bearing toward the lead-aim point, not the target's current pose.
    const desiredAngle = facingOf(aimDx, aimDy);
    const bearingError = wrapAngle(desiredAngle - self.angle);

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
    if (this.backoffInsideFactor > 0 && dist < this.fireRange * this.backoffInsideFactor) {
      // Missile kite — too close for artillery: open the gap.
      closing = -h.cruiseSpeed;
    } else if (dist > this.fireRange * ENGAGE_DISTANCE_RATIO) {
      // Far engagement — close at full speed, boosting while it can.
      closing = Math.min(h.maxSpeed, brakingSpeed(h, dist - STOP_DIST));
      boostOk = true;
    } else if (dist > STOP_DIST) {
      // Approach window: never faster than it can brake from by STOP_DIST
      // (the "flies past way too quickly… never approaches" fix, now by the
      // pilot's own reverse instead of an AI-only brake impulse).
      closing = Math.min(h.cruiseSpeed, brakingSpeed(h, dist - STOP_DIST));
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
    if (nb === undefined) {
      // No neighbour index: the pre-2c stand-off path exactly (A/B control).
      this._faceMove = false;
      intent = this.fly(self, desiredAngle, ux * along, uy * along, boostOk);
    } else {
      // Decision layer (slice 4): the running manoeuvre writes the goal, the
      // utility picker re-decides on its cadence.
      this.fillTactical(self, view.tick, target, dist, ux, uy, aimX, aimY, desiredAngle, bearingError, along, boostOk);
      this.runDecision(self, view, nb);
      clearContextMaps(this._ctxMaps);
      this._manoeuvres[this._picker.current]!.writeGoal(this._tac, this._ctxMaps, this._goal);
      intent = this.flyCombatContext(self, nb, ux, uy, desiredAngle, dist <= this.fireRange, this._goal);
    }

    // Fire gating: standard 14° cone at normal distance widens to 26° at
    // point-blank so brawls actually trade fire instead of dancing
    // around each other waiting for a perfect line-up.
    //
    // Phase 4c (2026-05-11): kinds with rotating mounts add the widest
    // mount's half-arc to the body-aim tolerance, so a drone fires when
    // a turret can reach the target even when the body itself is off.
    const baseTolerance = dist < this.fireRange * POINT_BLANK_RATIO
      ? DRONE_AIM_TOLERANCE_CLOSE
      : DRONE_AIM_TOLERANCE;
    const aimTolerance = baseTolerance + this.maxTurretHalfArc;

    const aimed = Math.abs(bearingError) <= aimTolerance;
    const inRange = dist <= this.fireRange;
    const offCooldown = view.tick - this.lastFireTick >= this.fireCooldownTicks;
    const willFire = aimed && inRange && offCooldown;
    if (willFire) {
      this.lastFireTick = view.tick;
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
    ux: number,
    uy: number,
    leadAngle: number,
    inRange: boolean,
    goal: ManoeuvreGoal,
  ): AiIntent {
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

    const out = resolveContext(m, this._ctxOut);
    this._ctxUsed = true;
    const h = this.handling;
    const crowdSpeed = crowd * COMBAT_CROWD_SPEED * h.cruiseSpeed;
    const speed = goalSpeed > crowdSpeed ? goalSpeed : crowdSpeed;
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
    const facing = this._faceMove ? moveAngle : leadAngle;
    return this.fly(self, facing, wvx, wvy, goal.boost);
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
    c.targetIsShip = (target as { ship?: boolean }).ship !== false;
    c.dist = dist; c.ux = ux; c.uy = uy;
    c.aimX = aimX; c.aimY = aimY;
    c.leadAngle = leadAngle;
    c.offBoresight = bearingError < 0 ? -bearingError : bearingError;
    // d(dist)/dt = (v_target − v_self)·u; closing is its negative.
    c.closing = -((target.vx - self.vx) * ux + (target.vy - self.vy) * uy);
    const ts = Math.hypot(target.vx, target.vy);
    c.targetAspectCos = ts > ASPECT_MIN_SPEED_FRAC * this.handling.cruiseSpeed ? -(target.vx * ux + target.vy * uy) / ts : 0;
    c.threatBearingCos = c.fwdX * ux + c.fwdY * uy;
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
      c.rng.reseed(h);
      p.seed(c.rng);
      this._slot = h % 60;
      this._seeded = true;
    }
    const done = this._manoeuvres[p.current]!.isDone(c);
    if (done || decisionDue(tick, this._slot, this._lod)) {
      this._lod = !this.pilotNear(self, view);
      c.recentHits = this.recentHitsAt(tick);
      this.countSides(self, nb);
      if (view.stats !== undefined) view.stats.decisions++;
      const want = p.decide(c, this.role, done);
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
    this._picker.switchTo(id, tick);
    this._manoeuvres[id]!.begin(this._tac);
    this._pendingId = -1;
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
  private tickBroadside(self: AiEntity, target: MountTargetView, dx: number, dy: number, dist: number): AiIntent {
    if (this.guardOn) return this.tickGuardBroadside(self, dx, dy);
    const bearing = facingOf(dx, dy);
    const cruise = this.handling.cruiseSpeed;
    if (dist > this.fireRange) {
      const s = cruise / dist;
      return this.fly(self, bearing, dx * s, dy * s, dist > this.fireRange * ENGAGE_DISTANCE_RATIO);
    }
    const port = wrapAngle(bearing + Math.PI / 2);
    const stbd = wrapAngle(bearing - Math.PI / 2);
    const usePort = Math.abs(wrapAngle(port - self.angle)) <= Math.abs(wrapAngle(stbd - self.angle));
    const standoff = this.fireRange * BROADSIDE_STANDOFF;
    // + when too far (turn in toward the target), − when too close.
    const err = Math.max(-1, Math.min(1, (dist - standoff) / standoff));
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
   *  `tickGuardBroadside`) instead of holding its gun stand-off. The radius is
   *  at least `shipTuning(kind).guardRadiusMin` (#18), so a big hull has room
   *  to turn. Independent of the move target / flock roles (those steer the
   *  IDLE drone). Server-only: the client never ticks the drone brain. */
  setGuardPost(x: number, y: number, radius: number): void {
    this.guardOn = true;
    this.guardX = x;
    this.guardY = y;
    this.guardR = Math.max(radius, shipTuning(this.kind).guardRadiusMin);
  }

  clearGuardPost(): void {
    this.guardOn = false;
  }

  /** Test-visible: the effective guard radius (0 with no post). */
  getGuardRadius(): number {
    return this.guardOn ? this.guardR : 0;
  }

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
    this._flockLeaderCruise = false;
    this._flockMemberIds.length = 0;
    for (let i = 0; i < memberIds.length; i++) this._flockMemberIds.push(memberIds[i]!);
  }

  /** Fly to (tx, ty) and stop there: face the slot and ask the pilot for a
   *  speed it can still brake from (the arrive ramp), capped at the calm
   *  cruise. At the slot the wanted velocity is zero and the nose stays put, so
   *  the pilot brakes to a stop with reverse instead of turning around.
   */
  private tickMoveTo(self: AiEntity, tx: number, ty: number): AiIntent {
    const steer = arrive(self.x, self.y, tx, ty, MOVE_ARRIVE_SLOW_RADIUS, this._steerScratch);
    if (steer.thrustScale <= 0) return this.fly(self, self.angle, 0, 0, false);
    // A flock leader cruises SLOWER than its full-cruise followers so they
    // tighten into the herd around it (the "make the leader wait" lever).
    const cruise = this.handling.cruiseSpeed * CALM_CRUISE_FRAC * (this._flockLeaderCruise ? LEADER_CRUISE_THROTTLE : 1);
    const speed = Math.min(cruise, brakingSpeed(this.handling, steer.dist));
    // Close in: keep the nose where it is and just brake (no turn-around for
    // an overshoot of a few lengths).
    const facing = steer.dist > shipTuning(this.kind).flockFollow ? facingOf(steer.dirX, steer.dirY) : self.angle;
    return this.fly(self, facing, steer.dirX * speed, steer.dirY * speed, false);
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
      return this.tickPatrol(self);
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
    addCohesion(acc, self.x, self.y, leaderX, leaderY, shipTuning(this.kind).flockFollow);
    for (let i = 0; i < this._flockMemberIds.length; i++) {
      const mid = this._flockMemberIds[i]!;
      if (mid === self.id) continue;
      const mx = mid === this.leaderId ? leaderX : (resolve(mid, this._neighborScratch) ? this._neighborScratch.x : NaN);
      if (Number.isNaN(mx)) continue;
      const my = mid === this.leaderId ? leaderY : this._neighborScratch.y;
      addSeparation(acc, self.x, self.y, mx, my, shipTuning(this.kind).flockSeparation);
    }
    addAlignment(acc, this._leaderScratch.angle);
    const flock = resolveFlock(acc, this._flockOut);
    if (flock.thrustScale <= 1e-4) return this.fly(self, self.angle, 0, 0, false);
    // Calm cruise scaled by the boids desired-velocity magnitude. As the follower
    // settles at the follow-radius, cohesion ramps to ~0 and separation cancels
    // it, so the magnitude shrinks toward the alignment term alone → the pilot
    // eases off (and brakes the residual).
    const speed = this.handling.cruiseSpeed * CALM_CRUISE_FRAC * flock.thrustScale;
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
      if (canAfford(this.energy, BOOST_TICK_COST)) this.energy = spendEnergy(this.energy, BOOST_TICK_COST);
      else bits &= ~AI_INPUT_BOOST;
    }
    const out = this._intentScratch;
    out.fx = 0;
    out.fy = 0;
    out.torque = 0;
    out.setAngvel = undefined;
    out.input = bits;
    out.fire = undefined;
    return out;
  }

  /** Test-visible: the NPC's boost energy pool. */
  getEnergy(): number { return this.energy; }

}
