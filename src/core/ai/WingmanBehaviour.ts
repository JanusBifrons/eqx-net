/**
 * Wingman brain (RTS command layer, slices 2 + 8): the AI pilot that flies a
 * ship its owner is not flying.
 *
 * Why not `IAiBehaviour`: that contract returns an `AiIntent` of raw impulses
 * and torque applied straight to the body (the drone path, which bypasses the
 * player's speed cap and grip). The owner's rule is that wingmen fly with
 * PLAYER CONTROLS ONLY, so this brain returns the control bits a pilot would
 * hold ({@link WingmanControls}) and the server feeds them through the same
 * INPUT → `applyShipInput` path as a pilot's keys. Hence the sibling
 * {@link IWingmanBrain} interface.
 *
 * Model:
 *  - MODE: standing behaviour.
 *    - `defend`: hold a guard post, return when pushed outside the guard radius.
 *    - `patrol`: fly a route of 2–16 waypoints as a closed loop (last → first).
 *      A missing / one-point route ⇒ defend (at that point).
 *    - `escort`: keep station behind-and-starboard of another ship (the
 *      `formation.ts` wedge slot 1 in its travel frame), matching its
 *      velocity. Unresolvable ⇒ defend where it was lost; it resumes the
 *      escort if the ship can be resolved again.
 *    - `hunt`: chase the contact `view.nearestHostile` returns within sensor
 *      range (`roleSensorRange(aiRole, fireRange)`); none ⇒ defend the post
 *      (the spot the last chase ended). A `holdFire` stance never chases.
 *    - `retreat`: fly to the retreat point (default: the guard post) without
 *      engaging, then defend there (the mode becomes `defend`).
 *  - ORDER: one-off, on top of the mode. `move` (arrive at a point), `stop`
 *    (brake in place, then defend the spot it halts on), `attack` (pursue to
 *    a stand-off).
 *  - When an order completes the mode RESUMES FROM WHERE THE SHIP IS NOW:
 *    defend / hunt take the current spot as the post; patrol flies to the
 *    waypoint nearest the ship and loops on from there; escort re-forms on
 *    its ship; retreat carries on to its point.
 *  - MORALE: `reportDamage` feeds a `MoraleTracker`; a fired trigger rolls the
 *    seeded morale die (`rollMorale`, role weights). FallBack / Flee break off
 *    any order and fly AWAY from the threat (2× / 5× the guard radius; no
 *    known threat ⇒ back to the post), activity `retreating`; on arrival the
 *    mode resumes from there. Deterministic: same ship seed + damage ⇒ same
 *    roll. A new order or mode from the owner cancels a morale retreat.
 *  - STANCE: stored for the firing slice; the only movement effect is that a
 *    `holdFire` hunter does not chase (it defends).
 *  - FIRING: none. This brain only moves; `targetId` is what it is chasing.
 *  - FORMATION (RTS slice 15b, squads): a ROLE on top of the mode, set by the
 *    fleet subsystem with `setFormationSlot(leaderId, slot, shape)`. With no
 *    order (and no morale retreat) a formation member flies to its slot
 *    (`formationSlotOffset` round the leader, in the leader's travel frame)
 *    and matches the leader's velocity, the escort station-keeping; activity
 *    'formingUp' off station, 'guarding' on it. If the subsystem hands it the
 *    leader's target (`setLeaderTarget`) and the stance is not `holdFire`, it
 *    engages that target instead, then returns to the slot. A one-off order
 *    still wins; when it completes the member REJOINS its slot (not its own
 *    mode). A `stop` order brakes to a halt, then rejoins. Leader lost ⇒
 *    defend where it was lost until it resolves again. `clearFormation()`
 *    resumes the mode from where the ship is.
 *
 * Pure, zone-blind, allocation-free per tick (#14): scratch lives on fields.
 * Size-dependent distances (arrive / guard radius) come from the caller, which
 * reads them from `shipTuning(kind)` (#18).
 */
import type { AiRole } from '../../shared-types/shipKinds/types.js';
import {
  formationSlotOffset,
  formationSlotWorldPose,
  makeSlotOffset,
  type FormationShape,
  type SlotOffset,
  type WorldPoint,
} from './formation.js';
import {
  MORALE_LOCK_TICKS,
  MORALE_OUTCOME,
  MoraleTracker,
  moraleSeed,
  rollMorale,
  type MoraleInputs,
  type MoraleOutcome,
  type MoraleWeights,
} from './tactics/morale.js';
import { roleProfile, roleSensorRange } from './tactics/roleProfiles.js';
import {
  brakeBand,
  headingOf,
  intentToControlBits,
  makeControlIntent,
} from './wingman/intentToControlBits.js';
import type {
  WingmanActivity,
  WingmanControls,
  WingmanMode,
  WingmanModeData,
  WingmanOrder,
  WingmanPose,
  WingmanPoseOut,
  WingmanShipStats,
  WingmanStance,
  WingmanWorldView,
} from './wingman/types.js';
import { makeWingmanControls, WINGMAN_ROUTE_MAX, WINGMAN_ROUTE_MIN } from './wingman/types.js';

