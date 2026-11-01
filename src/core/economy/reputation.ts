/**
 * Per-player reputation with each AI side (plan peppy-jumping-pinwheel P2).
 * Pure; the server's `EconomyStore` owns the values.
 *
 *  - traders: sets deal prices (±15 %) and whether they refuse you;
 *  - robots:  at ≥ ROBOT_TRUCE_AT they stop attacking you on sight;
 *  - drones:  positive standing spaces out the waves sent at your base.
 */
import {
  ECON_ALLEGIANCES,
  REP_MAX,
  REP_MIN,
  ROBOT_TRUCE_AT,
  TRADER_REFUSE_BELOW,
  type EconAllegiance,
} from '../../shared-types/economy.js';

export type RepTable = Record<EconAllegiance, number>;

export function neutralRep(): RepTable {
  const t = {} as RepTable;
  for (const a of ECON_ALLEGIANCES) t[a] = 0;
  return t;
}

export function clampRep(v: number): number {
  return Math.max(REP_MIN, Math.min(REP_MAX, Math.round(v)));
}

/** Apply a delta in place; returns the new (clamped) standing. */
export function applyRep(t: RepTable, a: EconAllegiance, delta: number): number {
  t[a] = clampRep(t[a] + delta);
  return t[a];
}

export function tradersRefuse(traderRep: number): boolean {
  return traderRep < TRADER_REFUSE_BELOW;
}

export function robotTruce(robotRep: number): boolean {
  return robotRep >= ROBOT_TRUCE_AT;
}

/** Max standing a single gift can buy. */
export const GIFT_REP_CAP = 150;
/** Recent gift value at which gifting is half as effective (diminishing returns). */
export const GIFT_HALF_VALUE = 2000;

/**
 * Standing bought by a gift worth `value` credits, given the value already
 * gifted to that side recently. 10 credits ≈ 1 point, halved for every
 * `GIFT_HALF_VALUE` of recent giving, capped per gift.
 */
export function giftRepGain(value: number, recentGiftValue: number): number {
  if (value <= 0) return 0;
  const raw = value / 10 / (1 + Math.max(0, recentGiftValue) / GIFT_HALF_VALUE);
  return Math.min(GIFT_REP_CAP, Math.max(1, Math.round(raw)));
}

/** Wave-dispatch spacing multiplier from drone standing: neutral or worse ⇒ 1,
 *  maximum standing ⇒ waves 3× rarer. */
export function waveIntervalFactor(droneRep: number): number {
  return 1 + 2 * (Math.max(0, Math.min(REP_MAX, droneRep)) / REP_MAX);
}
