/**
 * Morale check: a damaged NPC rolls a weighted die (plan composed-harbor,
 * owner decision #2, "Morale check" in "3. Decision layer").
 *
 * Owner: "It's more interesting if it's a loot table type situation. It
 * depends. All of the above potentially depending on friends nearby, damage,
 * how fast it occurred, size of ship vs enemies... Then it rolls a dice to
 * decide essentially."
 *
 * Two pieces, both pure and allocation-free after construction (#14):
 *  - `MoraleTracker`: per-ship plain-field state that says WHEN to roll
 *    (hull thresholds, burst damage, own capital lost, outnumbered).
 *  - `rollMorale`: the weighted roll itself (FIGHT_ON / FALL_BACK / FLEE),
 *    seeded by `moraleSeed(entity id, trigger count)` through the shared
 *    mulberry32 `Rng`, so the same ship and event always roll the same way.
 *
 * Time is in simulation TICKS (game time, #20), never wall time.
 * Not wired into behaviour yet (slice 6a); the decision layer reads it later.
 */

import { fnv1a32, fnvMixU32, Rng } from '../../random/rng.js';

// ---------------------------------------------------------------------------
// Outcomes and weights
// ---------------------------------------------------------------------------

export const MORALE_OUTCOME = {
  FightOn: 0,
  FallBack: 1,
  Flee: 2,
} as const;
export type MoraleOutcome = (typeof MORALE_OUTCOME)[keyof typeof MORALE_OUTCOME];

/**
 * Base weights of the three outcomes before situational modifiers. Shape-
 * compatible with `roleProfiles.ts`' `MoraleWeights` (branch feat/ai-roles):
 * pass a role's `moraleWeights` straight in.
 */
export interface MoraleWeights {
  readonly fightOn: number;
  readonly fallBack: number;
  readonly flee: number;
}

/** Caller-owned scratch the modified weights are written into. */
export interface MutableMoraleWeights {
  fightOn: number;
  fallBack: number;
  flee: number;
}

export interface MoraleInputs {
  /** Hull remaining, 0..1. */
  readonly hullFrac: number;
  /** Damage taken in the burst window as a fraction of max hull (0..1+). */
  readonly recentDamageRate: number;
  /** Friendly combatants near the ship (excluding itself). */
  readonly alliesNear: number;
  /** Hostile combatants near the ship. */
  readonly enemiesNear: number;
  /** Own size (radius or mass; same unit as `enemySize`). */
  readonly ownSize: number;
  /** Summed size of the nearby attackers (same unit as `ownSize`). */
  readonly enemySize: number;
  /** A friendly capital is near enough to fall back on. */
  readonly isCapitalNearbyFriendly: boolean;
}

// ---------------------------------------------------------------------------
// Tunables (balance knobs; the directions are locked by morale.test.ts)
// ---------------------------------------------------------------------------

/** Allies counted at most (a huge blob doesn't make a ship fearless). */
export const MORALE_ALLY_CAP = 6;
/** fightOn ×(1 + this × allies): friends nearby stiffen resolve. */
export const MORALE_ALLY_FIGHT = 0.15;
/** fallBack ×(1 + this × allies): there is someone to fall back to. */
export const MORALE_ALLY_FALLBACK = 0.1;
/** flee ÷(1 + this × allies): less likely to run when not alone. */
export const MORALE_ALLY_FLEE = 0.2;
/** recentDamageRate counted at most. */
export const MORALE_DAMAGE_RATE_CAP = 2;
/** flee ×(1 + this × rate): heavy or fast damage makes it run. */
export const MORALE_DAMAGE_FLEE = 3;
/** fightOn ×(FLOOR + (1 − FLOOR) × hullFrac): a wreck fights less. */
export const MORALE_HULL_FIGHT_FLOOR = 0.25;
/** Size ratio (enemy / own) counted at most, either way. */
export const MORALE_SIZE_RATIO_CAP = 16;
/** flee ×(1 + this × log2(enemy/own)) when outsized; fightOn the same when it is the bigger. */
export const MORALE_SIZE_FLEE = 0.5;
/** fallBack × this when a friendly capital is near. */
export const MORALE_CAPITAL_FALLBACK = 2;

/** After a roll the outcome holds this long (ticks, 60 Hz game time) before another roll. */
export const MORALE_LOCK_TICKS = 300;

// ---------------------------------------------------------------------------
// Weighted roll
// ---------------------------------------------------------------------------

function nonNeg(v: number): number {
  return v > 0 && Number.isFinite(v) ? v : 0;
}

/**
 * Apply the situational modifiers to `base`, writing into `out` (clamped ≥ 0).
 * Exposed so tests and debug views can see the odds without rolling.
 */
