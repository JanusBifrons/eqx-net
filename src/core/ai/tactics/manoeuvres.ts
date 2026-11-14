/**
 * The dogfight manoeuvres (AI overhaul slice 4, plan composed-harbor §3):
 * Hold (today's stand-off), Tail, AttackRun (boom-and-zoom) and Break. Each
 * writes interest toward the velocity it wants and fills the goal; none of
 * them pushes the ship: the brain flies the result through the virtual pilot
 * with the player's controls (owner rule 2026-11-13).
 *
 * Ranges are multiples of the ship's fire range or `shipTuning` values carried
 * on the context (#18). Per-instance plain fields, no allocation (#14).
 */
import { addInterestToward, type ContextMaps } from '../contextSteering.js';
import {
  FACE_AIM_LEAD,
  FACE_AUTO,
  FACE_MOVE,
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_HOLD,
  MANOEUVRE_TAIL,
  rngUnit,
  targetAimsAtMe,
  targetParked,
  type IManoeuvre,
  type ManoeuvreGoal,
  type TacticalContext,
} from './manoeuvre.js';

/** Interest lobe sharpness toward a manoeuvre's wanted heading. */
export const GOAL_SHAPE = 2;
/** Nose on the lead only while it is within this of the bow (rad, 60°). */
const AIM_CONE = Math.PI / 3;
const TICKS_PER_S = 60;

// ── Hold ────────────────────────────────────────────────────────────────
/** Today's stand-off (pre-slice-4 behaviour): close to the weapon's stop
 *  distance along the target line, hold there, missile boats back off. What
 *  gunships and missile boats keep flying until Orbit / Kite land. */
export class HoldManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_HOLD;
  begin(): void { /* stateless */ }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    const along = ctx.holdAlong;
    const sgn = along < 0 ? -1 : 1;
    addInterestToward(maps, ctx.ux * sgn, ctx.uy * sgn, 1, GOAL_SHAPE);
    out.speed = along < 0 ? -along : along;
    out.facing = FACE_AUTO;
    out.boost = ctx.holdBoost;
  }
  isDone(): boolean { return false; }
}

// ── Tail ────────────────────────────────────────────────────────────────
/** Station behind the target's velocity, as a share of fire range. */
export const TAIL_BEHIND = 0.6;
/** Pursuit lead on the station point is capped at this (s). */
const TAIL_LEAD_MAX_S = 2;
/** Inside this share of fire range from the station the closing speed ramps down. */
const TAIL_ARRIVE = 0.5;
/** Boost while farther than this × fire range. */
const TAIL_BOOST_RANGE = 1.5;
/** Least speed while off the station, × cruise (a tail never hovers). */
const TAIL_MIN_SPEED = 0.8;
/** Parked target looking elsewhere: closer than this share of the circle
 *  distance (`TAIL_BEHIND` × fire range) the ship flies the circle course
 *  outward first, and puts its nose on the target only once back past the
 *  EXIT share (hysteresis), as a pilot opens out after a collision. */
export const TAIL_EXTEND_ENTER = 0.6;
export const TAIL_EXTEND_EXIT = 0.9;
/** In fire range the nose stays on the lead while the wanted course is
 *  within this cos of the target line (60°). */
const TAIL_AIM_COS = Math.cos(AIM_CONE);
/**
 * Pursuit intercept to a point `TAIL_BEHIND × fireRange` behind the target's
 * velocity (its six), led by the time to get there; the wanted velocity is the
 * target's own plus a closing speed that eases off near the station, so the
 * ship settles on the tail instead of overrunning it. A slow target (or a
 * structure) has no six: the station is on our side of it. Nose on the lead
 * in fire range while the course runs within 60° of it (on or near the six),
 * else along the move: a ship thrusts only along its nose, so a nose held on
 * the target cannot fly round to its six (2026-11-13).
 */
