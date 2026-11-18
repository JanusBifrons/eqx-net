/**
 * Combat movement through context steering (AI steering plan slice 2c), owned
 * by `HostileDroneBehaviour` and built once: the context maps and output, the
 * facing latch, and the resolve. Each `steer` writes the pilot's wanted
 * facing, velocity, boost and pilot params into this object's out fields; the
 * brain flies them through the virtual pilot. Allocation-free (#14).
 */
import type { AiEntity, IAiAimBoard, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import type { AllegianceSide } from '../../../shared-types/allegiances.js';
import type { ShipKind } from '../../../shared-types/shipKinds.js';
import {
  addDangerFromPoint,
  addInterestToward,
  createContextMaps,
  makeContextOutput,
  resolveContext,
  type ContextMaps,
  type ContextSteerOutput,
} from '../contextSteering.js';
import type { HullAvoid } from '../hullAvoid.js';
import {
  COMBAT_CROWD_SPEED,
  COMBAT_NEIGHBOUR_K,
  COMBAT_PILOT_PARAMS,
  COMBAT_SEP_CORE,
  COMBAT_SEP_REACH,
  FACE_MOVE_ENTER,
  FACE_MOVE_EXIT,
  FACE_MOVE_MIN_SPEED,
  RUN_NOW_PILOT_PARAMS,
  RUN_PILOT_PARAMS,
} from '../hostileDroneTuning.js';
import { facingOf, wrapAngle, type PilotHandling, type PilotParams, type PilotState } from '../virtualPilot.js';
import type { CombatDecision } from './combatDecision.js';
import { type FireLaneSteer, fireLaneAvoidanceOn, NUDGE_MAX_OFF, NUDGE_SPEED_FRAC } from './fireLanes.js';
import { FACE_AIM_LEAD, FACE_MOVE, MANOEUVRE_BREAK, type ManoeuvreGoal, type TacticalContext } from './manoeuvre.js';

/** The brain's fixed steering numbers (set once at construction). */
export interface CombatSteerTune {
  readonly kind: ShipKind;
  readonly handling: PilotHandling;
  readonly allegiance: AllegianceSide;
  readonly friendlyToPilots: boolean;
  /** `shipTuning(kind).combatSeparation` / `.shieldPad`, cached. */
  readonly combatSeparation: number;
  readonly shieldPad: number;
  readonly fireRange: number;
}

export class CombatSteer {
  /** The context maps the running manoeuvre writes its interest into. */
  readonly maps: ContextMaps = createContextMaps();
  /** The last resolve. */
  readonly out: ContextSteerOutput = makeContextOutput();
  /** Facing latch: true while the nose follows the move heading, not the lead. */
  faceMove = false;
  /** Did the last combat tick resolve through context steering? */
  used = false;
  /** Out: the facing, wanted velocity, boost and pilot params to fly. */
  facing = 0;
  wvx = 0;
  wvy = 0;
  boost = false;
  params: Readonly<PilotParams> = COMBAT_PILOT_PARAMS;

  constructor(
    private readonly tune: CombatSteerTune,
    private readonly pilot: PilotState,
    private readonly tac: TacticalContext,
    private readonly avoid: HullAvoid,
    private readonly lanes: FireLaneSteer,
    private readonly decide: CombatDecision,
    /** The neighbour buffer (`COMBAT_NEIGHBOUR_K`), shared with the senses. */
    private readonly nbIdx: Int32Array,
  ) {}

  /**
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
   * comes back round. `reserveOk`: the pool is above the boost reserve;
   * `avoidAccel`: the dodge thrust. True when it dodges a hull instead.
   */
  steer(
    self: AiEntity,
    nb: IAiNeighbourQuery,
    debris: IAiNeighbourQuery | undefined,
    aims: IAiAimBoard | undefined,
    ux: number,
    uy: number,
    leadAngle: number,
    inRange: boolean,
    goal: ManoeuvreGoal,
    reserveOk: boolean,
    avoidAccel: number,
  ): boolean {
    const tu = this.tune;
    // Fine aim only while the nose is held on the lead (set again below): a
    // nose on the move course, a nudge or a dodge has nothing to line up.
    const aimCone = this.pilot.turn.aimCone;
    this.pilot.turn.aimCone = 0;
    // The running manoeuvre has already written its interest into the maps.
    const m = this.maps;
    const goalSpeed = goal.speed;

    const sep = tu.combatSeparation;
    const reach = sep * COMBAT_SEP_REACH;
    const core = sep * COMBAT_SEP_CORE;
    const idx = this.nbIdx;
    const n = nb.queryNeighbours(self.x, self.y, reach, COMBAT_NEIGHBOUR_K, idx, self.id);
    let pushX = 0;
    let pushY = 0;
    let crowd = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      if (nb.isPilotAt(i) ? !tu.friendlyToPilots : nb.sideAt(i) !== tu.allegiance) continue;
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
      const ln = this.lanes, tick = this.tac.tick;
      if (aims !== undefined && ln.addAllyLanes(self, nb, aims, this.nbIdx, this.maps, tick, tu.fireRange,
        tu.handling.cruiseSpeed, tu.kind.radius, tu.allegiance)) nudging = true;
      if (ln.writeBlockedNudge(self, ux, uy, this.maps, tick, tu.combatSeparation,
        this.decide.picker.current, this.decide.attackRun.diving, this.decide.kite.running)) nudging = true;
    }

    const out = resolveContext(m, this.out);
    this.used = true;
    const h = tu.handling;
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
    if (!h.torqueTurn && this.avoid.check(self, h, tu.kind.radius, tu.shieldPad, avoidAccel, this.tac.tick, nb, debris)) {
      this.faceMove = true;
      const g = h.maxSpeed, av = this.avoid;
      this.facing = facingOf(av.x, av.y);
      this.wvx = self.vx + av.x * g;
      this.wvy = self.vy + av.y * g;
      this.boost = reserveOk;
      this.params = COMBAT_PILOT_PARAMS;
      return true;
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
      this.faceMove = false;
    } else if (goal.facing === FACE_MOVE) {
      this.faceMove = moving;
    } else {
      const along = this.tac.holdAlong;
      const sgn = along < 0 ? -1 : 1;
      let off = wrapAngle(moveAngle - facingOf(ux * sgn, uy * sgn));
      if (off < 0) off = -off;
      const thresh = this.faceMove ? FACE_MOVE_EXIT : FACE_MOVE_ENTER;
      this.faceMove = moving && !inRange && (along > 0 || off > thresh);
    }
    let facing = this.faceMove ? moveAngle : leadAngle;
    if (nudging && !this.faceMove) {
      // The gate holds the shot anyway, so a nose held on the lead may swing
      // toward the side-step (a ship flies along its nose), but no further
      // than NUDGE_MAX_OFF off the lead: it comes straight back to shoot.
      // A nose already following the move (Orbit, a running Kite, a Tail
      // circling to the six, FallBack, Flee) can already side-step: left as is.
      const off = wrapAngle(moveAngle - leadAngle);
      facing = leadAngle + (off > NUDGE_MAX_OFF ? NUDGE_MAX_OFF : off < -NUDGE_MAX_OFF ? -NUDGE_MAX_OFF : off);
    } else if (!this.faceMove) {
      this.pilot.turn.aimCone = aimCone;
    }
    // Afterburner: whenever the manoeuvre wants it, above the reserve; a
    // Break, or a ship running from a tailer (`spendReserve`), may spend the
    // reserve (the pool itself still runs dry).
    this.facing = facing;
    this.wvx = wvx;
    this.wvy = wvy;
    this.boost = goal.boost && (reserveOk || this.decide.picker.current === MANOEUVRE_BREAK || goal.spendReserve);
    this.params = goal.throttleNow ? RUN_NOW_PILOT_PARAMS : goal.spendReserve ? RUN_PILOT_PARAMS : COMBAT_PILOT_PARAMS;
    return false;
  }
}
