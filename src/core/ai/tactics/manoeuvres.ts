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
  targetParked,
  targetSlow,
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
/** Station behind the target once inside `TAIL_CLOSE_FROM` × fire range,
 *  and never closer than `TAIL_CLOSE_MIN_RADII` own hull radii (#18). The
 *  station is reached at the target's speed, so it is where a Tail flies in
 *  formation: at 0.1 × fire range (~3 radii) a fighter sat at 92–94 u behind
 *  a pilot cruising at 93 u/s, trading fire at point blank (filmed melee,
 *  2026-11-14). Still well inside the 0.6 far station, so it keeps the
 *  Lufbery fix (below). */
export const TAIL_BEHIND_CLOSE = 0.3;
export const TAIL_CLOSE_MIN_RADII = 6;
const TAIL_CLOSE_FROM = 0.5;
/** Pursuit lead on the station point is capped at this (s). */
const TAIL_LEAD_MAX_S = 2;
/** Inside this share of fire range from the station the closing speed ramps down. */
const TAIL_ARRIVE = 0.5;
/** Boost while farther than this × fire range. */
const TAIL_BOOST_RANGE = 1.5;
/** cos of the target's aspect above which it is coming at me (60°). */
const TAIL_HEADON_COS = 0.5;
/** A head-on station is aimed this many own hull radii beside the target.
 *  Its own number, not the attack run's miss: a wider offset here swings the
 *  chaser wide of the merge and it never reaches the six (2026-11-14: at 3.5
 *  radii the pooled tail share fell to the unfixed 0.05). */
const TAIL_HEADON_MISS_RADII = 2.5;
/** Cap on the sideways stretch of a head-on station (× that miss). */
const TAIL_HEADON_MAX_STRETCH = 4;
/** Share of the reverse-limited speed the tail closes at (braking margin). */
const TAIL_BRAKE_SAFETY = 0.8;
/** Least speed while off the station, × cruise (a tail never hovers). */
const TAIL_MIN_SPEED = 0.8;
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
  begin(): void { /* stateless */ }
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
    // The station tightens in from TAIL_BEHIND to TAIL_BEHIND_CLOSE as the
    // gap closes from fire range to half of it: a far station behind a
    // turning target swings round a circle wider than the target's own turn,
    // so two ships each chasing the other's distant six fly a circle opposite
    // each other forever (a Lufbery circle; 2026-11-13 on-sight tail test).
    let f = (ctx.dist - TAIL_CLOSE_FROM * R) / ((1 - TAIL_CLOSE_FROM) * R);
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    let near = TAIL_BEHIND_CLOSE * R;
    if (near < TAIL_CLOSE_MIN_RADII * ctx.radius) near = TAIL_CLOSE_MIN_RADII * ctx.radius;
    let far = TAIL_BEHIND * R;
    if (far < near) far = near;
    const behind = near + (far - near) * f;
    let px = ctx.tx + bx * behind;
    let py = ctx.ty + by * behind;
    const d0 = Math.hypot(px - ctx.x, py - ctx.y);
    // Lead pursuit to close (aim the station ahead by the time to get there);
    // lag pursuit once in gun range (the station itself, behind the target's
    // velocity): a led station inside the turn pulls the chaser across the
    // target's path and past it.
    const lead = ctx.dist <= R ? 0 : Math.min(TAIL_LEAD_MAX_S, d0 / Math.max(ctx.cruiseSpeed, 1));
    // Target coming at me: its six is on the far side of it, so the straight
    // line to the station runs through its hull. Aim the station sideways so
    // the line passes a run's miss beside the target (the same fixed side as
    // an attack run, so a head-on pair passes apart) and merge at speed.
    if (ctx.targetAspectCos > TAIL_HEADON_COS && ctx.dist > 1e-6) {
      const k = TAIL_HEADON_MISS_RADII * ctx.radius * Math.min(TAIL_HEADON_MAX_STRETCH, d0 / ctx.dist) * RUN_DEFAULT_SIDE;
      px += -ctx.uy * k;
      py += ctx.ux * k;
    }
    px += ctx.tvx * lead;
    py += ctx.tvy * lead;
    const dx = px - ctx.x;
    const dy = py - ctx.y;
    const d = Math.hypot(dx, dy);
    // Close no faster than the ship can shed by the station with its own
    // reverse (the kind's handling), so it settles on the six at the
    // target's speed instead of overshooting it.
    const brake = TAIL_BRAKE_SAFETY * Math.sqrt(2 * ctx.brakeAccel * d);
    let approach = ctx.maxSpeed * Math.min(1, d / (TAIL_ARRIVE * R));
    if (approach > brake) approach = brake;
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
   * A parked ship (`targetParked`) has no six. The picker does not choose
   * Tail on one (it flies strafing runs, owner decision 2026-11-14), so this
   * only covers the moments a running Tail sees its target stop: circle it at
   * `TAIL_BEHIND × fireRange` at the floor speed, round the side the nose
   * already points to, steering in or out by the range error, nose on the
   * lead only while the course runs within 60° of it. Always moving: a nose
   * held on a parked target (the rule this replaced) hovered nose-on at
   * ~380 u, creeping, for 20 s (the filmed Robot Orb), and a station straight
   * back out on its own side turned a close pair in place nose to nose
   * (on-sight integration 2026-11-13).
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
    out.facing = ctx.dist <= R && (this.wantVx * ctx.ux + this.wantVy * ctx.uy) / out.speed > TAIL_AIM_COS
      ? FACE_AIM_LEAD : FACE_MOVE;
    out.boost = false;
  }
}