export function moraleWeightsFor(
  inputs: MoraleInputs,
  base: MoraleWeights,
  out: MutableMoraleWeights,
): MutableMoraleWeights {
  let fight = nonNeg(base.fightOn);
  let fall = nonNeg(base.fallBack);
  let flee = nonNeg(base.flee);

  // Friends nearby.
  const allies = Math.min(MORALE_ALLY_CAP, nonNeg(inputs.alliesNear));
  fight *= 1 + MORALE_ALLY_FIGHT * allies;
  fall *= 1 + MORALE_ALLY_FALLBACK * allies;
  flee /= 1 + MORALE_ALLY_FLEE * allies;

  // Heavy / fast damage.
  const rate = Math.min(MORALE_DAMAGE_RATE_CAP, nonNeg(inputs.recentDamageRate));
  flee *= 1 + MORALE_DAMAGE_FLEE * rate;

  // Low hull.
  const hull = Math.min(1, nonNeg(inputs.hullFrac));
  fight *= MORALE_HULL_FIGHT_FLOOR + (1 - MORALE_HULL_FIGHT_FLOOR) * hull;

  // Own size vs the attackers'.
  const own = nonNeg(inputs.ownSize);
  const enemy = nonNeg(inputs.enemySize);
  if (own > 0 && enemy > 0) {
    const ratio = Math.min(MORALE_SIZE_RATIO_CAP, Math.max(1 / MORALE_SIZE_RATIO_CAP, enemy / own));
    const l = Math.log2(ratio);
    if (l > 0) flee *= 1 + MORALE_SIZE_FLEE * l;
    else if (l < 0) fight *= 1 - MORALE_SIZE_FLEE * l;
  }

  // A friendly capital to fall back on.
  if (inputs.isCapitalNearbyFriendly) fall *= MORALE_CAPITAL_FALLBACK;

  out.fightOn = nonNeg(fight);
  out.fallBack = nonNeg(fall);
  out.flee = nonNeg(flee);
  return out;
}

const MORALE_SALT = fnv1a32('morale');

/** Seed for one roll: (entity numeric id, the tracker's trigger count). */
export function moraleSeed(entityId: number, triggerCount: number): number {
  return fnvMixU32(fnvMixU32(MORALE_SALT, entityId >>> 0), triggerCount >>> 0);
}

// Module-scope scratch (#14): one Rng, reseeded per roll; one weights object.
const rollRng = new Rng(0);
const rollWeights: MutableMoraleWeights = { fightOn: 0, fallBack: 0, flee: 0 };

/**
 * Roll the morale die. Deterministic: same inputs, weights and seed ⇒ same
 * outcome. All weights zero ⇒ FightOn.
 */
