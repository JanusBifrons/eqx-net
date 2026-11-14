/**
 * Utility picker for the dogfight manoeuvres (AI overhaul slice 4, plan
 * composed-harbor §3). Scores each manoeuvre from the tactical context ×
 * the role's `manoeuvreWeights`, then picks the best with:
 *  - +15 % stickiness on the running manoeuvre;
 *  - a minimum commit time, and an attack run is never cut short, except by
 *    a Break (getting shot from behind outranks finishing a pass);
 *  - per-ship seeded jitter on every score, so a pack does not switch in
 *    lockstep;
 *  - a Break cooldown, so a tailed ship alternates breaking and fighting back
 *    instead of breaking forever.
 * The brain calls `decide` on its decision cadence (`decisionDue`).
 * Allocation-free (#14): the score arrays are allocated once per picker.
 */
import type { RoleProfile } from './roleProfiles.js';
import {
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_COUNT,
  MANOEUVRE_FALL_BACK,
  MANOEUVRE_FLEE,
  MANOEUVRE_HOLD,
  MANOEUVRE_KITE,
  MANOEUVRE_ORBIT,
  GUNS_BEAR_COS,
  MANOEUVRE_TAIL,
  targetParked,
  targetSlow,
  type ManoeuvreId,
  type TacticalContext,
} from './manoeuvre.js';
import type { Rng } from '../../random/rng.js';
import { persistentBlockBias } from './fireLanes.js';

/** Re-score every this many ticks (5 Hz) while a pilot is near… */
export const DECIDE_PERIOD = 12;
/** …and this many (2 Hz) when no pilot is within `LOD_PILOT_RANGE_MUL` ×
 *  sensor range (AI level of detail: nobody is watching closely). */
export const LOD_DECIDE_PERIOD = 30;
export const LOD_PILOT_RANGE_MUL = 2;
/** Bonus on the running manoeuvre's score. */
export const STICKINESS = 0.15;
/** A manoeuvre runs at least this long before another may replace it
 *  (Break excepted). */
export const MIN_COMMIT_TICKS = 45;
/** Per-ship score jitter, ± this share. */
export const SCORE_JITTER = 0.1;
/** After a Break ends, no new Break for this long. */
export const BREAK_COOLDOWN_TICKS = 90;
/** "Tailed": the target sits in my rear cone (cos(nose, line to it) below
 *  this, i.e. more than 120° off the bow) within this × fire range. */
export const TAILED_COS = -0.5;
export const TAILED_RANGE = 1.1;
/** …and it is not flying away from me (cos(its velocity, it → me) above
 *  this; a ship I have just passed opens the range and is no threat). A
 *  parked target (`targetParked`) never tails me: a Tail circling a stopped
 *  pilot puts it in my rear cone on every lap, and breaking from it flipped
 *  Tail / Break every 0.5–1 s with no shot fired (npcFireLanes, 2026-11-14).
 *  A parked ship that actually shoots me still breaks me via heavy fire. */
export const TAILED_ASPECT_COS = -0.2;
/** Recent hits that count as heavy fire; it only breaks a ship whose
 *  attacker is off its bow (cos below this, ~60°): one it can shoot back at
 *  it fights. */
export const HEAVY_HITS = 4;
export const HEAVY_FIRE_BOW_COS = GUNS_BEAR_COS;
/** Hold's share of the role's stand-off weights (orbit / kite), scaled by
 *  (1 − aggression): a reckless role does not park. Orbit and Kite score their
 *  full weight (slice 6b), so a stand-off role prefers them and Hold stays the
 *  fallback a pack piles into. Before 2026-11-13 the robot role (orbit 0.8)
 *  held 100 % of every group fight it was in: the filmed robots that "barely
 *  move, keep facing the drones". */
const HOLD_STANDOFF_SHARE = 0.5;
/** Orbit is a turret manoeuvre: its weight × clamp(turret half-arc / this,
 *  ORBIT_FIXED_GUN_SHARE, 1). A fixed-forward gun can't bear while it turns
 *  the nose off the target, so it barely orbits. */
const ORBIT_FULL_ARC = Math.PI / 4;
const ORBIT_FIXED_GUN_SHARE = 0.25;
/** Wingmen near me (same side within 1.5 × fire range) beyond the number of
 *  other ships there damp the solo manoeuvres by 1 / (1 + this × surplus) and
 *  add this share each to Hold: a pack on one target surrounds it and keeps
 *  its spacing (six ships diving through one point would stack up), while an
 *  even group fight (3v3 on sight) breaks into duels. Counting every wingman
 *  parked any group fight in Hold (2026-11-13). */
const PACK_DAMP = 0.5;
const PACK_HOLD = 0.05;
/** Tail's share for the target merely being close (≤ fire range), whatever
 *  its aspect: after a pass the close fight is a turning fight. With only the
 *  "behind" term, a run ended where the target had turned back, so the next
 *  pick was another head-on run (the filmed straight-line jousts). */