// ── Attack run ──────────────────────────────────────────────────────────
const RUN_DIVE = 0;
const RUN_PASS = 1;
const RUN_EXTEND = 2;
const RUN_DONE = 3;
/** Started inside its pass distance: open the range first (see the class). */
const RUN_OPEN = 4;
/** Lateral relative speed (× cruise) that picks the miss side by itself. */
const RUN_LATERAL_EPS = 0.1;
/** Miss side with no lateral motion: −1 = to the right of the target line,
 *  for everyone, so a head-on pair passes apart. */
const RUN_DEFAULT_SIDE = -1;
/** The dive aims this many own hull radii beside the target: two hulls and
 *  a hull of air. The target moves while the pass is flown, so in a bare
 *  duel the miss lands near a graze; hull avoidance (HostileDroneBehaviour)
 *  opens the rest. A wider aim (3.5–4 radii, 2026-11-14) flew straighter
 *  passes and failed the on-sight 1v1 "ships turn" gate. */
const RUN_MISS_RADII = 2.5;
/** The pull-off begins once the closing speed would cover the gap in the time
 *  it takes to turn the nose this far (rad) plus the miss clearance: a fast
 *  dive pulls off early, a slow one late. */
const RUN_PULL_TURN = Math.PI / 4;
/** Give up a dive that has not reached the target in this long (s). */
const RUN_DIVE_MAX_S = 5;
/** …or this many times the time to cover the starting gap at cruise. */
const RUN_DIVE_TIME_MUL = 1.1;
/** A pass that never gets the overshoot clear ends after this long (s). */
const RUN_PASS_MAX_S = 2;
/** Seeded extend time range (s); the extend ends early once the gap is
 *  `RUN_EXTEND_RANGE` × fire range (room to turn and come back). */
const RUN_EXTEND_MIN_S = 1.5;
const RUN_EXTEND_MAX_S = 3;
const RUN_EXTEND_RANGE = 1.3;
/** A run that starts inside its pass distance (`runPullDist`) first opens
 *  the range to this many overshoots (`shipTuning(kind).attackRunOvershoot`,
 *  #18), and never less than `RUN_OPEN_RANGE` × fire range (past the dive's
 *  "opening again inside half fire range" pull-off), then turns back for a
 *  dive. A pass flown from inside it starts from a standstill nose to nose
 *  (filmed 2026-11-14: a Robot Orb ~100 u off a heavy at 3–95 u/s, turn key
 *  flipping at full rate for ~2.5 s). */