/** The brain contract the server's fleet subsystem drives once per tick. */
export interface IWingmanBrain {
  tick(self: WingmanPose, view: WingmanWorldView): WingmanControls;
  readonly activity: WingmanActivity;
  /** The entity the wingman is engaging / pursuing, or null. */
  readonly targetId: string | null;
}

export interface WingmanConfig {
  readonly stats: WingmanShipStats;
  /** An order to a point is done inside this radius (u). */
  readonly arriveRadius: number;
  /** Defend: the ship returns to its post once further than this (u). */
  readonly guardRadius: number;
  /** Boost on legs longer than this (u). Default 3 × guardRadius. */
  readonly boostDistance?: number;
  /** Attack / hunt: hold this far from the target (u). Default guardRadius / 2. */
  readonly attackStandoff?: number;
  readonly mode?: WingmanMode;
  readonly stance?: WingmanStance;
  /** The hull's tactical role (sensor range, morale weights). Default 'fighter'. */
  readonly aiRole?: AiRole;
  /** The ship's fire range (u), for the role sensor range. Default 0 ⇒ the
   *  `ON_SIGHT_ENGAGE_RANGE` floor. */
  readonly fireRange?: number;
  /** Hunt search radius (u). Default `roleSensorRange(aiRole, fireRange)`. */
  readonly sensorRange?: number;
  /** Morale die weights. Default `roleProfile(aiRole).moraleWeights`. */
  readonly moraleWeights?: MoraleWeights;
  /** Numeric ship id that seeds the morale roll (e.g. `fnv1a32(shipId)`). Default 0. */
  readonly moraleSeedId?: number;
  /** Escort: wedge spacing to the escorted ship (u). Default guardRadius / 2. */
  readonly escortSpacing?: number;
  /** Patrol: a waypoint counts as passed inside this (u). Default
   *  max(2 × arriveRadius, guardRadius / 4). */
  readonly patrolPassRadius?: number;
}

/** Plan braking at this fraction of the reverse deceleration (margin for the
 *  turn latency and the on/off control). */
export const WINGMAN_BRAKE_MARGIN = 0.8;
/** An order to a point is done once slower than this fraction of max speed. */
export const WINGMAN_ARRIVE_SPEED_FRAC = 0.03;
/** Morale FallBack: break off this many guard radii away from the threat. */
export const WINGMAN_FALLBACK_DIST_MUL = 2;
/** Morale Flee: run this many guard radii away from the threat. */
export const WINGMAN_FLEE_DIST_MUL = 5;
/** Escort: the escorted ship's heading follows its velocity above this
 *  fraction of OUR max speed (below it, the last heading is kept). */
export const WINGMAN_ESCORT_HEADING_SPEED_FRAC = 0.05;

/**
 * Distance a ship at speed `v` covers while braking with reverse held:
 * dv/dt = −(a + k·v) ⇒ d = v/k − (a/k²)·ln(1 + k·v/a). Without damping,
 * v²/2a.
 */
export function stoppingDistance(v: number, stats: WingmanShipStats): number {
  if (v <= 0) return 0;
  const a = stats.reverseAccel, k = stats.linearDamping;
  if (a <= 0) return k > 0 ? v / k : Infinity;
  if (k <= 1e-9) return (v * v) / (2 * a);
  return v / k - (a / (k * k)) * Math.log(1 + (k * v) / a);
}

type MutableMoraleInputs = { -readonly [K in keyof MoraleInputs]: MoraleInputs[K] };

export class WingmanBehaviour implements IWingmanBrain {
  private readonly stats: WingmanShipStats;
  private readonly arriveRadius: number;
  private guardRadius: number;
  private readonly boostDistance: number;
  private readonly attackStandoff: number;
  private readonly sensorRange: number;
  private readonly moraleWeights: MoraleWeights;
  private readonly moraleSeedId: number;
  private readonly patrolPassRadius: number;
  private readonly escortTolerance: number;
  /** Escort / formation spacing (u). */
  private readonly spacing: number;

  private _mode: WingmanMode;
  private _stance: WingmanStance;
  private _order: WingmanOrder | null = null;
  private _activity: WingmanActivity = 'idle';
  private _targetId: string | null = null;