const TAIL_NEAR = 0.4;
/** Face-off: inside this × fire range with each ship's guns bearing on the
 *  other (both noses within `GUNS_BEAR_COS` of the line). Two ships each in
 *  Tail on the other end up here, closing head-on or flying side by side
 *  trading fire (filmed 3v3, 2026-11-14: a drone and a robot at 258 → 130 u,
 *  both at half cruise, for 2 s). Neither is on a six, so neither Tail can
 *  get there: hand off to a pass instead (no Tail, the run at full). Read
 *  from what a pilot sees (where the other ship points), never its mind. */
const FACE_OFF_RANGE = 0.5;

/** True when the brain should re-score on `tick` (slot-staggered cadence). */
export function decisionDue(tick: number, slot: number, lod: boolean): boolean {
  return (tick + slot) % (lod ? LOD_DECIDE_PERIOD : DECIDE_PERIOD) === 0;
}

/** Is the target behind me within reach (the Break trigger)? */
export function isTailed(ctx: TacticalContext): boolean {
  return ctx.targetIsShip && ctx.threatBearingCos < TAILED_COS && ctx.dist < TAILED_RANGE * ctx.fireRange
    && ctx.targetAspectCos > TAILED_ASPECT_COS && !targetParked(ctx);
}

/** Raw scores (before jitter / stickiness) into `out[MANOEUVRE_COUNT]`. */
export function scoreManoeuvres(ctx: TacticalContext, role: RoleProfile, out: Float32Array): void {
  const w = role.manoeuvreWeights;
  const standoff = w.orbit > w.kite ? w.orbit : w.kite;
  if (!ctx.targetIsShip) {
    // A structure has no tail and never dodges: stand off and shoot.
    out[MANOEUVRE_HOLD] = 1;
    out[MANOEUVRE_TAIL] = 0;
    out[MANOEUVRE_ATTACK_RUN] = 0;
    out[MANOEUVRE_BREAK] = 0;
    out[MANOEUVRE_ORBIT] = 0;
    out[MANOEUVRE_KITE] = 0;
    out[MANOEUVRE_FALL_BACK] = 0;
    out[MANOEUVRE_FLEE] = 0;
    return;
  }
  const dN = ctx.dist / ctx.fireRange;
  const tailed = isTailed(ctx);
  const surplus = ctx.allies > ctx.enemies ? ctx.allies - ctx.enemies : 0;
  out[MANOEUVRE_HOLD] = HOLD_STANDOFF_SHARE * standoff * (1 - role.aggression) + PACK_HOLD * surplus;
  const pack = 1 / (1 + PACK_DAMP * surplus);

  const parked = targetParked(ctx);
  if (parked || targetSlow(ctx)) {
    // A parked or slow ship gets strafing runs (owner decision 2026-11-14: "Dive in
    // firing, pass, swing round and come again, like a fighter on a ground
    // target. Always moving."): no Tail and no Hold (both settle near a
    // stopped target: the filmed Robot Orb hovered nose-on at ~380 u for
    // 20 s), the run at its full from-distance score, so each run's extend
    // leads straight into the next. Orbit (turrets bear while circling, at
    // cruise) and Kite keep their scores. No Break either: a parked gun
    // hitting me from behind is what the run's extend flies out from under
    // (boosting away); a heavy-fire Break cut every extend short and left the
    // fighter circling at ~250 u (strafeParked, 2026-11-14).
    // A slow ship (under SLOW_SPEED_FRAC × my cruise) gets the same passes:
    // I outrun it by 2x or more, so a run comes round fast; a Tail would sit
    // on its six at its speed (2026-11-14). It can still chase me, so Break
    // keeps its normal rules against it (only a parked ship never tails me).
    out[MANOEUVRE_HOLD] = 0;
    out[MANOEUVRE_TAIL] = 0;
    out[MANOEUVRE_ATTACK_RUN] = w.attackRun * (0.8 + 0.4 * role.aggression)
      * (1 + persistentBlockBias(ctx.recentBlocks));
    out[MANOEUVRE_BREAK] = parked ? 0 : breakScore(ctx, w.break, tailed);
    out[MANOEUVRE_ORBIT] = w.orbit * orbitArc(ctx);
    out[MANOEUVRE_KITE] = w.kite;
    out[MANOEUVRE_FALL_BACK] = 0;
    out[MANOEUVRE_FLEE] = 0;
    return;
  }

  if (dN < FACE_OFF_RANGE && ctx.threatBearingCos > GUNS_BEAR_COS && ctx.targetBowCos > GUNS_BEAR_COS) {
    // Face-off (FACE_OFF_RANGE): pass, extend, re-engage.
    out[MANOEUVRE_TAIL] = 0;
    out[MANOEUVRE_ATTACK_RUN] = w.attackRun * (0.8 + 0.4 * role.aggression)
      * (1 + persistentBlockBias(ctx.recentBlocks)) * pack;
    out[MANOEUVRE_BREAK] = breakScore(ctx, w.break, tailed);
    out[MANOEUVRE_ORBIT] = w.orbit * orbitArc(ctx);
    out[MANOEUVRE_KITE] = w.kite;
    out[MANOEUVRE_FALL_BACK] = 0;
    out[MANOEUVRE_FLEE] = 0;
    return;
  }

  // Tail: best close in behind the target; a poor way to close from far off
  // and poor while the target sits behind me.
  const behind = ctx.targetAspectCos < 0 ? -ctx.targetAspectCos : 0;
  const near = dN <= 1 ? 1 : dN >= 2 ? 0 : 2 - dN;
  let tail = w.tail * (0.3 + TAIL_NEAR * near + (0.7 - TAIL_NEAR) * behind * near);
  if (tailed) tail *= 0.5;
  out[MANOEUVRE_TAIL] = tail * pack;

  // Attack run: from distance, more for aggressive roles.
  let far = (dN - 0.5) / 1.0;
  far = far < 0 ? 0 : far > 1 ? 1 : far;
  let run = w.attackRun * (0.5 + 0.5 * far) * (0.8 + 0.4 * role.aggression);
  if (tailed) run *= 0.5;
  // Persistent blocking (slice 5b): a wingman keeps sitting on my line, so
  // come in again from a new angle.
  run *= 1 + persistentBlockBias(ctx.recentBlocks);
  out[MANOEUVRE_ATTACK_RUN] = run * pack;

  out[MANOEUVRE_BREAK] = breakScore(ctx, w.break, tailed);

  // Orbit (gunships, robots): turret arcs let them circle with guns bearing.
  out[MANOEUVRE_ORBIT] = w.orbit * orbitArc(ctx);
  // Kite (missile boats): hold the band, nose on.
  out[MANOEUVRE_KITE] = w.kite;
  // Morale outcomes are never scored: only the die starts them.
  out[MANOEUVRE_FALL_BACK] = 0;
  out[MANOEUVRE_FLEE] = 0;
}

