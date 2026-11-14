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
  type IManoeuvre,
  type ManoeuvreGoal,
  type TacticalContext,
} from './manoeuvre.js';
import { GOAL_SHAPE } from './manoeuvres.js';

const TICKS_PER_S = 60;

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
 * friend in sensors it opens the range from the threat instead. Ends when the
 * morale lock runs out (the brain's call), never by itself.
 */
export class FallBackManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_FALL_BACK;
  /** At the anchor (test-visible). */
  arrived = false;
  begin(): void { this.arrived = false; }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    if (!ctx.hasAnchor) {
      // Nobody to fall back on: open the range from the threat at cruise.
      awayFromThreat(ctx, maps);
      out.speed = ctx.cruiseSpeed;
      out.facing = FACE_MOVE;
      out.boost = false;
      this.arrived = false;
      return;
    }
    const dx = ctx.anchorX - ctx.x;
    const dy = ctx.anchorY - ctx.y;
    const d = Math.hypot(dx, dy);
    const arrive = FALLBACK_ARRIVE * ctx.fireRange;
    this.arrived = d <= arrive;
    if (d > 1e-6) addInterestToward(maps, dx, dy, 1, GOAL_SHAPE);
    else addInterestToward(maps, -ctx.ux, -ctx.uy, 1, GOAL_SHAPE);
    let speed = ctx.cruiseSpeed * (d / arrive);
    if (speed > ctx.maxSpeed) speed = ctx.maxSpeed;
    out.speed = speed;
    out.facing = this.arrived ? FACE_AUTO : FACE_MOVE;
    out.boost = d > FALLBACK_BOOST * arrive;
  }
  isDone(): boolean { return false; }
}

// ── Flee ────────────────────────────────────────────────────────────────
/** Clear of enemies within sensor range this long ⇒ warp out (2 s). */
export const FLEE_CLEAR_TICKS = 2 * TICKS_PER_S;
/** Still not clear after this long ⇒ warp out anyway (a fighter can't outrun
 *  a faster pursuer; the spool is then the risk it takes). */
export const FLEE_MAX_TICKS = 6 * TICKS_PER_S;

/** Interest straight away from the threat centroid (or the target line). */
function awayFromThreat(ctx: TacticalContext, maps: ContextMaps): void {
  let ax = ctx.x - ctx.threatX;
  let ay = ctx.y - ctx.threatY;
  if (ctx.sensorEnemies === 0 || ax * ax + ay * ay < 1e-6) { ax = -ctx.ux; ay = -ctx.uy; }
  addInterestToward(maps, ax, ay, 1, GOAL_SHAPE);
}

/**
 * Run: straight away from the threat-weighted centroid of the enemies in
 * sensor range, full speed with boost, nose along the move. Once no enemy has
 * been within sensor range for `FLEE_CLEAR_TICKS` (or after `FLEE_MAX_TICKS`
 * regardless), {@link wantsWarpOut} turns true and the brain asks the server
 * to warp it out along its escape heading. Never done by itself: a ship that
 * chose to flee keeps fleeing.
 */
export class FleeManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_FLEE;
  private start = 0;
  private clearSince = -1;
  /** Escape heading (unit), test-visible and the warp-out direction. */
  dirX = 0;
  dirY = 1;
  begin(ctx: TacticalContext): void {
    this.start = ctx.tick;
    this.clearSince = -1;
  }
  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    let ax = ctx.x - ctx.threatX;
    let ay = ctx.y - ctx.threatY;
    if (ctx.sensorEnemies === 0 || ax * ax + ay * ay < 1e-6) { ax = -ctx.ux; ay = -ctx.uy; }
    const l = Math.hypot(ax, ay);
    if (l > 1e-6) { this.dirX = ax / l; this.dirY = ay / l; }
    addInterestToward(maps, this.dirX, this.dirY, 1, GOAL_SHAPE);
    if (ctx.sensorEnemies === 0) {
      if (this.clearSince < 0) this.clearSince = ctx.tick;
    } else {
      this.clearSince = -1;
    }
    out.speed = ctx.maxSpeed;
    out.facing = FACE_MOVE;
    out.boost = true;
  }
  isDone(): boolean { return false; }
  /** Clear for long enough, or fled for long enough: time to jump. */
  wantsWarpOut(tick: number): boolean {
    return (this.clearSince >= 0 && tick - this.clearSince >= FLEE_CLEAR_TICKS) || tick - this.start >= FLEE_MAX_TICKS;
  }
}