  private postX = 0;
  private postY = 0;
  /** False ⇒ the next tick takes the current position as the guard post. */
  private postValid = false;
  /** Defend: flying back to the post after being pushed out. */
  private returning = false;
  /** Stop order: braking in place; the halt spot becomes the post (reads as
   *  'guarding'). */
  private settling = false;

  // Patrol.
  private readonly routeX = new Float64Array(WINGMAN_ROUTE_MAX);
  private readonly routeY = new Float64Array(WINGMAN_ROUTE_MAX);
  private routeLen = 0;
  private routeIdx = 0;
  /** True ⇒ the next patrol tick heads for the waypoint nearest the ship. */
  private routeSeek = true;

  // Escort.
  private _escortId: string | null = null;
  private escortHeading = 0;
  private escortHeadingValid = false;
  private escortLost = false;
  private onStation = false;
  private readonly escortSlot = makeSlotOffset();
  private readonly stationPt: WorldPoint = { x: 0, y: 0 };

  // Formation (squad member role; null leader ⇒ not in formation).
  private _formationLeaderId: string | null = null;
  private _formationSlotIndex = 0;
  private _formationShape: FormationShape = 'wedge';
  private readonly formationSlot = makeSlotOffset();
  private formationHeading = 0;
  private formationHeadingValid = false;
  private formationLost = false;
  private formationOnStation = false;
  private formationTolerance = 0;
  /** The squad leader's current target (set by the subsystem), or null. */
  private _leaderTargetId: string | null = null;

  // Hunt.
  private huntEngaged = false;

  // Retreat mode.
  private retreatX = 0;
  private retreatY = 0;
  private retreatPointSet = false;

  // Morale.
  private readonly morale = new MoraleTracker();
  private readonly moraleInputs: MutableMoraleInputs = {
    hullFrac: 1, recentDamageRate: 0, alliesNear: 0, enemiesNear: 0, ownSize: 0, enemySize: 0,
    isCapitalNearbyFriendly: false,
  };
  private moraleDirty = false;
  private hullFrac = 1;
  private threatX = 0;
  private threatY = 0;
  private threatValid = false;
  private moraleRetreating = false;
  private moraleRetreatX = 0;
  private moraleRetreatY = 0;
  private _moraleOutcome: MoraleOutcome | null = null;
  private moraleRollTick = 0;
  private lastTick = 0;

  private readonly intent = makeControlIntent();
  private readonly controls = makeWingmanControls();
  private readonly targetPose: WingmanPoseOut = { x: 0, y: 0, vx: 0, vy: 0, angle: Number.NaN };
  /** `targetPose` holds the last resolved target (a morale threat fallback). */
  private targetPoseValid = false;

  constructor(config: WingmanConfig) {
    this.stats = config.stats;
    this.arriveRadius = config.arriveRadius;
    this.guardRadius = config.guardRadius;
    this.boostDistance = config.boostDistance ?? config.guardRadius * 3;
    this.attackStandoff = config.attackStandoff ?? config.guardRadius * 0.5;
    this._mode = config.mode ?? 'defend';
    this._stance = config.stance ?? 'defensive';
    const role = config.aiRole ?? 'fighter';
    this.sensorRange = config.sensorRange ?? roleSensorRange(role, config.fireRange ?? 0);
    this.moraleWeights = config.moraleWeights ?? roleProfile(role).moraleWeights;
    this.moraleSeedId = config.moraleSeedId ?? 0;
    this.patrolPassRadius = config.patrolPassRadius ?? Math.max(config.arriveRadius * 2, config.guardRadius * 0.25);
    const spacing = config.escortSpacing ?? config.guardRadius * 0.5;
    this.spacing = spacing;
    // Wedge slot 1: one rank astern, to starboard.
    formationSlotOffset('wedge', 1, 2, spacing, this.escortSlot);
    this.escortTolerance = Math.max(config.arriveRadius * 2, spacing * 0.5);
  }

