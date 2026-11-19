import type { TacticalContext } from '../tactics/manoeuvre.js';
import {
  MORALE_LOCK_TICKS,
  MORALE_OUTCOME,
  moraleSeed,
  rollMorale,
  type MoraleOutcome,
  type MoraleTracker,
  type MoraleWeights,
} from '../tactics/morale.js';
import { FALLBACK_MAX_TICKS, type MoraleRollFn } from '../hostileDroneTuning.js';
import type { PilotSenses } from './pilotSenses.js';

/** Mutable twin of `MoraleInputs` (one scratch per brain, #14). */
interface MoraleInputsScratch {
  hullFrac: number;
  recentDamageRate: number;
  alliesNear: number;
  enemiesNear: number;
  ownSize: number;
  enemySize: number;
  isCapitalNearbyFriendly: boolean;
}

/**
 * The pilot's morale state (slice 6b, owner's "roll a dice"), owned by
 * `HostileDroneBehaviour` and built once: when the die may roll, the roll
 * itself from the sensor picture, and the FallBack lock / cap it leaves.
 * The trigger model and the roll are `tactics/morale.ts`; this holds the
 * brain's timers and scratch only (alloc-free, #14).
 */
export class PilotMorale {
  private readonly _moraleIn: MoraleInputsScratch = {
    hullFrac: 1, recentDamageRate: 0, alliesNear: 0, enemiesNear: 0, ownSize: 1, enemySize: 0, isCapitalNearbyFriendly: false,
  };
  /** The die (test seam: `setMoraleRoll`). */
  roll: MoraleRollFn = rollMorale;
  /** A forced FallBack holds until this tick (Flee holds until the warp). */
  lockUntil = -1;
  /** No morale roll before this tick: every roll, Fight on included, holds
   *  `MORALE_LOCK_TICKS`. Triggers are not checked meanwhile, so one that
   *  arms inside the lock still rolls once it ends. */
  nextRollAt = -1;
  /** A FallBack still on its way to its friends gives up at this tick. */
  fallBackCapUntil = -1;
  /** Last roll's outcome (-1 = never rolled). */
  last: MoraleOutcome | -1 = -1;

  constructor(private readonly _morale: MoraleTracker) {}

  /** Damage this ship took (server damage path → AiController); `maxHull`
   *  falls back to the kind's `maxHealth` when absent or not positive. */
  noteDamage(amount: number, atTick: number, maxHull: number | undefined, kindMaxHull: number): void {
    this._morale.noteDamage(atTick, amount, maxHull !== undefined && maxHull > 0 ? maxHull : kindMaxHull);
  }

  /** The squad's capital died (the next decision rolls). */
  noteCapitalLost(): void {
    this._morale.noteCapitalLost();
  }

  /**
   * A trigger (hull 50 / 25 %, burst, capital lost, outnumbered) rolls the
   * die; FallBack then runs locked. A fleeing ship keeps fleeing (no roll).
   * Returns the outcome, or -1 when nothing rolled.
   */
  decide(
    tick: number, c: TacticalContext, fleeing: boolean, senses: PilotSenses,
    ownSize: number, weights: MoraleWeights, idHash: number,
  ): MoraleOutcome | -1 {
    const trig = tick >= this.nextRollAt ? this._morale.update(tick, c.hullFrac, c.allies, c.enemies) : -1;
    if (trig === -1 || fleeing) return -1;
    const outcome = this.rollNow(tick, c.hullFrac, c.sensorEnemies, senses, ownSize, weights, idHash);
    this.nextRollAt = tick + MORALE_LOCK_TICKS;
    this.last = outcome;
    if (outcome === MORALE_OUTCOME.FallBack) {
      this.lockUntil = tick + MORALE_LOCK_TICKS;
      this.fallBackCapUntil = tick + FALLBACK_MAX_TICKS;
    }
    return outcome;
  }

  /** Roll the morale die from the current sensor picture (alloc-free). */
  private rollNow(
    tick: number, hullFrac: number, enemiesNear: number, senses: PilotSenses,
    ownSize: number, weights: MoraleWeights, idHash: number,
  ): MoraleOutcome {
    const m = this._moraleIn;
    m.hullFrac = hullFrac;
    m.recentDamageRate = this._morale.windowDamageFrac(tick);
    m.alliesNear = senses.sensorAllies;
    m.enemiesNear = enemiesNear;
    m.ownSize = ownSize;
    m.enemySize = senses.enemySize;
    m.isCapitalNearbyFriendly = senses.capitalNear;
    return this.roll(m, weights, moraleSeed(idHash, this._morale.triggerCount));
  }
}