export const RUN_OPEN_OVERSHOOTS = 1.5;
const RUN_OPEN_RANGE = 0.6;
/** The opening course runs this far off straight away from the target
 *  (rad, 45°), on the side away from the target's nose: out of its guns. */
const RUN_OPEN_OFF = Math.PI / 3;
const RUN_OPEN_COS = Math.cos(RUN_OPEN_OFF);
const RUN_OPEN_SIN = Math.sin(RUN_OPEN_OFF);
/** …but only from below this share of my cruise: a ship already flying at
 *  speed (a chase from behind, a fast merge) has the way on it to fly the
 *  pass. And a target running from me faster than this share of my cruise
 *  opens the range itself: the open ends and the dive chases it (turning
 *  away let a fleeing ship go, fleeEvade). */
export const RUN_OPEN_MAX_SPEED_FRAC = 0.5;
/** An open that never gets the range ends the run after this long (s). */
const RUN_OPEN_MAX_S = 5;
/** Strafing a parked or slow (`targetSlow`) target (owner decision 2026-11-14: "dive in firing,
 *  pass, swing round and come again, like a fighter on a ground target"):
 *  the extend ends once the gap is this many overshoots
 *  (`shipTuning(kind).attackRunOvershoot`, #18), not on the seeded timer
 *  (which still caps it, at twice its longest). One overshoot: the pass has
 *  already carried the ship that far, and the next run's swing-round arc
 *  takes it out to ~1.4 overshoots before the dive. A fighter at the default
 *  2x scale turns ~0.9 rad/s at ~150 u/s, so every overshoot added here
 *  adds ~6 s to a cycle (1.5 → one pass per ~14 s, strafeParked). */
export const STRAFE_EXTEND_OVERSHOOTS = 1;
/** Strafing a parked or slow target: the dive aims this share of the overshoot
 *  beside it (see `runMiss`). */
export const STRAFE_MISS_OVERSHOOTS = 0.25;
/** A dive's swing-round arcs (course square to the velocity) while the ship
 *  still flies away from the target faster than this × cruise (any target
 *  ship, slow or not). */
const STRAFE_SWING_MIN_SPEED = 0.25;

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
 *
 * A run picked INSIDE its pass distance from below `RUN_OPEN_MAX_SPEED_FRAC`
 * of cruise (no way on it) first opens the range, as a pilot
 * would: extend away with boost on a course 45° off straight away, on the
 * side away from the target's nose (latched at the start), out to
 * `RUN_OPEN_OVERSHOOTS` overshoots, then dive. Without it the pass was flown
 * from a standstill ~100 u off the target, nose to nose.
 */
export class AttackRunManoeuvre implements IManoeuvre {
  readonly id = MANOEUVRE_ATTACK_RUN;
  phase = RUN_DIVE;
  private side = 1;
  private passX = 0;
  private passY = 1;
  private phaseEnd = 0;
  /** Opening side (left-hand normal of the target line), latched at begin. */
  private openSide = 1;
  /** Diving at the target, guns on it (the fire-lane nudge may side-step it). */
  get diving(): boolean { return this.phase === RUN_DIVE; }