  // ---- Read-outs (status streaming) ---------------------------------------
  get mode(): WingmanMode { return this._mode; }
  get stance(): WingmanStance { return this._stance; }
  get order(): WingmanOrder | null { return this._order; }
  get activity(): WingmanActivity { return this._activity; }
  get targetId(): string | null { return this._targetId; }
  /** Current guard post, or null until the first tick sets it. */
  get guardPostX(): number | null { return this.postValid ? this.postX : null; }
  get guardPostY(): number | null { return this.postValid ? this.postY : null; }
  /** Patrol: index of the waypoint being flown to. */
  get patrolWaypointIndex(): number { return this.routeIdx; }
  /** Patrol: number of waypoints (0 when not patrolling a route). */
  get patrolRouteLength(): number { return this.routeLen; }
  /** Patrol: waypoint `i` (0 ≤ i < patrolRouteLength), x then y. */
  patrolRouteX(i: number): number { return this.routeX[i]!; }
  patrolRouteY(i: number): number { return this.routeY[i]!; }
  /** Escort: the ship being escorted, or null. */
  get escortId(): string | null { return this._escortId; }
  /** Retreat: the point being retreated to, or null while none is set (the
   *  first retreat tick defaults it to the guard post). */
  get retreatPointX(): number | null { return this.retreatPointSet ? this.retreatX : null; }
  get retreatPointY(): number | null { return this.retreatPointSet ? this.retreatY : null; }
  /** Hunt search radius (u). */
  get huntSensorRange(): number { return this.sensorRange; }
  /** Formation: the leader this ship keeps station on, or null. */
  get formationLeaderId(): string | null { return this._formationLeaderId; }
  /** Formation: this ship's slot index (1.. ; 0 = the leader's anchor). */
  get formationSlotIndex(): number { return this._formationSlotIndex; }
  get formationShape(): FormationShape { return this._formationShape; }
  /** Escort / formation spacing this hull wants (u, size-dependent). */
  get stationSpacing(): number { return this.spacing; }
  /**
   * The latest morale roll while it matters (for the UI): during the morale
   * retreat it caused, or for `MORALE_LOCK_TICKS` after the roll. Null when
   * no roll is current.
   */
  get moraleOutcome(): MoraleOutcome | null {
    if (this._moraleOutcome === null) return null;
    if (this.moraleRetreating || this.lastTick - this.moraleRollTick < MORALE_LOCK_TICKS) return this._moraleOutcome;
    return null;
  }
  /** True while running from a FallBack / Flee morale roll. */
  get isMoraleRetreating(): boolean { return this.moraleRetreating; }

  // ---- Commands (discrete, event-driven) ----------------------------------
  /**
   * Change the standing mode. Does not cancel a direct order; cancels a morale
   * retreat (the owner's word wins).
   *  - `setMode(mode, x, y)` / `setMode(mode, { x, y })`: defend / hunt post,
   *    or the retreat point.
   *  - `setMode('patrol', { route })`: 2–16 waypoints (extra dropped); fewer
   *    ⇒ `defend` at the single waypoint, else at `x, y`, else here.
   *  - `setMode('escort', { escortId })`: no id ⇒ `defend` here.
   *  - `setMode('retreat')` with no point: retreat to the current post.
   * Without a post, defend / hunt resume from the current position.
   */
  setMode(mode: WingmanMode, data?: number | WingmanModeData, postY?: number): void {
    let px: number | undefined;
    let py: number | undefined;
    let md: WingmanModeData | undefined;
    if (typeof data === 'number') { px = data; py = postY; } else if (data !== undefined) { md = data; px = data.x; py = data.y; }
    const hasPoint = px !== undefined && py !== undefined;

    this._mode = mode;
    this.returning = false;
    this.settling = false;
    this.moraleRetreating = false;
    this.huntEngaged = false;
    if (this._order === null || this._order.kind !== 'attack') this._targetId = null;
    this._escortId = null;
    this.escortLost = false;
    this.escortHeadingValid = false;
    this.onStation = false;
    this.routeLen = 0;
    this.retreatPointSet = false;

    switch (mode) {
      case 'patrol': {
        const r = md?.route;
        const n = r !== undefined ? Math.min(r.length, WINGMAN_ROUTE_MAX) : 0;
        if (n >= WINGMAN_ROUTE_MIN) {
          for (let i = 0; i < n; i++) { this.routeX[i] = r![i]![0]; this.routeY[i] = r![i]![1]; }
          this.routeLen = n;
          this.routeIdx = 0;
          this.routeSeek = true;
          this.postValid = false;
          return;
        }
        this._mode = 'defend';
        if (n === 1) this.setGuardPost(r![0]![0], r![0]![1]);
        else if (hasPoint) this.setGuardPost(px!, py!);
        else this.postValid = false;
        return;
      }
      case 'escort':
        if (md?.escortId !== undefined && md.escortId !== '') this._escortId = md.escortId;
        else this._mode = 'defend';
        this.postValid = false;
        return;
      case 'retreat':
        // Default retreat point = the current post (resolved on the first tick).
        if (hasPoint) { this.retreatX = px!; this.retreatY = py!; this.retreatPointSet = true; }
        return;
      case 'defend':
      case 'hunt':
        if (hasPoint) this.setGuardPost(px!, py!);
        else this.postValid = false;
        return;
    }
  }