export class TailManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_TAIL;
  /** Last goal's wanted velocity (test-visible). */
  wantVx = 0;
  wantVy = 0;
  /** Opening out from a parked target before turning the guns on it. */
  extending = false;
  begin(): void { this.extending = false; }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    const R = ctx.fireRange;
    if (ctx.targetIsShip && targetParked(ctx)) {
      this.circle(ctx, maps, out);
      return;
    }
    const tSpeed = Math.hypot(ctx.tvx, ctx.tvy);
    let bx: number;
    let by: number;
    if (ctx.targetIsShip) {
      bx = -ctx.tvx / tSpeed;
      by = -ctx.tvy / tSpeed;
    } else {
      bx = -ctx.ux;
      by = -ctx.uy;
    }
    let px = ctx.tx + bx * TAIL_BEHIND * R;
    let py = ctx.ty + by * TAIL_BEHIND * R;
    const d0 = Math.hypot(px - ctx.x, py - ctx.y);
    const lead = Math.min(TAIL_LEAD_MAX_S, d0 / Math.max(ctx.cruiseSpeed, 1));
    px += ctx.tvx * lead;
    py += ctx.tvy * lead;
    const dx = px - ctx.x;
    const dy = py - ctx.y;
    const d = Math.hypot(dx, dy);
    const approach = ctx.maxSpeed * Math.min(1, d / (TAIL_ARRIVE * R));
    let wvx = ctx.tvx;
    let wvy = ctx.tvy;
    if (d > 1e-6) {
      wvx += (dx / d) * approach;
      wvy += (dy / d) * approach;
    }
    let speed = Math.hypot(wvx, wvy);
    // Never hover on the tail: below a fighting speed, circle the target
    // instead (tangent to the target line, on the side we are already
    // drifting), so a slow target gets a turning fight, not a stand-off.
    const floor = TAIL_MIN_SPEED * ctx.cruiseSpeed;
    if (speed < floor) {
      const side = -ctx.uy * ctx.vx + ctx.ux * ctx.vy >= 0 ? 1 : -1;
      wvx += -ctx.uy * side * floor;
      wvy += ctx.ux * side * floor;
      const s2 = Math.hypot(wvx, wvy);
      if (s2 > 1e-6) { wvx *= floor / s2; wvy *= floor / s2; }
      speed = floor;
    }
    if (speed > ctx.maxSpeed) {
      wvx *= ctx.maxSpeed / speed;
      wvy *= ctx.maxSpeed / speed;
      speed = ctx.maxSpeed;
    }
    this.wantVx = wvx;
    this.wantVy = wvy;
    if (speed > 1e-6) addInterestToward(maps, wvx, wvy, 1, GOAL_SHAPE);
    else addInterestToward(maps, ctx.ux, ctx.uy, 1, GOAL_SHAPE);
    out.speed = speed;
    // In fire range the nose stays on the lead (it keeps shooting; thrust and
    // reverse along it still close the station): a fighter facing away in
    // range halves its fire (fleet-fight perf scene, 2026-11-13). Out of
    // range it flies the course.
    // A ship only thrusts along its nose, so the nose can stay on the lead
    // only while the course runs within AIM_CONE of it (on or near the six).
    // Off it (head-on, crossing, a parked target being circled), it flies the
    // course round to the six and the nose comes back on as it gets there.
    out.facing = ctx.dist <= R && speed > 1e-6
      && (wvx * ctx.ux + wvy * ctx.uy) / speed > TAIL_AIM_COS ? FACE_AIM_LEAD : FACE_MOVE;
    // Afterburner to catch up: far off, or the target is pulling away and
    // we are short of the station.
    out.boost = ctx.dist > TAIL_BOOST_RANGE * R || (ctx.closing < 0 && d > TAIL_ARRIVE * R);
  }
  isDone(): boolean { return false; }

  /**
   * A parked ship (`targetParked`) has no six: circle it at `TAIL_BEHIND ×
   * fireRange` at the floor speed, round the side the nose already points to,
   * steering in or out by the range error. Sending the ship to a station
   * straight back out on its own side (the old rule) made a close pair turn in
   * place nose to nose, stopped, for seconds (toe to toe; on-sight integration
   * 2026-11-13). Facing in fire range (owner decision 2026-11-14):
   *  - the target's bow is OFF me (`targetAimsAtMe` false): nose on the lead
   *    and shoot. A parked ship looking elsewhere is the easiest shot there
   *    is; a nose flying the circle never fired at it (npcFireLanes: fighters
   *    on a parked pilot circled it nose-out). Thrust and reverse along the
   *    nose hold the range; the circle's tangent is only carried momentum.
   *    Well inside the circle distance (`TAIL_EXTEND_ENTER`) it first flies
   *    the circle course outward: turning in place to aim at a ship it just
   *    collided with left both stopped nose-off for seconds (dogfight 1v1
   *    toe to toe on 5 / 18 runs, 2026-11-14).
   *  - its bow is ON me: keep circling (nose on the lead only while the course
   *    runs within 60° of it), so two stopped ships facing each other never
   *    settle into a nose-to-nose stand-off (dogfight 1v1: no Break, one pass).
   */
  private circle(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    const R = ctx.fireRange;
    const side = ctx.ux * ctx.fwdY - ctx.uy * ctx.fwdX >= 0 ? 1 : -1;
    let e = (ctx.dist - TAIL_BEHIND * R) / (TAIL_ARRIVE * R);
    e = e < -1 ? -1 : e > 1 ? 1 : e;
    let dx = -ctx.uy * side + ctx.ux * e;
    let dy = ctx.ux * side + ctx.uy * e;
    const l = Math.hypot(dx, dy);
    dx /= l; dy /= l;
    const speed = TAIL_MIN_SPEED * ctx.cruiseSpeed;
    this.wantVx = ctx.tvx + dx * speed;
    this.wantVy = ctx.tvy + dy * speed;
    addInterestToward(maps, this.wantVx, this.wantVy, 1, GOAL_SHAPE);
    out.speed = Math.hypot(this.wantVx, this.wantVy);
    const ring = TAIL_BEHIND * R;
    if (this.extending) {
      if (ctx.dist > TAIL_EXTEND_EXIT * ring) this.extending = false;
    } else if (ctx.dist < TAIL_EXTEND_ENTER * ring) {
      this.extending = true;
    }
    if (ctx.dist > R) out.facing = FACE_MOVE;
    else if (!targetAimsAtMe(ctx)) out.facing = this.extending ? FACE_MOVE : FACE_AIM_LEAD;
    else {
      out.facing = (this.wantVx * ctx.ux + this.wantVy * ctx.uy) / out.speed > TAIL_AIM_COS
        ? FACE_AIM_LEAD : FACE_MOVE;
    }
    out.boost = false;
  }
}