/** Break: tailed, or heavy fire from a ship I can't shoot back at (off my bow). */
function breakScore(ctx: TacticalContext, weight: number, tailed: boolean): number {
  if (tailed) return 1.6 * weight;
  if (ctx.recentHits >= HEAVY_HITS && ctx.threatBearingCos < HEAVY_FIRE_BOW_COS) return 1.2 * weight;
  return 0;
}

/** Orbit's share for the turret arc: clamp(half-arc / 45°, 0.25, 1). */
function orbitArc(ctx: TacticalContext): number {
  const arc = ctx.turretHalfArc / ORBIT_FULL_ARC;
  return arc < ORBIT_FIXED_GUN_SHARE ? ORBIT_FIXED_GUN_SHARE : arc > 1 ? 1 : arc;
}

export class ManoeuvrePicker {
  current: ManoeuvreId = MANOEUVRE_HOLD;
  /** Tick the running manoeuvre began. */
  private since = -1_000_000;
  private lastBreakEnd = -1_000_000;
  /** Last decision's final scores (test-visible). */
  readonly scores = new Float32Array(MANOEUVRE_COUNT);
  private readonly jitter = new Float32Array(MANOEUVRE_COUNT).fill(1);
  /** Decisions made (re-scores), for tests. */
  decisions = 0;

  /** Draw this ship's fixed jitter from its seeded stream. */
  seed(rng: Rng): void {
    for (let i = 0; i < MANOEUVRE_COUNT; i++) {
      this.jitter[i] = 1 + SCORE_JITTER * (2 * (rng.u32() / 4294967296) - 1);
    }
  }

  /** Record a switch (the caller begins the manoeuvre). */
  switchTo(id: ManoeuvreId, tick: number): void {
    if (this.current === MANOEUVRE_BREAK && id !== MANOEUVRE_BREAK) this.lastBreakEnd = tick;
    this.current = id;
    this.since = tick;
  }

  /** Score and return the manoeuvre the ship wants now. With `currentDone`
   *  the running one may be chosen again (a fresh run). */
  decide(ctx: TacticalContext, role: RoleProfile, currentDone: boolean): ManoeuvreId {
    this.decisions++;
    const s = this.scores;
    scoreManoeuvres(ctx, role, s);
    for (let i = 0; i < MANOEUVRE_COUNT; i++) s[i] = s[i]! * this.jitter[i]!;
    const cur = this.current;
    // Cooling down from a Break (or one just finished): no new Break yet.
    if (cur === MANOEUVRE_BREAK ? currentDone : ctx.tick - this.lastBreakEnd < BREAK_COOLDOWN_TICKS) s[MANOEUVRE_BREAK] = 0;
    if (!currentDone) s[cur] = s[cur]! * (1 + STICKINESS);
    let best: ManoeuvreId = MANOEUVRE_HOLD;
    let bestScore = s[MANOEUVRE_HOLD]!;
    for (let i = 1; i < MANOEUVRE_COUNT; i++) {
      if (s[i]! > bestScore) { bestScore = s[i]!; best = i as ManoeuvreId; }
    }
    if (currentDone || best === cur || best === MANOEUVRE_BREAK) return best;
    if (cur === MANOEUVRE_ATTACK_RUN) return cur;
    if (ctx.tick - this.since < MIN_COMMIT_TICKS) return cur;
    return best;
  }
}
