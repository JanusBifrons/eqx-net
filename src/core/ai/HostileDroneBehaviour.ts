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
import { HullAvoid } from './hullAvoid.js';
import type { AiShipActivity } from '../contracts/IAiBehaviour.js';
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
  makeManoeuvreGoal,
  makeTacticalContext,
  MANOEUVRE_FLEE,
  MANOEUVRE_HOLD,
  type ManoeuvreGoal,
  type ManoeuvreId,
  type TacticalContext,
  JOB_COURSE, JOB_FLOCK, JOB_GUARD, JOB_LEAVING, JOB_ORBIT, JOB_SEARCH, JOB_TRAVEL,
  JOB_ORDER_NO_FLOCK, JOB_ORDER_REPORT, JOB_ORDER_TICK, MODE_GOAL_MOVE_TO, makePilotModeContext, makePilotModeGoal,
  type IPilotMode, type PilotJobId, type PilotModeContext, type PilotModeGoal, type PilotOrderModes,
} from './tactics/manoeuvre.js';
import { FlockMode } from './modes/flockMode.js';
import { GuardReturnMode } from './modes/guardReturnMode.js';
import { LeavingMode } from './modes/leavingMode.js';
import { PatrolMode } from './modes/patrolMode.js';
import { SearchMode } from './modes/searchMode.js';
import { TravelMode } from './modes/travelMode.js';
import { hullFireCone } from './hullFireCone.js';
import { MoveToHelm } from './pilot/moveTo.js';
import { PilotMorale } from './pilot/pilotMorale.js';
import { PilotSenses } from './pilot/pilotSenses.js';
import { TargetPick } from './pilot/targetPick.js';
import { BroadsideHelm } from './tactics/broadside.js';
import { TacticalFill } from './tactics/tacticalFill.js';
import { CombatDecision } from './tactics/combatDecision.js';
import { CombatSteer } from './tactics/combatSteer.js';
import {
  MoraleTracker,
  type MoraleOutcome,
} from './tactics/morale.js';
import {
  clearContextMaps,
  type ContextSteerOutput,
} from './contextSteering.js';
import {
  FireLaneSteer,
} from './tactics/fireLanes.js';
import {
  DRONE_AIM_TOLERANCE,
  DRONE_AIM_TOLERANCE_CLOSE,
  POINT_BLANK_RATIO,
  DEFAULT_AIM_RADIUS,
  ENGAGE_DISTANCE_RATIO,
  RUN_PILOT_PARAMS,
  BOOST_RESERVE_FRAC,
  FORGET_TICKS,
  COMBAT_NEIGHBOUR_K,
  WARP_OUT_SENSOR_MUL,
  NEVER_RUN_MORALE,
  BROADSIDE_STANDOFF,
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

  /** The shared fly-to (`ai/pilot/moveTo.ts`). */
  private readonly _moveTo: MoveToHelm;

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
  /** On-sight engagement (RTS Part B slice 6, `setEngageOnSight`): off ⇒ this
   *  ship fights only what is on its retaliation ledger (`hostileTo`), the
   *  Defensive attitude. Drones and robots keep it on. */
  private engageOnSight = true;
  /** Hold fire (RTS Part B slice 7, `setHoldFire`): on ⇒ this ship picks no
   *  target at all (no on-sight, no retaliation, no trigger) and keeps flying
   *  its job. `markHostile` still records attackers, so a switch back to
   *  Defensive / Aggressive answers one that hit within `FORGET_TICKS`. */
  private holdFire = false;
  /** RTS Part B slice 8 (`setOrderedTarget`): the owner's attack-order target.
   *  On the retaliation ledger (never forgotten while ordered, so a Defensive
   *  ship fights a neutral), `ORDERED_TARGET_PRIORITY` in the pick, and free of
   *  the guard leash and the sensor cap. Null = no order. */
  private orderedTargetId: string | null = null;
  /** The ledger tick the order wrote for its target (-1 = none): lifting the
   *  order forgets the mark unless the target hit this ship since. */
  private orderMarkTick = -1;
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
  /** Neighbour buffer, allocated once (#14). */
  private readonly _nbIdx = new Int32Array(COMBAT_NEIGHBOUR_K);
  /** `shipTuning(kind).shieldPad`, cached: ships collide as their shield
   *  bubbles (hull radius + pad), so hull avoidance clears the bubbles. */
  private readonly shieldPad: number;
  /** Pilot hulls count as same-side neighbours only for a side friendly to players. */
  private readonly friendlyToPilots: boolean;
  /** Hull avoidance (ships and debris; latches its dodge side). */
  private readonly _avoid = new HullAvoid();
  /** Test-visible: ticks spent dodging a hull. */
  private _avoidTicks = 0;
  /** Ticks flown with the afterburner lit (test-visible). */
  private _boostTicks = 0;
  /** Turn-key reversals (test-visible) and the last turn key held (1 L, −1 R). */
  private _turnReversals = 0;
  private _lastTurnKey = 0;

  // ── Decision layer (slice 4): manoeuvres + utility picker ─────────────
  /** The role's tactics profile (`kind.aiRole`). */
  private role: RoleProfile;
  /** Reused tactical context + goal (#14). */
  private readonly _tac: TacticalContext = makeTacticalContext();
  private readonly _tacFill = new TacticalFill();
  private readonly _lanes = new FireLaneSteer();
  private readonly _broadsideHelm = new BroadsideHelm();
  private readonly _goal: ManoeuvreGoal = makeManoeuvreGoal();
  // ── Morale (slice 6b, owner's "roll a dice") ──────────────────────────
  private readonly _morale = new MoraleTracker();
  /** Morale timers and the die (`ai/pilot/pilotMorale.ts`). */
  private readonly _moraleP = new PilotMorale(this._morale);
  /** Peacetime modes (`ai/modes/`), preallocated (#14). */
  private readonly _leaving = new LeavingMode();
  private readonly _patrol = new PatrolMode();
  private readonly _guardReturn = new GuardReturnMode();
  private readonly _travel: TravelMode;
  private readonly _search: SearchMode;
  private _modeCtx!: PilotModeContext;
  /** The modes as the order setters see each other (built once, #14). */
  private readonly _orders: PilotOrderModes;
  private readonly _modeGoal: PilotModeGoal = makePilotModeGoal(DEFAULT_PILOT_PARAMS);
  /** The decision layer's state and cadence, and combat context steering (`ai/tactics/`). */
  private readonly _decide: CombatDecision;
  private readonly _steer: CombatSteer;

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
    this._orders = { guard: this._guardReturn, travel: this._travel, search: this._search, flock: this._flock, course: this._patrol };
    this._moveTo = new MoveToHelm(this.kind, this.handling, this.shieldPad, this._avoid);
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
    this._decide = new CombatDecision(this._avoid, this._senses, this._moraleP, this._lanes);
    this._steer = new CombatSteer({
      kind: this.kind, handling: this.handling, allegiance: this.allegiance, friendlyToPilots: this.friendlyToPilots,
      combatSeparation: shipTuning(this.kind).combatSeparation, shieldPad: this.shieldPad, fireRange: this.fireRange,
    }, this._pilot, this._tac, this._avoid, this._lanes, this._decide, this._nbIdx);
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
  getWarpOutCount(): number { return this._leaving.warpOuts; }

  /** Test-visible: the running dogfight manoeuvre (`MANOEUVRE_*`). */
  getManoeuvre(): ManoeuvreId { return this._decide.picker.current; }
  /** Test-visible: re-scores made so far (the `aiDecisionsPerTick` source). */
  getDecisionCount(): number { return this._decide.picker.decisions; }
  /** Test-visible: decisions taken while tailed (the Break trigger held). */
  getTailedDecisionCount(): number { return this._decide.tailedDecisions; }
  /** Test-visible: Breaks begun so far. */
  getBreakCount(): number { return this._decide.breaksBegun; }
  /** Test-visible: decisions taken while tailed with a Break on offer that
   *  picked something else (a role whose Break weight loses to its fight). */
  getBreakRefusedCount(): number { return this._decide.breakRefused; }
  /** Test-visible: the last decision's scores, indexed by `MANOEUVRE_*`. */
  lastManoeuvreScores(): Readonly<Float32Array> { return this._decide.picker.scores; }

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
    this._moveTo.sense(view);
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
    if (this._guardReturn.anchorId !== null) this._guardReturn.followAnchor(view);
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
      if (this._decide.picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
      return this.tickJob(self, view, JOB_ORDER_TICK);
    }
    const canEngageOnSight = this.engageOnSight && (this.onSightPlayers || (view.swarms !== undefined && view.swarms.length > 0));
    if (this.state === 'IDLE' && !canEngageOnSight) {
      if (this._decide.picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
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
    const engageR = this._search.on ? this.sensorRange : ON_SIGHT_ENGAGE_RANGE;
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
        if (this._decide.picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
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
      if (this._decide.picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
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
    const roam = this._travel.state === TRAVEL_ON_THE_WAY && this._travel.fights && !this.broadside;
    if (roam) {
      this._travel.legLeashCentre(self);
      this._guardReturn.x = this._travel.leashX;
      this._guardReturn.y = this._travel.leashY;
    }
    const leash = this.guardLeash() || roam, g = this._guardReturn;
    const target = tp.pick(self, n, this.prevTargetId, sinceTicks, ordered, orderedLive, leash, g.x, g.y, g.r, anyHostile);
    const newId = target?.id ?? null;
    if (newId !== this.prevTargetId) this.prevTargetSinceTick = view.tick;
    this.prevTargetId = newId;
    view.claims?.claim(self.id, this.allegiance, newId);
    if (target === null) {
      if (this._decide.picker.current === MANOEUVRE_FLEE) return this.tickFleeClear(self, view.tick);
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
    if (this._travel.state === TRAVEL_ON_THE_WAY && (!this._travel.fights || this.broadside)) return this.tickTravel(self, view, target);
    // A hunter that found a fight searches again from wherever it ends.
    if (this._search.on) this._search.reset = true;
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
    const f = this._decide.flee;
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
      if (this._travel.state === TRAVEL_ON_THE_WAY) return JOB_TRAVEL;
      if (this._search.on) return JOB_SEARCH;
      if (this._flock.leaderId !== null) return JOB_FLOCK;
      if (this._guardReturn.on) return JOB_GUARD;
      return JOB_ORBIT;
    }
    if (order === JOB_ORDER_TICK && this._flock.leaderId !== null) return JOB_FLOCK;
    if (this._travel.state === TRAVEL_ON_THE_WAY) return JOB_TRAVEL;
    if (this._patrol.moveTarget !== null) return JOB_COURSE;
    // Guard leash: nothing to fight ⇒ back to the post.
    if (this.guardLeash()) return JOB_GUARD;
    // Hunt: nothing to fight ⇒ search the sector.
    if (this._search.on) return JOB_SEARCH;
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
    c.escapeX = this._decide.flee.dirX; c.escapeY = this._decide.flee.dirY; c.moveTarget = this._patrol.moveTarget;
    c.guardOn = this._guardReturn.on; c.guardX = this._guardReturn.x; c.guardY = this._guardReturn.y;
    c.travelX = this._travel.x; c.travelY = this._travel.y;
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
    this._steer.used = false;
    let intent: AiIntent;
    if (view.isCharging?.(self.id) === true) {
      // A charge is winding up: the shot leaves down the barrel when it ends,
      // so hold the line (nose on the lead, matching the target's velocity)
      // instead of flying the manoeuvre. A strafing pass carried the ship
      // ~400 u sideways in the 1.2 s wind-up and the shot missed even a
      // parked pilot (chargeLaser.test.ts). The target can still dodge.
      this._steer.faceMove = false;
      intent = this.fly(self, desiredAngle, target.vx, target.vy, false);
    } else if (nb === undefined) {
      // No neighbour index: the pre-2c stand-off path exactly (A/B control).
      this._steer.faceMove = false;
      intent = this.fly(self, desiredAngle, ux * along, uy * along, boostOk);
    } else {
      // Decision layer (slice 4): the running manoeuvre writes the goal, the
      // utility picker re-decides on its cadence.
      this._tacFill.fill(this._tac, self, view.tick, target, dist, ux, uy, aimX, aimY, desiredAngle, bearingError, along, boostOk,
        this.handling.cruiseSpeed, this.kind.maxHealth);
      const d = this._decide, st = this._steer;
      d.run(self, view, nb, this._tac, this.role, this.kind.radius);
      clearContextMaps(st.maps);
      this._goal.spendReserve = false;
      this._goal.throttleNow = false;
      d.manoeuvres[d.picker.current]!.writeGoal(this._tac, st.maps, this._goal);
      const reserveOk = this.energy >= BOOST_RESERVE_FRAC * this.energyMax;
      if (st.steer(self, nb, view.debris, view.aims, ux, uy, desiredAngle, rangeDist <= this.fireRange, this._goal, reserveOk,
        this.avoidAccel())) this._avoidTicks++;
      intent = this.fly(self, st.facing, st.wvx, st.wvy, st.boost, st.params);
      if (d.picker.current === MANOEUVRE_FLEE && d.flee.wantsWarpOut(view.tick)) {
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

  /** Test-visible: combat ticks spent inside a wingman's fire lane. */
  getLaneExitTicks(): number { return this._lanes.laneExitTicks; }

  /** Test-visible: combat ticks spent side-stepping a blocked line. */
  getNudgeTicks(): number { return this._lanes.nudgeTicks; }

  /** Test-visible: ticks spent dodging a hull (hull avoidance). */
  getAvoidTicks(): number { return this._avoidTicks; }

  /** Begin manoeuvre `id` now (tests reach it; `CombatDecision.switchTo`). */
  private switchManoeuvre(id: ManoeuvreId, tick: number): void { this._decide.switchTo(id, tick, this._tac); }

  /** Dodge thrust (u/s²): the afterburner while the pool allows it. */
  private avoidAccel(): number {
    const boostMul = this.energy >= BOOST_RESERVE_FRAC * this.energyMax ? (this.kind.boostMultiplier ?? 1) : 1;
    return this.handling.thrustAccel * 60 * boostMul;
  }

  /**
   * Flee's end: ask the server to warp out along the escape heading
   * (`intent.warpOut`), then stand down: forget every hostility, leave the
   * squad's flock and hold at the drop point (the same move-to a director
   * order uses). A server without the hook leaves the ship disengaged.
   */
  private requestWarpOut(self: AiEntity, intent: AiIntent): void {
    const f = this._decide.flee;
    const w = this._leaving.requestWarp(self, f.dirX, f.dirY, WARP_OUT_SENSOR_MUL * this.sensorRange, intent);
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
    return this._steer.used ? this._steer.out : null;
  }

  /** Test-visible: is the nose following the move heading (not the lead)? */
  isFacingMove(): boolean { return this._steer.faceMove; }

  /** Broadside flying (`tactics/broadside.ts`); an attack order takes a
   *  guarding capital off its post (slice 8). */
  private tickBroadside(self: AiEntity, target: MountTargetView, dx: number, dy: number, dist: number, rangeDist: number): AiIntent {
    const b = this._broadsideHelm, g = this._guardReturn;
    if (g.on && target.id !== this.orderedTargetId) b.guard(self, dx, dy, g.x, g.y, g.r, this.kind.maxSpeed);
    else b.fight(self, target, dx, dy, dist, rangeDist, this.fireRange, this.handling.cruiseSpeed);
    return this.fly(self, b.facing, b.wvx, b.wvy, b.boost, b.params);
  }

  /** Give this drone a GUARD POST: the area (centre + radius) it was sent to
   *  defend. A broadside capital with a post fights from it (see
   *  `BroadsideHelm.guard`) instead of holding its gun stand-off; any other
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
    this._guardReturn.post(x, y, Math.max(radius, shipTuning(this.kind).guardRadiusMin), anchorId, this._orders);
    this._targets.setLeash(this._guardReturn.r, this.fireRange);
  }

  clearGuardPost(): void { this._guardReturn.clear(); }

  /** Another AI ship left the controller (died / despawned): a guard post
   *  anchored to it is cleared. */
  noteEntityGone(entityId: string): void {
    if (this._guardReturn.anchorId === entityId) this.clearGuardPost();
  }

  /** The guard post leashes this ship's target pick: every ship with a post
   *  but a broadside capital (that one flies `BroadsideHelm.guard`). */
  private guardLeash(): boolean {
    return this._guardReturn.on && !this.broadside;
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
  setHunt(on: boolean): void { this._search.hunt(on, this._orders); }

  /** Test-visible: hunting? */
  isHunting(): boolean { return this._search.on; }

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
  setTravel(x: number, y: number): void { this._travel.go(x, y, this._orders); }

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
    this._travel.patrolLeg(fromX, fromY, x, y, shipTuning(this.kind).guardRadiusMin, this._orders);
    this._targets.setLeash(this._guardReturn.r, this.fireRange);
  }

  /** Test-visible: flying a patrol leg? */
  isPatrolling(): boolean { return this._travel.state === TRAVEL_ON_THE_WAY && this._travel.fights; }

  /** Travel state: `TRAVEL_NONE`, `TRAVEL_ON_THE_WAY` or `TRAVEL_ARRIVED`
   *  (stays until the next job: a guard post, a hunt, a new travel). */
  getTravelState(): TravelState { return this._travel.state; }

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
    if (job === JOB_TRAVEL && (!this._travel.fights || this.prevTargetId === null)) {
      return this._travel.fights ? 'patrolling' : 'moving';
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
      const dx = this._lastX - this._guardReturn.x;
      const dy = this._lastY - this._guardReturn.y;
      return dx * dx + dy * dy > this._guardReturn.r * this._guardReturn.r ? 'moving' : 'guarding';
    }
    return 'idle';
  }

  /** The flock leader this ship follows (null = none: it leads or flies
   *  alone). Server-only, test-visible. */
  getFlockLeaderId(): string | null { return this._flock.leaderId; }

  /** Test-visible: the effective guard radius (0 with no post). */
  getGuardRadius(): number {
    return this._guardReturn.on ? this._guardReturn.r : 0;
  }

  /** Test-visible: the guard post's centre (null with no post). */
  getGuardPostX(): number | null { return this._guardReturn.on ? this._guardReturn.x : null; }
  getGuardPostY(): number | null { return this._guardReturn.on ? this._guardReturn.y : null; }

  /** Set/clear the in-sector move target — the LEADER's course (or a lone
   *  drone's destination). Setting a course clears any FOLLOWER role (you lead /
   *  move independently now), so a former follower promoted to leader stops
   *  flocking. The director re-issues the course each control tick. */
  setMoveTarget(x: number, y: number): void { this._patrol.setCourse(x, y, false, this._orders); }

  /** Leader-led flocking (non-combat herding): assign this drone the LEADER's
   *  course. Same as `setMoveTarget` but flags it a flock leader so the fly-to
   *  THROTTLES its cruise (`LEADER_CRUISE_THROTTLE`) — the leader travels slower
   *  than its full-cruise followers so the herd tightens around it (replaces the
   *  old follower-boost; the user's "make the leader wait"). The director sets
   *  the course to the leader's OWN pose to make it hold while the flock gathers. */
  setFlockLeaderCourse(x: number, y: number): void { this._patrol.setCourse(x, y, true, this._orders); }

  clearMoveTarget(): void { this._patrol.clearCourse(this._orders); }

  /** Leader-led flocking (non-combat herding): mark this drone a FOLLOWER of
   *  `leaderId`, herding to the leader's LIVE pose via cohesion/alignment/
   *  separation each tick (vs the old static wedge slot). `memberIds` (the
   *  squad) drives the separation rule. Copied into an owned buffer so the
   *  director may reuse its source array. Clears any leader course. */
  setFlockFollow(leaderId: string, memberIds: readonly string[]): void { this._flock.followOrder(leaderId, memberIds, this._orders); }

  /** The shared fly-to (`ai/pilot/moveTo.ts`): fly to (tx, ty) and stop there. */
  private tickMoveTo(self: AiEntity, tx: number, ty: number, cruiseCap = -1, boostOk = false): AiIntent {
    const m = this._moveTo;
    if (m.steerTo(self, tx, ty, cruiseCap, boostOk, this.avoidAccel(), this._patrol.leaderCruise)) this._avoidTicks++;
    return this.fly(self, m.facing, m.wvx, m.wvy, m.boost);
  }

  /** Travel (`setTravel` / `setPatrolLeg`, `modes/travelMode.ts`): fly the
   *  leg; arrived, guard the point (the post ends the travel). `target`
   *  (picked this tick, or null): fired at only when already in the sights. */
  private tickTravel(self: AiEntity, view: AiWorldView, target: MountTargetView | null): AiIntent {
    const c = this.modeCtx(self, view.tick, JOB_TRAVEL);
    const tr = this._travel;
    if (tr.isDone(c)) {
      this.setGuardPost(c.travelX, c.travelY, 0);
      tr.state = TRAVEL_ARRIVED;
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

