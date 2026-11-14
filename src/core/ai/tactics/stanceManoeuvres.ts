/**
 * Stand-off and morale manoeuvres (AI overhaul slice 6b, plan composed-harbor
 * §3): Orbit (gunships, robots), Kite (missile boats), FallBack and Flee (the
 * morale die's outcomes, owner decision 2026-11-13: "fight on / fall back to
 * friends / flee and warp out").
 *
 * Like the dogfight manoeuvres they only write interest and a goal; the brain
 * flies the result with the player's controls through the virtual pilot. A
 * ship has one nose and thrusts only along it, so "strafing" is flying a curve
 * while the turrets bear, never sideways thrust.
 *
 * Distances are the context's role band, fire range and sensor range, all
 * multiples of the ship's own fire range (#18). Plain per-instance fields, no
 * allocation (#14).
 */
import { addInterestToward, type ContextMaps } from '../contextSteering.js';
import {
  FACE_AIM_LEAD,
  FACE_AUTO,
  FACE_MOVE,
  MANOEUVRE_FALL_BACK,
  MANOEUVRE_FLEE,
  MANOEUVRE_KITE,
  MANOEUVRE_ORBIT,
  rngUnit,
  targetParked,
  type IManoeuvre,
  type ManoeuvreGoal,
  type TacticalContext,
} from './manoeuvre.js';
import { GOAL_SHAPE } from './manoeuvres.js';
import { TAILED_ASPECT_COS, TAILED_COS } from './utility.js';

const TICKS_PER_S = 60;

// ── Evasive running (shared by FallBack and Flee) ───────────────────────
/** "Pursued": the target sits in my rear cone (as for Break's "tailed") and
 *  within this × fire range. Wider than Break's 1.1: a runner starts weaving
 *  before the pursuer is in its best range, not once it is. */
export const EVADE_PURSUED_RANGE = 1.5;
/** A weave leg turns the course this far off the escape line (rad, seeded
 *  per leg: ~26°–40°). cos(40°) ≈ 0.77, so the run still gains ground. */
export const EVADE_JINK_MIN = 0.45;
export const EVADE_JINK_MAX = 0.7;
/** A weave leg lasts a seeded 0.4–0.9 s (irregular, so a pursuer can't time
 *  its lead to the rhythm). */
const EVADE_LEG_MIN_TICKS = 30;
const EVADE_LEG_MAX_TICKS = 54;
/** While pursued the weave is laid about a SLOW copy of the escape line
 *  (share of the gap closed per tick, ~1.5 s time constant). With the pursuer
 *  dead astern, "away from it" is roughly my own heading, so a weave about the
 *  live line chases itself round to one side. */
const EVADE_BASE_GAIN = 1 / 90;
/** Hit from behind this hard (decaying recent-hit count) ⇒ a brief break. */
export const EVADE_BREAK_HITS = 2;
/** The break: this far off the escape line (rad, ~80°: across the
 *  pursuer's line of fire) for a seeded 0.5–0.8 s, then back to running. */
export const EVADE_BREAK_ANGLE = 1.4;
const EVADE_BREAK_MIN_TICKS = 30;
const EVADE_BREAK_MAX_TICKS = 48;
/** No new break within this long of the last one's start (2 s). */
const EVADE_BREAK_COOLDOWN_TICKS = 120;

/** Is the target on my tail (rear cone, within reach, not flying away from
 *  me, not parked)? Same shape as `isTailed` (utility.ts), wider reach. */
export function isPursued(ctx: TacticalContext): boolean {
  return ctx.targetIsShip && ctx.threatBearingCos < TAILED_COS
    && ctx.dist < EVADE_PURSUED_RANGE * ctx.fireRange
    && ctx.targetAspectCos > TAILED_ASPECT_COS && !targetParked(ctx);
}

function randRange(ctx: TacticalContext, lo: number, hi: number): number {
  return lo + (hi - lo) * rngUnit(ctx);
}

