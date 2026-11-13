/**
 * Per-role NPC tactics profiles (AI overhaul slice 3, plan composed-harbor §1/§3).
 *
 * DATA ONLY. Each ship kind names its `aiRole` in the catalogue; the brain looks
 * the role up here. Today only `sensorRangeMul` is read (the body target pick's
 * sensor cap in `HostileDroneBehaviour`); the rest are the tuning knobs the
 * decision layer (manoeuvres, utility, morale) reads in later slices.
 *
 * Distances are never absolute here (#18): every range is a multiplier on the
 * ship's own fire range, which already follows mount size / ship scale.
 */

import { ON_SIGHT_ENGAGE_RANGE } from '../../../shared-types/allegiances.js';
import type { AiRole } from '../../../shared-types/shipKinds/types.js';

/** Manoeuvres the decision layer can choose between (utility base weights). */
export interface ManoeuvreWeights {
  readonly tail: number;
  readonly attackRun: number;
  readonly break: number;
  readonly orbit: number;
  readonly kite: number;
  readonly fallBack: number;
  readonly flee: number;
  readonly screen: number;
}

/** Base weights of the three morale-roll outcomes (before situational modifiers). */
export interface MoraleWeights {
  readonly fightOn: number;
  readonly fallBack: number;
  readonly flee: number;
}

export interface RoleProfile {
  /** Sensor range = this × the ship's fire range (floored at ON_SIGHT_ENGAGE_RANGE). */
  readonly sensorRangeMul: number;
  /** Preferred engagement band, × fire range. */
  readonly rangeBand: { readonly min: number; readonly max: number };
  /** 0 (cautious) .. 1 (reckless): biases utility toward closing / staying in. */
  readonly aggression: number;
  /** Ticks (60 Hz) between noticing a change and reacting to it. */
  readonly reactionTicks: number;
  /** 1-sigma aim error in radians applied to the lead point. */
  readonly aimErrorRad: number;
  readonly manoeuvreWeights: ManoeuvreWeights;
  readonly moraleWeights: MoraleWeights;
}

function profile(p: RoleProfile): RoleProfile {
  Object.freeze(p.rangeBand);
  Object.freeze(p.manoeuvreWeights);
  Object.freeze(p.moraleWeights);
  return Object.freeze(p);
}