export function rollMorale(inputs: MoraleInputs, baseWeights: MoraleWeights, seed: number): MoraleOutcome {
  const w = moraleWeightsFor(inputs, baseWeights, rollWeights);
  const total = w.fightOn + w.fallBack + w.flee;
  if (!(total > 0)) return MORALE_OUTCOME.FightOn;
  const r = (rollRng.reseed(seed).u32() / 4294967296) * total;
  if (r < w.fightOn) return MORALE_OUTCOME.FightOn;
  if (r < w.fightOn + w.fallBack) return MORALE_OUTCOME.FallBack;
  return w.flee > 0 ? MORALE_OUTCOME.Flee : MORALE_OUTCOME.FallBack;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const MORALE_TRIGGER = {
  Hull50: 0,
  Hull25: 1,
  Burst: 2,
  CapitalLost: 3,
  Outnumbered: 4,
} as const;
export type MoraleTrigger = (typeof MORALE_TRIGGER)[keyof typeof MORALE_TRIGGER];

export const MORALE_HULL_HIGH = 0.5;
export const MORALE_HULL_LOW = 0.25;
/** A hull threshold re-arms once healed above threshold + this. */
export const MORALE_HULL_HYSTERESIS = 0.1;
/** Burst window: 2 s of 60 Hz game ticks. */
export const MORALE_BURST_WINDOW_TICKS = 120;
/** Ring buckets across the window (bucket width = window / count ticks). */
export const MORALE_BURST_BUCKETS = 8;
const BURST_BUCKET_TICKS = MORALE_BURST_WINDOW_TICKS / MORALE_BURST_BUCKETS;
/** Burst fires when the window's damage reaches this fraction of max hull. */
export const MORALE_BURST_FRAC = 0.2;
/** Burst re-arms once the window falls below this fraction of `MORALE_BURST_FRAC`. */
export const MORALE_BURST_REARM = 0.5;
/** Outnumbered when enemies ≥ this × (allies + self). */
export const MORALE_OUTNUMBER_RATIO = 3;
/** Outnumbered re-arms once enemies < this × (allies + self). */
export const MORALE_OUTNUMBER_REARM = 2;

/**
 * Per-ship trigger detector. Each trigger fires once, then re-arms only after
 * the condition clearly clears (hysteresis). `update` returns at most one
 * trigger per call (priority: capital lost, hull 25 %, hull 50 %, burst,
 * outnumbered); each fire bumps `triggerCount`, which seeds the roll.
 */
export class MoraleTracker {
  /** Number of triggers fired so far: the roll's seed counter. */
  triggerCount = 0;

  private hull50Armed = true;
  private hull25Armed = true;
  private burstArmed = true;
  private outnumberedArmed = true;
  private capitalLostPending = false;

  /** Damage fractions (of max hull) per bucket; the bucket for tick t is floor(t / width) % N. */
  private readonly buckets = new Float64Array(MORALE_BURST_BUCKETS);
  /** Absolute bucket index the ring was last advanced to. */
  private headBucket = 0;
  private started = false;

  /** Record damage taken at `tick`. */
  noteDamage(tick: number, amount: number, maxHull: number): void {
    if (!(amount > 0) || !(maxHull > 0)) return;
    this.advance(tick);
    this.buckets[this.headBucket % MORALE_BURST_BUCKETS]! += amount / maxHull;
  }

  /** The squad's capital died: the next `update` fires `CapitalLost`. */
  noteCapitalLost(): void {
    this.capitalLostPending = true;
  }

  /** Damage in the last burst window as a fraction of max hull. */
  windowDamageFrac(tick: number): number {
    this.advance(tick);
    let sum = 0;
    for (let i = 0; i < MORALE_BURST_BUCKETS; i++) sum += this.buckets[i]!;
    return sum;
  }

  /** Check the triggers at `tick`. Returns the fired `MoraleTrigger`, or -1. */
  update(tick: number, hullFrac: number, alliesNear: number, enemiesNear: number): MoraleTrigger | -1 {
    // Re-arm first.
    if (hullFrac > MORALE_HULL_HIGH + MORALE_HULL_HYSTERESIS) this.hull50Armed = true;
    if (hullFrac > MORALE_HULL_LOW + MORALE_HULL_HYSTERESIS) this.hull25Armed = true;
    const burst = this.windowDamageFrac(tick);
    if (burst < MORALE_BURST_FRAC * MORALE_BURST_REARM) this.burstArmed = true;
    const side = (alliesNear > 0 ? alliesNear : 0) + 1;
    if (enemiesNear < MORALE_OUTNUMBER_REARM * side) this.outnumberedArmed = true;

    let fired: MoraleTrigger | -1 = -1;
    if (this.capitalLostPending) {
      this.capitalLostPending = false;
      fired = MORALE_TRIGGER.CapitalLost;
    } else if (this.hull25Armed && hullFrac <= MORALE_HULL_LOW) {
      // Crossing 25 % also consumes 50 % (one roll for one blow).
      this.hull25Armed = false;
      this.hull50Armed = false;
      fired = MORALE_TRIGGER.Hull25;
    } else if (this.hull50Armed && hullFrac <= MORALE_HULL_HIGH) {
      this.hull50Armed = false;
      fired = MORALE_TRIGGER.Hull50;
    } else if (this.burstArmed && burst >= MORALE_BURST_FRAC) {
      this.burstArmed = false;
      fired = MORALE_TRIGGER.Burst;
    } else if (this.outnumberedArmed && enemiesNear >= MORALE_OUTNUMBER_RATIO * side) {
      this.outnumberedArmed = false;
      fired = MORALE_TRIGGER.Outnumbered;
    }
    if (fired !== -1) this.triggerCount++;
    return fired;
  }

  /** Back to a fresh ship (respawn / pool reuse). */
  reset(): void {
    this.triggerCount = 0;
    this.hull50Armed = this.hull25Armed = this.burstArmed = this.outnumberedArmed = true;
    this.capitalLostPending = false;
    this.buckets.fill(0);
    this.headBucket = 0;
    this.started = false;
  }

  /** Move the ring head to `tick`'s bucket, zeroing buckets that aged out. */
  private advance(tick: number): void {
    const b = Math.floor(tick / BURST_BUCKET_TICKS);
    if (!this.started) {
      this.started = true;
      this.headBucket = b;
      return;
    }
    if (b <= this.headBucket) return;
    const steps = Math.min(MORALE_BURST_BUCKETS, b - this.headBucket);
    for (let i = 1; i <= steps; i++) this.buckets[(this.headBucket + i) % MORALE_BURST_BUCKETS] = 0;
    this.headBucket = b;
  }
}