/**
 * A ship running from a pursuer still evades (hostile review of the 3v3
 * dogfight clip, 2026-11-14: a fleeing fighter flew dead straight for ~4 s
 * with a hostile on its tail until it blew up). While pursued it weaves:
 * alternating legs a seeded 26°–40° either side of its escape line, each a
 * seeded 0.4–0.9 s; hit hard from behind, it breaks ~80° off the line for
 * a moment (cooldown 2 s) and then resumes the weave. Not pursued, it flies
 * the escape line straight. Plain fields, no allocation (#14); draws only
 * from the ship's seeded stream.
 */
export class EvasiveRun {
  /** +1 = this leg turns left of the escape line. */
  side = 1;
  /** Current offset off the escape line (rad, signed), test-visible. */
  offset = 0;
  /** Running from a pursuer this tick (test-visible). */
  pursued = false;
  /** In a break (test-visible). */
  breaking = false;
  private legEnd = -1;
  private breakEnd = -1;
  private nextBreak = -1;
  private angle = 0;
  private hasBase = false;
  private baseX = 0;
  private baseY = 1;
  /** Course out (unit), filled by {@link steer}. */
  outX = 0;
  outY = 1;
  /** Start a run; the first leg's side is seeded (left without a context). */
  reset(ctx?: TacticalContext): void {
    this.side = ctx === undefined || rngUnit(ctx) < 0.5 ? 1 : -1;
    this.legEnd = -1;
    this.breakEnd = -1;
    this.nextBreak = -1;
    this.offset = 0;
    this.pursued = false;
    this.breaking = false;
    this.hasBase = false;
  }
  /** Turn the escape line (`ex`, `ey`, unit) into this tick's course
   *  (`outX`, `outY`). Returns whether the ship is pursued. */
  steer(ctx: TacticalContext, ex: number, ey: number): boolean {
    const t = ctx.tick;
    this.pursued = isPursued(ctx);
    if (!this.pursued) {
      this.offset = 0;
      this.breaking = false;
      this.hasBase = false;
      this.outX = ex; this.outY = ey;
      return false;
    }
    if (!this.hasBase) {
      this.hasBase = true;
      this.baseX = ex; this.baseY = ey;
    } else {
      let bx = this.baseX + EVADE_BASE_GAIN * (ex - this.baseX);
      let by = this.baseY + EVADE_BASE_GAIN * (ey - this.baseY);
      const bl = Math.hypot(bx, by);
      if (bl > 1e-6) { bx /= bl; by /= bl; this.baseX = bx; this.baseY = by; }
    }
    if (this.breaking && t >= this.breakEnd) {
      this.breaking = false;
      this.legEnd = -1; // a fresh weave leg straight away
    }
    if (!this.breaking && ctx.recentHits >= EVADE_BREAK_HITS && t >= this.nextBreak) {
      // Break across the pursuer's line, to the side the last leg leaned.
      this.breaking = true;
      this.breakEnd = t + Math.round(randRange(ctx, EVADE_BREAK_MIN_TICKS, EVADE_BREAK_MAX_TICKS));
      this.nextBreak = t + EVADE_BREAK_COOLDOWN_TICKS;
    }
    if (this.breaking) {
      this.offset = EVADE_BREAK_ANGLE * this.side;
    } else {
      if (t >= this.legEnd) {
        this.side = -this.side;
        this.angle = randRange(ctx, EVADE_JINK_MIN, EVADE_JINK_MAX);
        this.legEnd = t + Math.round(randRange(ctx, EVADE_LEG_MIN_TICKS, EVADE_LEG_MAX_TICKS));
      }
      this.offset = this.angle * this.side;
    }
    // Rotate the (slow) escape line by `offset` (positive turns left).
    const c = Math.cos(this.offset);
    const s = Math.sin(this.offset);
    this.outX = this.baseX * c - this.baseY * s;
    this.outY = this.baseX * s + this.baseY * c;
    return true;
  }
}

