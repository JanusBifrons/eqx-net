/**
 * Per-player standing with NPC factions (plan peppy-jumping-pinwheel P2;
 * factions F1). Pure; the server's `EconomyStore` owns the values.
 *
 * A player's table holds each NPC faction's view of them, −100..100 in 0.1
 * steps. The faction's policy (`shared-types/factions.ts`) decides what it
 * means:
 *  - traders: sets deal prices (±15 %) and whether they refuse you;
 *  - robots:  at ≥ their truce standing they stop attacking you on sight;
 *  - drones:  positive standing spaces out the waves sent at your base.
 */
import { ECON_ALLEGIANCES, REP_MAX } from '../../shared-types/economy.js';
import { clampStanding, defaultFactionPolicy } from '../../shared-types/factions.js';

/** NPC faction id → that faction's view of the player. Sparse: a missing
 *  faction is 0; the three original sides are always present. */
export type RepTable = Record<string, number>;

export function neutralRep(): RepTable {
  const t: RepTable = {};
  for (const a of ECON_ALLEGIANCES) t[a] = 0;
  return t;
}

export function clampRep(v: number): number {
  return clampStanding(v);
}

/** Apply a delta in place; returns the new (clamped) standing. */
export function applyRep(t: RepTable, faction: string, delta: number): number {
  t[faction] = clampRep((t[faction] ?? 0) + delta);
  return t[faction];
}

export function tradersRefuse(traderRep: number): boolean {
  return traderRep < defaultFactionPolicy('traders').refuseTradeBelow;
}

export function robotTruce(robotRep: number): boolean {
  return robotRep >= defaultFactionPolicy('robots').hostileBelow;
}

/** Max standing a single gift can buy. */
export const GIFT_REP_CAP = 15;
/** Recent gift value at which gifting is half as effective (diminishing returns). */
export const GIFT_HALF_VALUE = 2000;

/**
 * Standing bought by a gift worth `value` credits, given the value already
 * gifted to that side recently. 100 credits ≈ 1 point, halved for every
 * `GIFT_HALF_VALUE` of recent giving, at least 0.1 and capped per gift.
 */
export function giftRepGain(value: number, recentGiftValue: number): number {
  if (value <= 0) return 0;
  const raw = value / 10 / (1 + Math.max(0, recentGiftValue) / GIFT_HALF_VALUE);
  return Math.min(GIFT_REP_CAP, Math.max(1, Math.round(raw)) / 10);
}

/** Wave-dispatch spacing multiplier from drone standing: neutral or worse ⇒ 1,
 *  maximum standing ⇒ waves 3× rarer. */
export function waveIntervalFactor(droneRep: number): number {
  return 1 + 2 * (Math.max(0, Math.min(REP_MAX, droneRep)) / REP_MAX);
}