// ── Attack run ──────────────────────────────────────────────────────────
const RUN_DIVE = 0;
const RUN_PASS = 1;
const RUN_EXTEND = 2;
const RUN_DONE = 3;
/** The dive aims this share of the overshoot to one side of the lead point. */
const RUN_MISS_FRAC = 0.5;
/** Lateral relative speed (× cruise) that picks the miss side by itself. */
const RUN_LATERAL_EPS = 0.1;
/** Miss side with no lateral motion: −1 = to the right of the target line,
 *  for everyone, so a head-on pair passes apart. */
const RUN_DEFAULT_SIDE = -1;
/** Give up a dive that has not reached the target in this long (s). */
const RUN_DIVE_MAX_S = 5;
/** A pass that never gets the overshoot clear ends after this long (s). */
const RUN_PASS_MAX_S = 2;
/** Seeded extend time range (s); the extend ends early once the gap is
 *  `RUN_EXTEND_RANGE` × fire range (room to turn and come back). */
const RUN_EXTEND_MIN_S = 1.5;
const RUN_EXTEND_MAX_S = 3;
const RUN_EXTEND_RANGE = 1.3;

/**
 * Boom-and-zoom: dive at full speed (boosting) at the lead, guns on it;
 * inside the overshoot (or once the gap opens again) pull off for a point
 * half an overshoot beside the target (the side the ship is already sliding
 * to, else a fixed side: a ship flies along its nose, so aiming AT the
 * target to the end is a ram) and hold that heading until the ship is
 * `overshoot` beyond the target, then extend away
 * along it with boost for a seeded 1.5–3 s (or until the gap is 1.3 × fire
 * range). Done after the extend: the picker chooses again, usually another
 * run from the distance the extend opened.
 */