// ── Orbit ───────────────────────────────────────────────────────────────
/** The orbit's largest angle off the target bearing (rad): pure tangent. */
const ORBIT_MAX_TANGENT = Math.PI / 2;
/** Share of the turret half-arc the orbit may turn the nose off the target,
 *  so the target stays inside the arc with a margin. */
const ORBIT_ARC_USE = 0.85;
/** Radial correction: angle added per unit of (R − d) / R (rad). Inside the
 *  circle the heading opens out, outside it closes in. */
const ORBIT_RADIAL_GAIN = 2;
/** Largest heading off the target bearing (rad, 135°): opening out. */
const ORBIT_MAX_OFF = (3 * Math.PI) / 4;
/** Boost back toward the circle while farther than this × fire range. */
const ORBIT_BOOST_RANGE = 1.5;

/** The heading angle (off the bearing to the target) Orbit flies for a ship
 *  at distance `d` from a circle of radius `r`, with turrets that swing
 *  `turretHalfArc` either side of the bow. Exported for the geometry tests. */
export function orbitOffAngle(d: number, r: number, turretHalfArc: number): number {
  let base = turretHalfArc * ORBIT_ARC_USE;
  if (base > ORBIT_MAX_TANGENT) base = ORBIT_MAX_TANGENT;
  let off = base + (ORBIT_RADIAL_GAIN * (r - d)) / (r > 1 ? r : 1);
  if (off < 0) off = 0;
  else if (off > ORBIT_MAX_OFF) off = ORBIT_MAX_OFF;
  return off;
}

/**
 * Circle the target at the role band's outer edge (`bandMax`). The heading is
 * the target bearing turned toward the tangent by as much as the turrets
 * allow (`turretHalfArc`), plus a radial term that opens the circle when too
 * close and closes it when too far. The nose follows the heading, so a
 * turreted hull flies a curve with its guns bearing; a fixed-gun ship gets a
 * shallow angle (it mostly holds its nose on the target). The direction
 * round is the side the ship is already sliding to, else a seeded side.
 */
export class OrbitManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_ORBIT;
  /** +1 = counter-clockwise (heading turned left of the bearing). */
  side = 1;
  /** Last goal's heading (unit), test-visible. */
  dirX = 0;
  dirY = 1;
  begin(ctx: TacticalContext): void {
    const lat = -ctx.uy * (ctx.vx - ctx.tvx) + ctx.ux * (ctx.vy - ctx.tvy);
    if (lat > 0.1 * ctx.cruiseSpeed) this.side = 1;
    else if (lat < -0.1 * ctx.cruiseSpeed) this.side = -1;
    else this.side = rngUnit(ctx) < 0.5 ? 1 : -1;
  }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    const off = orbitOffAngle(ctx.dist, ctx.bandMax, ctx.turretHalfArc) * this.side;
    // Rotate the bearing u by `off` (a positive angle turns left: ship angles
    // run counter-clockwise).
    const c = Math.cos(off);
    const s = Math.sin(off);
    this.dirX = ctx.ux * c - ctx.uy * s;
    this.dirY = ctx.ux * s + ctx.uy * c;
    addInterestToward(maps, this.dirX, this.dirY, 1, GOAL_SHAPE);
    out.speed = ctx.cruiseSpeed;
    out.facing = FACE_MOVE;
    out.boost = ctx.dist > ORBIT_BOOST_RANGE * ctx.fireRange;
  }
  isDone(): boolean { return false; }
}

// ── Kite ────────────────────────────────────────────────────────────────
/** Deep inside the band (below this × bandMin) the kite turns and runs
 *  (nose along the move, boost) instead of backing off nose on: a fighter
 *  closing faster than a frigate can reverse would otherwise sit on it. */
const KITE_RUN_FRAC = 0.7;
/** Stop running once back out past this × bandMin. */
const KITE_RUN_EXIT = 1;

/**
 * Hold the role band (missile boats; replaces the impulse era's
 * `backoffInsideFactor` path in the decision layer). The wanted speed along
 * the target line is the target's own along it plus a correction toward the
 * band's middle (± cruise at the band's edges), so a closing target is met by
 * reversing with the nose (and the launchers) still on it. Caught deep inside
 * the band, it turns and runs with boost until it is back at the band, then
 * turns to face again.
 */
