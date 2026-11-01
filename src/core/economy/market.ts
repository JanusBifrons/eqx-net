/**
 * Galaxy market (plan peppy-jumping-pinwheel P2). Pure, zone-blind, injected RNG.
 *
 * One market for the whole galaxy. Each good has a SUPPLY index measured in
 * credits of value: players selling to traders push it up (price falls),
 * players buying push it down (price rises). Supply mean-reverts toward 0 and
 * random-walks over time, so prices drift. Every fill moves the price, which is
 * the wash-trading defence: buying back what you just sold always costs more.
 */
import { GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import {
  BASE_PRICES,
  MARKET_SPREAD,
  PRICE_CEIL_MUL,
  PRICE_FLOOR_MUL,
  REP_MAX,
  REP_PRICE_SWING,
} from '../../shared-types/economy.js';

/** Credits-of-value of supply that moves a price by a factor of e. */
export const SUPPLY_SCALE = 10_000;
/** Supply half-life toward neutral (mean reversion). */
export const SUPPLY_HALF_LIFE_MS = 2 * 60 * 60 * 1000;
/** Random-walk noise per drift step, in credits of value per good. */
export const DRIFT_NOISE = 400;

export interface MarketState {
  supply: Record<GoodId, number>;
  updatedAtMs: number;
}

export function createMarket(nowMs: number): MarketState {
  const supply = {} as Record<GoodId, number>;
  for (const g of GOOD_IDS) supply[g] = 0;
  return { supply, updatedAtMs: nowMs };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Mid-market price per unit. */
export function midPrice(m: MarketState, good: GoodId): number {
  const base = BASE_PRICES[good];
  const p = base * Math.exp(-m.supply[good] / SUPPLY_SCALE);
  return Math.min(base * PRICE_CEIL_MUL, Math.max(base * PRICE_FLOOR_MUL, p));
}

/** Trader standing → price factor in [1 − swing, 1 + swing]. */
export function repPriceFactor(rep: number): number {
  const r = Math.max(-REP_MAX, Math.min(REP_MAX, rep));
  return 1 + REP_PRICE_SWING * (r / REP_MAX);
}

/** What traders PAY the player per unit (player sells). Good rep pays more. */
export function quoteSell(m: MarketState, good: GoodId, traderRep: number): number {
  return round2(midPrice(m, good) * (1 - MARKET_SPREAD) * repPriceFactor(traderRep));
}

/** What the player PAYS per unit (player buys). Good rep pays less. */
export function quoteBuy(m: MarketState, good: GoodId, traderRep: number): number {
  return round2((midPrice(m, good) * (1 + MARKET_SPREAD)) / repPriceFactor(traderRep));
}

/** Economy v2 W4b — traders sell packed structures at the pack recipe's goods
 *  value times this markup (they did the manufacturing). */
export const PACKED_MARKUP = 1.3;

/** What the player PAYS for one packed item whose goods bill is worth
 *  `billValue` at base prices. Good rep pays less, like goods. */
export function quotePacked(billValue: number, traderRep: number): number {
  return round2((billValue * PACKED_MARKUP) / repPriceFactor(traderRep));
}

/** A settled fill moves supply: the player sold `qty` (supply up) or bought it (down). */
export function applyFill(m: MarketState, good: GoodId, qty: number, side: 'sell' | 'buy'): void {
  const value = qty * BASE_PRICES[good];
  m.supply[good] += side === 'sell' ? value : -value;
}

/**
 * Advance the market to `nowMs`: mean-revert each good's supply by the elapsed
 * half-life fraction, then add one bounded random-walk step. Called on a slow
 * cadence (minutes), never per tick.
 */
export function driftMarket(m: MarketState, nowMs: number, rng: () => number): void {
  const dt = nowMs - m.updatedAtMs;
  if (dt <= 0) return;
  const keep = Math.pow(0.5, dt / SUPPLY_HALF_LIFE_MS);
  for (const g of GOOD_IDS) {
    m.supply[g] = m.supply[g] * keep + (rng() * 2 - 1) * DRIFT_NOISE;
  }
  m.updatedAtMs = nowMs;
}