  begin(ctx: TacticalContext): void {
    const slow = RUN_OPEN_MAX_SPEED_FRAC * ctx.cruiseSpeed;
    if (ctx.dist < runPullDist(ctx) && ctx.vx * ctx.vx + ctx.vy * ctx.vy < slow * slow) {
      // Inside the pass distance, slow: open the range first. Off the target's
      // nose: its nose's lean across the line to me picks the other side;
      // facing unknown or dead on, the side I already slide to, else the
      // fixed side.
      this.phase = RUN_OPEN;
      const nx = -ctx.uy;
      const ny = ctx.ux;
      const nose = ctx.tFwdX * nx + ctx.tFwdY * ny;
      const lat = nx * (ctx.vx - ctx.tvx) + ny * (ctx.vy - ctx.tvy);
      this.openSide = nose > RUN_LATERAL_EPS ? -1 : nose < -RUN_LATERAL_EPS ? 1
        : lat > RUN_LATERAL_EPS * ctx.cruiseSpeed ? 1 : lat < -RUN_LATERAL_EPS * ctx.cruiseSpeed ? -1 : RUN_DEFAULT_SIDE;
      this.phaseEnd = ctx.tick + RUN_OPEN_MAX_S * TICKS_PER_S;
      return;
    }
    this.startDive(ctx);
  }

  private startDive(ctx: TacticalContext): void {
    this.phase = RUN_DIVE;
    // Pass on the side we are already sliding toward; with no lateral motion,
    // a fixed rule (everyone passes the same way round), so two ships diving
    // at each other offset apart instead of into each other.
    const lat = -ctx.uy * (ctx.vx - ctx.tvx) + ctx.ux * (ctx.vy - ctx.tvy);
    this.side = lat > RUN_LATERAL_EPS * ctx.cruiseSpeed ? 1 : lat < -RUN_LATERAL_EPS * ctx.cruiseSpeed ? -1 : RUN_DEFAULT_SIDE;
    // A dive that starts far out gets the time to get there at cruise (with
    // margin): a fixed 5 s timed a 1500 u dive out before the pass.
    const reach = (RUN_DIVE_TIME_MUL * ctx.dist) / Math.max(ctx.cruiseSpeed, 1);
    this.phaseEnd = ctx.tick + Math.round((reach > RUN_DIVE_MAX_S ? reach : RUN_DIVE_MAX_S) * TICKS_PER_S);
  }