  setStance(stance: WingmanStance): void { this._stance = stance; }

  /**
   * Formation role (squads): keep station in slot `slotIndex` (1..) of a
   * `shape` formation round `leaderId`, `spacing` apart (default: this hull's
   * own escort spacing; the subsystem passes the squad's largest so mixed
   * sizes don't collide). Re-setting the same leader keeps the travel heading
   * (only the slot moves). Does not touch the mode or a current order.
   */
  setFormationSlot(
    leaderId: string,
    slotIndex: number,
    shape: FormationShape = 'wedge',
    count: number = slotIndex + 1,
    spacing: number = this.spacing,
  ): void {
    if (leaderId !== this._formationLeaderId) {
      this.formationHeadingValid = false;
      this.formationLost = false;
      this.formationOnStation = false;
      this._leaderTargetId = null;
    }
    this._formationLeaderId = leaderId;
    this._formationSlotIndex = slotIndex;
    this._formationShape = shape;
    formationSlotOffset(shape, slotIndex, count, spacing, this.formationSlot);
    this.formationTolerance = Math.max(this.arriveRadius * 2, spacing * 0.5);
  }

  /** Leave the formation: the mode resumes from where the ship is. */
  clearFormation(): void {
    if (this._formationLeaderId === null) return;
    this._formationLeaderId = null;
    this._leaderTargetId = null;
    this.formationOnStation = false;
    this.formationLost = false;
    if (this._order === null) this._targetId = null;
    this.postValid = false;
    this.returning = false;
    this.routeSeek = true;
    this.huntEngaged = false;
  }

  /** Formation: what the squad leader is engaging (null = nothing). Members
   *  follow it unless their stance is `holdFire`. */
  setLeaderTarget(targetId: string | null): void { this._leaderTargetId = targetId; }

  setGuardPost(x: number, y: number): void {
    this.postX = x; this.postY = y; this.postValid = true;
    this.returning = false; this.settling = false;
  }

  setGuardRadius(r: number): void { this.guardRadius = r; }

  /** Replace any current order (cancels a morale retreat). Takes effect on
   *  the next tick. */
  issueOrder(order: WingmanOrder): void {
    this._order = order;
    this._targetId = order.kind === 'attack' ? order.targetId : null;
    this.moraleRetreating = false;
    this.huntEngaged = false;
  }

  /** Drop the current order and resume the mode from where the ship is. */
  clearOrder(): void {
    this._order = null;
    this._targetId = null;
    this.postValid = false;
    this.returning = false;
    this.routeSeek = true;
  }

  /**
   * The ship took `amount` damage (max hull `maxHull`, hull now `hullFrac`
   * 0..1), optionally from a threat at (threatX, threatY). Feeds the morale
   * tracker; the next tick checks the triggers and may roll the morale die.
   * Event-driven (call on each damage event), allocation-free.
   */
  reportDamage(amount: number, maxHull: number, hullFrac: number, threatX?: number, threatY?: number): void {
    this.morale.noteDamage(this.lastTick, amount, maxHull);
    this.hullFrac = hullFrac < 0 ? 0 : hullFrac > 1 ? 1 : hullFrac;
    this.moraleDirty = true;
    if (threatX !== undefined && threatY !== undefined) {
      this.threatX = threatX; this.threatY = threatY; this.threatValid = true;
    }
  }