export class KiteManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_KITE;
  /** Running away (nose along the move) rather than backing off. */
  running = false;
  /** Last wanted speed along the target line (+ closing), test-visible. */
  along = 0;
  begin(): void { this.running = false; }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    const mid = 0.5 * (ctx.bandMin + ctx.bandMax);
    const half = Math.max(1, 0.5 * (ctx.bandMax - ctx.bandMin));
    let k = (ctx.dist - mid) / half;
    if (k > 1) k = 1;
    else if (k < -1) k = -1;
    const tAlong = ctx.tvx * ctx.ux + ctx.tvy * ctx.uy;
    let along = tAlong + k * ctx.cruiseSpeed;
    if (along > ctx.maxSpeed) along = ctx.maxSpeed;
    else if (along < -ctx.maxSpeed) along = -ctx.maxSpeed;
    if (this.running) {
      if (ctx.dist > KITE_RUN_EXIT * ctx.bandMin) this.running = false;
    } else if (ctx.targetIsShip && ctx.dist < KITE_RUN_FRAC * ctx.bandMin && ctx.closing > 0) {
      this.running = true;
    }
    if (this.running) along = -ctx.maxSpeed;
    this.along = along;
    const sgn = along < 0 ? -1 : 1;
    addInterestToward(maps, ctx.ux * sgn, ctx.uy * sgn, 1, GOAL_SHAPE);
    out.speed = along < 0 ? -along : along;
    out.facing = this.running ? FACE_MOVE : FACE_AIM_LEAD;
    out.boost = this.running || ctx.dist > ctx.bandMax * 1.5;
  }
  isDone(): boolean { return false; }
}

// ── Fall back ───────────────────────────────────────────────────────────
/** Arrived at the anchor within this × fire range: hold there and fight. */
export const FALLBACK_ARRIVE = 1;
/** Boost toward the anchor while farther than this × the arrive radius. */
const FALLBACK_BOOST = 1.5;

/**
 * Head for friends: the nearest friendly capital, else the centroid of the
 * same-side ships within sensor range (the brain refreshes `anchor*` at
 * decision time). On the way the nose follows the course; once within
 * `FALLBACK_ARRIVE` × fire range of the anchor it settles there (arrive ramp)
 * and fights from among its friends (nose on the lead in range). With no
 * friend in sensors it opens the range from the threat instead. On the way
 * (or opening the range) with a pursuer on its tail it runs evasively
 * ({@link EvasiveRun}: weave, break when hit, full speed, boost from the
 * reserve). Ends when the morale lock runs out (the brain's call), never by
 * itself.
 */
export class FallBackManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_FALL_BACK;
  /** At the anchor (test-visible). */
  arrived = false;
  /** The evasive run on the way (test-visible). */
  readonly evade = new EvasiveRun();
  begin(ctx?: TacticalContext): void {
    this.arrived = false;
    this.evade.reset(ctx);
  }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    if (!ctx.hasAnchor) {
      // Nobody to fall back on: open the range from the threat at cruise
      // (full speed, weaving, when pursued).
      let ax = ctx.x - ctx.threatX;
      let ay = ctx.y - ctx.threatY;
      if (ctx.sensorEnemies === 0 || ax * ax + ay * ay < 1e-6) { ax = -ctx.ux; ay = -ctx.uy; }
      const l = Math.hypot(ax, ay);
      const ex = l > 1e-6 ? ax / l : 0;
      const ey = l > 1e-6 ? ay / l : 1;
      const pursued = this.evade.steer(ctx, ex, ey);
      addInterestToward(maps, this.evade.outX, this.evade.outY, 1, GOAL_SHAPE);
      out.speed = pursued ? ctx.maxSpeed : ctx.cruiseSpeed;
      out.facing = FACE_MOVE;
      out.boost = pursued;
      out.spendReserve = pursued;
      this.arrived = false;
      return;
    }
    const dx = ctx.anchorX - ctx.x;
    const dy = ctx.anchorY - ctx.y;
    const d = Math.hypot(dx, dy);
    const arrive = FALLBACK_ARRIVE * ctx.fireRange;
    this.arrived = d <= arrive;
    let ex = -ctx.ux;
    let ey = -ctx.uy;
    if (d > 1e-6) { ex = dx / d; ey = dy / d; }
    // Settled among friends it fights; on the way it runs from a pursuer.
    const pursued = !this.arrived && this.evade.steer(ctx, ex, ey);
    if (pursued) addInterestToward(maps, this.evade.outX, this.evade.outY, 1, GOAL_SHAPE);
    else addInterestToward(maps, ex, ey, 1, GOAL_SHAPE);
    let speed = pursued ? ctx.maxSpeed : ctx.cruiseSpeed * (d / arrive);
    if (speed > ctx.maxSpeed) speed = ctx.maxSpeed;
    out.speed = speed;
    out.facing = this.arrived ? FACE_AUTO : FACE_MOVE;
    out.boost = pursued || d > FALLBACK_BOOST * arrive;
    out.spendReserve = pursued;
  }
  isDone(): boolean { return false; }
}