  writeGoal(ctx: TacticalContext, maps: ContextMaps, out: ManoeuvreGoal): void {
    this.advance(ctx);
    if (this.phase === RUN_OPEN) {
      // Away from the target, 45° off toward the latched side (live line).
      const s = this.openSide;
      addInterestToward(maps, -ctx.ux * RUN_OPEN_COS - ctx.uy * s * RUN_OPEN_SIN,
        -ctx.uy * RUN_OPEN_COS + ctx.ux * s * RUN_OPEN_SIN, 1, GOAL_SHAPE);
      out.speed = ctx.maxSpeed;
      out.facing = FACE_MOVE;
      // Burn out of it like a ship running: boost as soon as the nose is
      // within 90° of the course, reserve included (`spendReserve`).
      out.boost = true;
      out.spendReserve = true;
      // Commit at once: the throttle drops whatever it held toward the
      // target (reverse while the nose swings round, then thrust).
      out.throttleNow = true;
      return;
    }
    if (this.phase === RUN_DIVE) {
      const miss = runMiss(ctx) * this.side;
      // Perpendicular to the target line (left-hand normal).
      let gx = ctx.aimX - ctx.uy * miss - ctx.x;
      let gy = ctx.aimY + ctx.ux * miss - ctx.y;
      // A dive started while still flying away from the target (after an
      // extend, or out of the open): swing round in an arc, course square to
      // the velocity on the target's side, so thrust curves the velocity
      // instead of cancelling it. Aiming straight back at the target turned
      // the ship in place: the speed fell to ~30 % of cruise for ~3 s every
      // pass (strafeParked). Whatever the target's speed (owner: "everyone
      // accelerates all the time in combat"): gated on a slow target only,
      // a robot orb on a pilot at 47–187 u/s braked 122 → 14 u/s to turn
      // back (filmed take 5, 2026-11-14; attackRunTurnBack).
      const v = Math.hypot(ctx.vx, ctx.vy);
      if (ctx.targetIsShip && v > STRAFE_SWING_MIN_SPEED * ctx.cruiseSpeed
        && ctx.vx * ctx.ux + ctx.vy * ctx.uy < 0) {
        const s = ctx.vx * ctx.uy - ctx.vy * ctx.ux >= 0 ? 1 : -1;
        gx = (-ctx.vy / v) * s;
        gy = (ctx.vx / v) * s;
      }
      addInterestToward(maps, gx, gy, 1, GOAL_SHAPE);
      out.speed = ctx.maxSpeed;
      // Nose along the course to the miss point, not on the lead: a ship
      // thrusts only along its nose, so a nose held on the lead flies the
      // dive into the target (a ram, now a real weapon). The course runs a
      // few degrees off the lead, so the guns still bear for most of the
      // dive (the fire gate is a cone; the shot goes along the exact lead).
      out.facing = FACE_MOVE;
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
    if (this.phase === RUN_OPEN) {
      if (ctx.tick >= this.phaseEnd) { this.phase = RUN_DONE; return; }
      if (ctx.dist >= runOpenDist(ctx)
        || ctx.tvx * ctx.ux + ctx.tvy * ctx.uy > RUN_OPEN_MAX_SPEED_FRAC * ctx.cruiseSpeed) this.startDive(ctx);
      return;
    }
    if (this.phase === RUN_DIVE) {
      if (ctx.tick >= this.phaseEnd) { this.phase = RUN_DONE; return; }
      if (ctx.dist < runPullDist(ctx) || (ctx.closing < 0 && ctx.dist < 0.5 * ctx.fireRange)) {
        // Lock the pass heading: toward the miss point beside the target.
        const miss = runMiss(ctx) * this.side;
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
    if (this.phase === RUN_EXTEND) {
      if (ctx.targetIsShip && targetSlow(ctx)) {
        if (ctx.dist > STRAFE_EXTEND_OVERSHOOTS * ctx.overshoot
          || ctx.tick >= this.phaseEnd + RUN_EXTEND_MAX_S * TICKS_PER_S) this.phase = RUN_DONE;
      } else if (ctx.tick >= this.phaseEnd || ctx.dist > RUN_EXTEND_RANGE * ctx.fireRange) {
        this.phase = RUN_DONE;
      }
    }
  }
}

/** How far beside the target the run passes: a size, not a range (#18). */
function runMiss(ctx: TacticalContext): number {
  const m = RUN_MISS_RADII * ctx.radius;
  if (!(ctx.targetIsShip && targetSlow(ctx))) return m;
  // A parked or slow target barely moves off the line while the pass is flown, so
  // the 2.5-radii aim (tuned on moving duels) lands exactly there: two shield
  // bubbles touch (strafeParked: a ram on the first pass). Strafe a quarter
  // overshoot aside (`shipTuning.attackRunOvershoot` / 4, as the tuning
  // documents), never less than the duel miss.
  const s = STRAFE_MISS_OVERSHOOTS * ctx.overshoot;
  return s > m ? s : m;
}

/** Gap a run started inside its pass distance opens to before it dives. */
export function runOpenDist(ctx: TacticalContext): number {
  const a = RUN_OPEN_OVERSHOOTS * ctx.overshoot;
  const b = RUN_OPEN_RANGE * ctx.fireRange;
  return a > b ? a : b;
}

/** Gap at which the dive pulls off: the overshoot, or (faster) the distance
 *  the closing speed covers while the nose turns `RUN_PULL_TURN` at the
 *  kind's turn rate, plus the miss clearance. Follows the kind's handling,
 *  so a retuned ship keeps passing beside its target. */
export function runPullDist(ctx: TacticalContext): number {
  const closing = ctx.closing > 0 ? ctx.closing : 0;
  const d = closing * (RUN_PULL_TURN / Math.max(ctx.maxAngvel, 1e-3)) + runMiss(ctx);
  return d > ctx.overshoot ? d : ctx.overshoot;
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