export const ROLE_PROFILES: Readonly<Record<AiRole, RoleProfile>> = Object.freeze({
  // Fast, fragile, wide eyes: sees far, harasses, runs early.
  scout: profile({
    sensorRangeMul: 5,
    rangeBand: { min: 0.5, max: 0.9 },
    aggression: 0.3,
    reactionTicks: 8,
    aimErrorRad: 0.06,
    manoeuvreWeights: { tail: 0.4, attackRun: 0.8, break: 0.9, orbit: 0.2, kite: 0.5, fallBack: 0.5, flee: 0.6, screen: 0.1 },
    moraleWeights: { fightOn: 0.4, fallBack: 0.3, flee: 0.3 },
  }),
  // Closes fast and dives; boom-and-zoom is its signature.
  interceptor: profile({
    sensorRangeMul: 4,
    rangeBand: { min: 0.3, max: 0.7 },
    aggression: 0.8,
    reactionTicks: 6,
    aimErrorRad: 0.05,
    manoeuvreWeights: { tail: 0.7, attackRun: 1.0, break: 0.7, orbit: 0.1, kite: 0.1, fallBack: 0.3, flee: 0.3, screen: 0.4 },
    moraleWeights: { fightOn: 0.6, fallBack: 0.25, flee: 0.15 },
  }),
  // The line dogfighter: tails, breaks when tailed.
  fighter: profile({
    sensorRangeMul: 3.5,
    rangeBand: { min: 0.3, max: 0.8 },
    aggression: 0.6,
    reactionTicks: 10,
    aimErrorRad: 0.05,
    manoeuvreWeights: { tail: 1.0, attackRun: 0.6, break: 0.7, orbit: 0.3, kite: 0.1, fallBack: 0.4, flee: 0.3, screen: 0.5 },
    moraleWeights: { fightOn: 0.6, fallBack: 0.25, flee: 0.15 },
  }),
  // Heavy turreted hull: orbits at the band edge so its turrets bear.
  gunship: profile({
    sensorRangeMul: 3,
    rangeBand: { min: 0.5, max: 0.9 },
    aggression: 0.5,
    reactionTicks: 14,
    aimErrorRad: 0.04,
    manoeuvreWeights: { tail: 0.3, attackRun: 0.2, break: 0.3, orbit: 1.0, kite: 0.4, fallBack: 0.5, flee: 0.2, screen: 0.6 },
    moraleWeights: { fightOn: 0.7, fallBack: 0.2, flee: 0.1 },
  }),
  // Artillery: kites at long range, never wants to be close.
  missileBoat: profile({
    sensorRangeMul: 2,
    rangeBand: { min: 0.6, max: 1.0 },
    aggression: 0.3,
    reactionTicks: 16,
    aimErrorRad: 0.08,
    manoeuvreWeights: { tail: 0.1, attackRun: 0.1, break: 0.5, orbit: 0.4, kite: 1.0, fallBack: 0.7, flee: 0.4, screen: 0.2 },
    moraleWeights: { fightOn: 0.4, fallBack: 0.4, flee: 0.2 },
  }),
  // Warships: fire range is already the main battery's reach, so 1.5× is far.
  capital: profile({
    sensorRangeMul: 1.5,
    rangeBand: { min: 0.6, max: 0.95 },
    aggression: 0.5,
    reactionTicks: 30,
    aimErrorRad: 0.02,
    manoeuvreWeights: { tail: 0, attackRun: 0, break: 0, orbit: 0.6, kite: 0.3, fallBack: 0.2, flee: 0.05, screen: 0.3 },
    moraleWeights: { fightOn: 0.9, fallBack: 0.08, flee: 0.02 },
  }),
  // Machine swarm: relentless, no fear, circles its prey.
  robot: profile({
    sensorRangeMul: 3.5,
    rangeBand: { min: 0.3, max: 0.8 },
    aggression: 0.9,
    reactionTicks: 12,
    aimErrorRad: 0.06,
    manoeuvreWeights: { tail: 0.6, attackRun: 0.5, break: 0.2, orbit: 0.8, kite: 0.1, fallBack: 0.1, flee: 0, screen: 0.3 },
    moraleWeights: { fightOn: 0.95, fallBack: 0.05, flee: 0 },
  }),
  // Haulers / pods: avoid fights, run for it.
  civilian: profile({
    sensorRangeMul: 2,
    rangeBand: { min: 0.8, max: 1.0 },
    aggression: 0.05,
    reactionTicks: 20,
    aimErrorRad: 0.12,
    manoeuvreWeights: { tail: 0, attackRun: 0, break: 0.6, orbit: 0, kite: 0.3, fallBack: 0.6, flee: 1.0, screen: 0 },
    moraleWeights: { fightOn: 0.1, fallBack: 0.3, flee: 0.6 },
  }),
});

/** The tactics profile for `role`. */
export function roleProfile(role: AiRole): RoleProfile {
  return ROLE_PROFILES[role];
}

/** Sensor range (world units) for a ship of `role` whose fire range is
 *  `fireRange`. Floored at `ON_SIGHT_ENGAGE_RANGE` so the cap never drops a
 *  contact the on-sight stance would engage. */
export function roleSensorRange(role: AiRole, fireRange: number): number {
  const r = ROLE_PROFILES[role].sensorRangeMul * fireRange;
  return r > ON_SIGHT_ENGAGE_RANGE ? r : ON_SIGHT_ENGAGE_RANGE;
}