export class AttackRunManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_ATTACK_RUN;
  phase = RUN_DIVE;
  private side = 1;
  private passX = 0;
  private passY = 1;
  private phaseEnd = 0;
  /** Diving at the target, guns on it (the fire-lane nudge may side-step it). */
  get diving(): boolean { return this.phase === RUN_DIVE; }

  begin(ctx: TacticalContext): void {
    this.phase = RUN_DIVE;
    // Pass on the side we are already sliding toward; with no lateral motion,
    // a fixed rule (everyone passes the same way round), so two ships diving
    // at each other offset apart instead of into each other.
    const lat = -ctx.uy * (ctx.vx - ctx.tvx) + ctx.ux * (ctx.vy - ctx.tvy);
    this.side = lat > RUN_LATERAL_EPS * ctx.cruiseSpeed ? 1 : lat < -RUN_LATERAL_EPS * ctx.cruiseSpeed ? -1 : RUN_DEFAULT_SIDE;
    this.phaseEnd = ctx.tick + RUN_DIVE_MAX_S * TICKS_PER_S;
  }

  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    this.advance(ctx);
    if (this.phase === RUN_DIVE) {
      const miss = ctx.overshoot * RUN_MISS_FRAC * this.side;
      // Perpendicular to the target line (left-hand normal).
      const gx = ctx.aimX - ctx.uy * miss - ctx.x;
      const gy = ctx.aimY + ctx.ux * miss - ctx.y;
      addInterestToward(maps, gx, gy, 1, GOAL_SHAPE);
      out.speed = ctx.maxSpeed;
      out.facing = ctx.offBoresight < AIM_CONE ? FACE_AIM_LEAD : FACE_MOVE;
      out.boost = true;
      return;
    }
    addInterestToward(maps, this.passX, this.passY, 1, GOAL_SHAPE);
    out.speed = ctx.maxSpeed;
    out.facing = FACE_MOVE;
    // Zoom through the pass and away on the extend.
    out.boost = true;
  }

  isDone(ctx: TacticalContext): boolean {
    this.advance(ctx);
    return this.phase === RUN_DONE;
  }

  /** Phase transitions (idempotent within a tick). */
  private advance(ctx: TacticalContext): void {
    if (this.phase === RUN_DIVE) {
      if (ctx.tick >= this.phaseEnd) { this.phase = RUN_DONE; return; }
      if (ctx.dist < ctx.overshoot || (ctx.closing < 0 && ctx.dist < 0.5 * ctx.fireRange)) {
        // Lock the pass heading: toward the miss point beside the target.
        const miss = ctx.overshoot * RUN_MISS_FRAC * this.side;
        const gx = ctx.tx - ctx.uy * miss - ctx.x;
        const gy = ctx.ty + ctx.ux * miss - ctx.y;
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-6) { this.passX = gx / gl; this.passY = gy / gl; }
        else { this.passX = ctx.ux; this.passY = ctx.uy; }
        this.phase = RUN_PASS;
        this.phaseEnd = ctx.tick + RUN_PASS_MAX_S * TICKS_PER_S;
      }
      return;
    }
    if (this.phase === RUN_PASS) {
      const beyond = (ctx.x - ctx.tx) * this.passX + (ctx.y - ctx.ty) * this.passY;
      if (beyond > ctx.overshoot || ctx.tick >= this.phaseEnd) {
        this.phase = RUN_EXTEND;
        const s = RUN_EXTEND_MIN_S + (RUN_EXTEND_MAX_S - RUN_EXTEND_MIN_S) * rngUnit(ctx);
        this.phaseEnd = ctx.tick + Math.round(s * TICKS_PER_S);
      }
      return;
    }
    if (this.phase === RUN_EXTEND && (ctx.tick >= this.phaseEnd || ctx.dist > RUN_EXTEND_RANGE * ctx.fireRange)) {
      this.phase = RUN_DONE;
    }
  }
}

// ── Break ───────────────────────────────────────────────────────────────
/** Seeded break time range (s). */
const BREAK_MIN_S = 0.6;
const BREAK_MAX_S = 1.5;

/**
 * Defensive break: a hard turn onto the perpendicular of the threat line (the
 * side nearer the current heading, so the turn is as short as it can be) at
 * full speed with boost, for a seeded 0.6–1.5 s. The perpendicular follows the
 * live threat line, on the side chosen at the start.
 */
export class BreakManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_BREAK;
  private side = 1;
  private until = 0;
  begin(ctx: TacticalContext): void {
    // Left-hand normal of the threat line is (-uy, ux).
    const hx = Math.hypot(ctx.vx, ctx.vy) > 0.25 * ctx.cruiseSpeed ? ctx.vx : ctx.fwdX;
    const hy = Math.hypot(ctx.vx, ctx.vy) > 0.25 * ctx.cruiseSpeed ? ctx.vy : ctx.fwdY;
    this.side = -ctx.uy * hx + ctx.ux * hy >= 0 ? 1 : -1;
    const s = BREAK_MIN_S + (BREAK_MAX_S - BREAK_MIN_S) * rngUnit(ctx);
    this.until = ctx.tick + Math.round(s * TICKS_PER_S);
  }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    addInterestToward(maps, -ctx.uy * this.side, ctx.ux * this.side, 1, GOAL_SHAPE);
    out.speed = ctx.maxSpeed;
    out.facing = FACE_MOVE;
    out.boost = true;
  }
  isDone(ctx: TacticalContext): boolean { return ctx.tick >= this.until; }
}