  // ---- Per-tick -------------------------------------------------------------
  tick(self: WingmanPose, view: WingmanWorldView): WingmanControls {
    this.lastTick = view.tick;
    if (!this.postValid) this.setGuardPost(self.x, self.y);
    const it = this.intent;
    it.dvx = 0; it.dvy = 0; it.boost = false;

    if (this.moraleDirty) this.checkMorale(self, view.tick);
    if (this.moraleRetreating) {
      if (!this.steerTo(self, this.moraleRetreatX, this.moraleRetreatY, true)) {
        this._activity = 'retreating';
        return intentToControlBits(it, self, this.stats, this.controls);
      }
      // Got clear: resume the mode from here.
      this.moraleRetreating = false;
      this.resumeFrom(self);
    }

    const order = this._order;
    let handled = false;
    if (order !== null) {
      switch (order.kind) {
        case 'move':
          if (this.steerTo(self, order.x, order.y, true)) {
            this.completeOrder(self);
          } else {
            this._activity = 'moving';
            handled = true;
          }
          break;
        case 'stop': {
          if (this._formationLeaderId !== null) {
            // Formation member: brake to a halt, then rejoin the slot.
            if (Math.hypot(self.vx, self.vy) <= this.stats.maxSpeed * WINGMAN_ARRIVE_SPEED_FRAC) {
              this.completeOrder(self);
            } else {
              this._activity = 'guarding';
              handled = true;
            }
            break;
          }
          // Hold position: brake where it is, then defend the spot it halts
          // on. Until then the post is the predicted braking point (what the
          // UI shows), but the ship does NOT steer for it: steering onto an
          // extrapolated point turned a sideways bump into a drift, and two
          // ships stopped hull to hull drove apart for seconds (RTS stop
          // drift, 2026-11-14). It only brakes; the halt spot is the post.
          const sp = Math.hypot(self.vx, self.vy);
          const d = stoppingDistance(sp, this.stats);
          const k = sp > 1e-6 ? d / sp : 0;
          this._order = null;
          this._targetId = null;
          this._mode = 'defend';
          this.routeLen = 0;
          this._escortId = null;
          this.setGuardPost(self.x + self.vx * k, self.y + self.vy * k);
          this.settling = true;
          break;
        }
        case 'attack':
          if (this.pursue(self, view, order.targetId)) handled = true;
          else this.completeOrder(self);
          break;
      }
    }

    // Off doing an order: back from it, the member forms up afresh.
    if (handled) this.formationOnStation = false;
    else {
      if (this._formationLeaderId !== null) this.tickFormation(self, view);
      else this.runMode(self, view);
    }
    return intentToControlBits(it, self, this.stats, this.controls);
  }

  /** Order done: clear it and resume the mode from the current position. */
  private completeOrder(self: WingmanPose): void {
    this._order = null;
    this._targetId = null;
    this.resumeFrom(self);
  }

  /** The resume rule (owner): carry on from where the ship is NOW. Defend /
   *  hunt: the post becomes this spot. Patrol: head for the nearest waypoint.
   *  Escort re-forms on its ship; retreat keeps its point. */
  private resumeFrom(self: WingmanPose): void {
    this.setGuardPost(self.x, self.y);
    this.routeSeek = true;
    this.huntEngaged = false;
  }

  private runMode(self: WingmanPose, view: WingmanWorldView): void {
    switch (this._mode) {
      case 'defend':
        this.tickDefend(self);
        break;
      case 'patrol':
        if (this.routeLen >= WINGMAN_ROUTE_MIN) this.tickPatrol(self);
        else this.tickDefend(self);
        break;
      case 'escort':
        this.tickEscort(self, view);
        break;
      case 'hunt':
        this.tickHunt(self, view);
        break;
      case 'retreat':
        this.tickRetreat(self);
        break;
    }
  }

  private tickDefend(self: WingmanPose): void {
    if (this.settling) {
      // Stop order: brake in place (intent stays zero); the spot it halts
      // on becomes the post.
      this._activity = 'guarding';
      if (Math.hypot(self.vx, self.vy) <= brakeBand(this.stats)) this.setGuardPost(self.x, self.y);
      return;
    }
    const dx = this.postX - self.x, dy = this.postY - self.y;
    if (dx * dx + dy * dy > this.guardRadius * this.guardRadius) this.returning = true;
    if (this.returning) {
      if (this.steerTo(self, this.postX, this.postY, true)) {
        this.returning = false;
        this._activity = 'guarding';
      } else {
        this._activity = 'moving';
      }
      return;
    }
    // Inside the guard radius: hold still (intent stays zero ⇒ brake): a bump
    // from a neighbour that leaves it inside the radius never flies it back.
    this._activity = 'guarding';
  }