// ── Flee ────────────────────────────────────────────────────────────────
/** Clear of enemies within sensor range this long ⇒ warp out (2 s). */
export const FLEE_CLEAR_TICKS = 2 * TICKS_PER_S;
/** Still not clear after this long ⇒ warp out anyway (a fighter can't outrun
 *  a faster pursuer; the spool is then the risk it takes). */
export const FLEE_MAX_TICKS = 6 * TICKS_PER_S;

/**
 * Run: away from the threat-weighted centroid of the enemies in sensor range,
 * full speed with boost, nose along the move. With a pursuer on its tail it
 * runs evasively ({@link EvasiveRun}): it weaves off the escape line, breaks
 * briefly when hit from behind, and may burn the boost reserve; the escape
 * line itself (`dirX`, `dirY`, the warp-out direction) stays straight away.
 * Once no enemy has been within sensor range for `FLEE_CLEAR_TICKS` (or after
 * `FLEE_MAX_TICKS` regardless), {@link wantsWarpOut} turns true and the brain
 * asks the server to warp it out along its escape heading. Never done by
 * itself: a ship that chose to flee keeps fleeing.
 */
export class FleeManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_FLEE;
  private start = 0;
  private clearSince = -1;
  /** Escape heading (unit), test-visible and the warp-out direction. */
  dirX = 0;
  dirY = 1;
  /** The evasive run (test-visible). */
  readonly evade = new EvasiveRun();
  begin(ctx: TacticalContext): void {
    this.start = ctx.tick;
    this.clearSince = -1;
    this.evade.reset(ctx);
  }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    let ax = ctx.x - ctx.threatX;
    let ay = ctx.y - ctx.threatY;
    if (ctx.sensorEnemies === 0 || ax * ax + ay * ay < 1e-6) { ax = -ctx.ux; ay = -ctx.uy; }
    const l = Math.hypot(ax, ay);
    if (l > 1e-6) { this.dirX = ax / l; this.dirY = ay / l; }
    const pursued = this.evade.steer(ctx, this.dirX, this.dirY);
    addInterestToward(maps, this.evade.outX, this.evade.outY, 1, GOAL_SHAPE);
    if (ctx.sensorEnemies === 0) {
      if (this.clearSince < 0) this.clearSince = ctx.tick;
    } else {
      this.clearSince = -1;
    }
    out.speed = ctx.maxSpeed;
    out.facing = FACE_MOVE;
    out.boost = true;
    out.spendReserve = pursued;
  }
  isDone(): boolean { return false; }
  /** Clear for long enough, or fled for long enough: time to jump. */
  wantsWarpOut(tick: number): boolean {
    return (this.clearSince >= 0 && tick - this.clearSince >= FLEE_CLEAR_TICKS) || tick - this.start >= FLEE_MAX_TICKS;
  }
}
