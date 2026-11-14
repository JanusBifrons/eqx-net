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
  MANOEUVRE_HOLD,
  MANOEUVRE_TAIL,
  type ManoeuvreId,
  type TacticalContext,
} from './manoeuvre.js';
import type { Rng } from '../../random/rng.js';

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
 *  barely moving target counts (aspect 0): its guns may still bear. */
export const TAILED_ASPECT_COS = -0.2;
/** Recent hits that count as heavy fire; it only breaks a ship whose
 *  attacker is off its bow (cos below this, ~60°): one it can shoot back at
 *  it fights. */
export const HEAVY_HITS = 4;
export const HEAVY_FIRE_BOW_COS = 0.5;
/** Hold's share of the role's stand-off weights (orbit / kite, which slice 6
 *  will fly as their own manoeuvres; until then they hold). */
const HOLD_STANDOFF_SHARE = 0.5;
/** Wingmen near me (same side within 1.5 × fire range) damp the solo
 *  manoeuvres by 1 / (1 + this × allies) and add this share each to Hold:
 *  a pair dogfights, a pack surrounds its target and keeps its spacing
 *  (six ships diving through one point would stack up). */
const PACK_DAMP = 0.5;
const PACK_HOLD = 0.05;

/** True when the brain should re-score on `tick` (slot-staggered cadence). */
export function decisionDue(tick: number, slot: number, lod: boolean): boolean {
  return (tick + slot) % (lod ? LOD_DECIDE_PERIOD : DECIDE_PERIOD) === 0;
}

/** Is the target behind me within reach (the Break trigger)? */
export function isTailed(ctx: TacticalContext): boolean {
  return ctx.targetIsShip && ctx.threatBearingCos < TAILED_COS && ctx.dist < TAILED_RANGE * ctx.fireRange
    && ctx.targetAspectCos > TAILED_ASPECT_COS;
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
    return;
  }
  const dN = ctx.dist / ctx.fireRange;
  const tailed = isTailed(ctx);
  out[MANOEUVRE_HOLD] = HOLD_STANDOFF_SHARE * standoff + PACK_HOLD * ctx.allies;
  const pack = 1 / (1 + PACK_DAMP * ctx.allies);

  // Tail: best close in behind the target; a poor way to close from far off
  // and poor while the target sits behind me.
  const behind = ctx.targetAspectCos < 0 ? -ctx.targetAspectCos : 0;
  const near = dN <= 1 ? 1 : dN >= 2 ? 0 : 2 - dN;
  let tail = w.tail * (0.3 + 0.7 * behind * near);
  if (tailed) tail *= 0.5;
  out[MANOEUVRE_TAIL] = tail * pack;

  // Attack run: from distance, more for aggressive roles.
  let far = (dN - 0.5) / 1.0;
  far = far < 0 ? 0 : far > 1 ? 1 : far;
  let run = w.attackRun * (0.5 + 0.5 * far) * (0.8 + 0.4 * role.aggression);
  if (tailed) run *= 0.5;
  out[MANOEUVRE_ATTACK_RUN] = run * pack;

  let brk = 0;
  if (tailed) brk = 1.6 * w.break;
  // Heavy fire from a ship I can't shoot back at (off my bow).
  else if (ctx.recentHits >= HEAVY_HITS && ctx.threatBearingCos < HEAVY_FIRE_BOW_COS) brk = 1.2 * w.break;
  out[MANOEUVRE_BREAK] = brk;
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