  /** Patrol: fly the route as a closed loop, passing (not stopping at) each
   *  waypoint. After a resume, start from the waypoint nearest the ship. */
  private tickPatrol(self: WingmanPose): void {
    const n = this.routeLen;
    if (this.routeSeek) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = this.routeX[i]! - self.x, dy = this.routeY[i]! - self.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      this.routeIdx = best;
      this.routeSeek = false;
    }
    let tx = this.routeX[this.routeIdx]!, ty = this.routeY[this.routeIdx]!;
    const dx = tx - self.x, dy = ty - self.y;
    if (dx * dx + dy * dy <= this.patrolPassRadius * this.patrolPassRadius) {
      this.routeIdx = (this.routeIdx + 1) % n;
      tx = this.routeX[this.routeIdx]!; ty = this.routeY[this.routeIdx]!;
    }
    this.steerTo(self, tx, ty, true);
    this._activity = 'patrolling';
  }

  /** Escort: hold the wedge slot behind-starboard of the escorted ship in its
   *  travel frame, matching its velocity. */
  private tickEscort(self: WingmanPose, view: WingmanWorldView): void {
    const id = this._escortId;
    const tp = this.targetPose;
    if (id === null || view.resolvePoseInto === undefined || !view.resolvePoseInto(id, tp)) {
      // Lost it: defend the spot where it was lost (until it can be resolved).
      if (!this.escortLost) {
        this.escortLost = true;
        this.onStation = false;
        this.setGuardPost(self.x, self.y);
      }
      this.tickDefend(self);
      return;
    }
    this.escortLost = false;
    const sp = Math.hypot(tp.vx, tp.vy);
    if (sp > this.stats.maxSpeed * WINGMAN_ESCORT_HEADING_SPEED_FRAC) {
      this.escortHeading = headingOf(tp.vx, tp.vy);
      this.escortHeadingValid = true;
    } else if (!this.escortHeadingValid) {
      // Parked escortee: take "behind" to be our side of it (no crossing over).
      this.escortHeading = headingOf(tp.x - self.x, tp.y - self.y);
      this.escortHeadingValid = true;
    }
    const dist = this.keepStation(self, tp, this.escortHeading, this.escortSlot);
    if (dist <= this.escortTolerance) this.onStation = true;
    else if (dist > this.escortTolerance * 2) this.onStation = false;
    this._activity = this.onStation ? 'guarding' : 'formingUp';
  }

  /** Fly to `slot` round `tp` (heading `heading`) and match its velocity.
   *  Returns the distance to the slot. Shared by escort and formation. */
  private keepStation(self: WingmanPose, tp: WingmanPoseOut, heading: number, slot: SlotOffset): number {
    const st = formationSlotWorldPose(tp.x, tp.y, heading, slot, this.stationPt);
    const dist = Math.hypot(st.x - self.x, st.y - self.y);
    this.steerTo(self, st.x, st.y, true);
    this.intent.dvx += tp.vx;
    this.intent.dvy += tp.vy;
    return dist;
  }

  /** Formation member: engage the leader's target (stance permitting), else
   *  hold the slot round the leader in its travel frame, velocity-matched. */
  private tickFormation(self: WingmanPose, view: WingmanWorldView): void {
    const tp = this.targetPose;
    const lt = this._leaderTargetId;
    if (lt !== null && this._stance !== 'holdFire' && view.resolvePoseInto !== undefined && view.resolvePoseInto(lt, tp)) {
      this.engage(self, lt, tp);
      return;
    }
    this._targetId = null;
    tp.angle = Number.NaN;
    const id = this._formationLeaderId!;
    if (view.resolvePoseInto === undefined || !view.resolvePoseInto(id, tp)) {
      // Lost the leader: defend the spot where it was lost.
      if (!this.formationLost) {
        this.formationLost = true;
        this.formationOnStation = false;
        this.setGuardPost(self.x, self.y);
      }
      this.tickDefend(self);
      return;
    }
    this.formationLost = false;
    const sp = Math.hypot(tp.vx, tp.vy);
    if (sp > this.stats.maxSpeed * WINGMAN_ESCORT_HEADING_SPEED_FRAC) {
      this.formationHeading = headingOf(tp.vx, tp.vy);
      this.formationHeadingValid = true;
    } else if (!this.formationHeadingValid) {
      // Parked leader: its nose (every member agrees on it); unknown ⇒ our side.
      const a = tp.angle;
      this.formationHeading = a !== undefined && Number.isFinite(a) ? a : headingOf(tp.x - self.x, tp.y - self.y);
      this.formationHeadingValid = true;
    }
    const dist = this.keepStation(self, tp, this.formationHeading, this.formationSlot);
    if (dist <= this.formationTolerance) this.formationOnStation = true;
    else if (dist > this.formationTolerance * 2) this.formationOnStation = false;
    this._activity = this.formationOnStation ? 'guarding' : 'formingUp';
  }

  /** Hunt: chase the hostile the view offers within sensor range; none (or a
   *  holdFire stance) ⇒ defend the post, which is where the last chase ended. */
  private tickHunt(self: WingmanPose, view: WingmanWorldView): void {
    let id: string | null = null;
    if (this._stance !== 'holdFire' && view.nearestHostile !== undefined) {
      id = view.nearestHostile(self.x, self.y, this.sensorRange, this.targetPose);
    }
    if (id === null) {
      if (this.huntEngaged) {
        this.huntEngaged = false;
        this._targetId = null;
        this.setGuardPost(self.x, self.y);
      }
      this.tickDefend(self);
      return;
    }
    this.huntEngaged = true;
    this.engage(self, id, this.targetPose);
  }

  /** Retreat mode: fly to the point without engaging, then defend there. */
  private tickRetreat(self: WingmanPose): void {
    if (!this.retreatPointSet) {
      this.retreatX = this.postX; this.retreatY = this.postY; this.retreatPointSet = true;
    }
    if (this.steerTo(self, this.retreatX, this.retreatY, true)) {
      this._mode = 'defend';
      this.retreatPointSet = false;
      this.setGuardPost(self.x, self.y);
      this._activity = 'guarding';
      return;
    }
    this._activity = 'retreating';
  }

  /** Check the morale triggers; a fired one rolls the die. */
  private checkMorale(self: WingmanPose, tick: number): void {
    this.moraleDirty = false;
    const trig = this.morale.update(tick, this.hullFrac, 0, 0);
    if (trig === -1) return;
    const inp = this.moraleInputs;
    inp.hullFrac = this.hullFrac;
    inp.recentDamageRate = this.morale.windowDamageFrac(tick);
    const outcome = rollMorale(inp, this.moraleWeights, moraleSeed(this.moraleSeedId, this.morale.triggerCount));
    this._moraleOutcome = outcome;
    this.moraleRollTick = tick;
    if (outcome === MORALE_OUTCOME.FightOn) return;
    const dist = this.guardRadius * (outcome === MORALE_OUTCOME.Flee ? WINGMAN_FLEE_DIST_MUL : WINGMAN_FALLBACK_DIST_MUL);
    let ax = 0, ay = 0, known = false;
    if (this.threatValid) { ax = self.x - this.threatX; ay = self.y - this.threatY; known = true; }
    else if (this._targetId !== null && this.targetPoseValid) {
      ax = self.x - this.targetPose.x; ay = self.y - this.targetPose.y; known = true;
    }
    const d = Math.sqrt(ax * ax + ay * ay);
    if (known && d > 1e-6) {
      this.moraleRetreatX = self.x + (ax / d) * dist;
      this.moraleRetreatY = self.y + (ay / d) * dist;
    } else {
      // No known threat direction: fall back to the post.
      this.moraleRetreatX = this.postX;
      this.moraleRetreatY = this.postY;
    }
    this.threatValid = false;
    // Break off: drop the order (and any chase), run.
    this._order = null;
    this._targetId = null;
    this.huntEngaged = false;
    this.moraleRetreating = true;
    this._activity = 'retreating';
  }

  /**
   * Set the intent to arrive at (tx, ty): full speed far out, slowing so the
   * reverse key can stop the ship at the point. Returns true once inside the
   * arrive radius and nearly stopped (the intent is then zero ⇒ brake).
   */
  private steerTo(self: WingmanPose, tx: number, ty: number, allowBoost: boolean): boolean {
    const dx = tx - self.x, dy = ty - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const it = this.intent;
    if (dist <= this.arriveRadius) {
      it.dvx = 0; it.dvy = 0; it.boost = false;
      return Math.hypot(self.vx, self.vy) <= this.stats.maxSpeed * WINGMAN_ARRIVE_SPEED_FRAC;
    }
    const brakeDist = Math.max(0, dist - this.arriveRadius * 0.5);
    const a = this.stats.reverseAccel * WINGMAN_BRAKE_MARGIN;
    const v = Math.min(this.stats.maxSpeed, Math.sqrt(2 * a * brakeDist));
    it.dvx = (dx / dist) * v;
    it.dvy = (dy / dist) * v;
    it.boost = allowBoost && dist > this.boostDistance;
    return false;
  }

  /** Attack order movement. False ⇒ the target is gone. */
  private pursue(self: WingmanPose, view: WingmanWorldView, targetId: string): boolean {
    const tp = this.targetPose;
    if (view.resolvePoseInto === undefined || !view.resolvePoseInto(targetId, tp)) {
      this.targetPoseValid = false;
      return false;
    }
    this.engage(self, targetId, tp);
    return true;
  }

  /** Close to the stand-off on `tp` and match its velocity (no firing). */
  private engage(self: WingmanPose, targetId: string, tp: WingmanPoseOut): void {
    this._targetId = targetId;
    this.targetPoseValid = true;
    const dx = tp.x - self.x, dy = tp.y - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const standoff = this.attackStandoff;
    if (dist > 1e-6) {
      const ux = dx / dist, uy = dy / dist;
      this.steerTo(self, tp.x - ux * standoff, tp.y - uy * standoff, true);
    }
    // Feed the target's velocity forward so the wingman keeps station on it.
    this.intent.dvx += tp.vx;
    this.intent.dvy += tp.vy;
    this._activity = dist > standoff * 1.5 ? 'chasing' : 'attacking';
  }
}
