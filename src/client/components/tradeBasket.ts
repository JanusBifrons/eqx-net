/**
 * The dock trade window's basket (TradeMarket.tsx): pure maths, no React.
 * A basket is a list of lines (buy or sell, one item, a count, the unit
 * price). This decides whether the deal fits the hold and the wallet, what it
 * costs, and the `cargo_move` requests that carry it out (sells first, so
 * their room and credits are there for the buys). Weight is the shared
 * `holdWeight`, the same sum the server's hold clamp uses (#15).
 */
import { GOOD_IDS, type GoodId, type Hold } from '../../shared-types/goods';
import type { CargoItems } from '../../shared-types/messages/cargoMessages';
import { holdWeight } from '../../core/cargo/hold';

export type TradeDir = 'buy' | 'sell';

export interface TradeLine {
  dir: TradeDir;
  /** `g:<good>` or `p:<product>` (cargoRows' keys). */
  key: string;
  qty: number;
  /** Credits per unit: what you pay (buy) or get (sell). */
  unit: number;
}

/** "12¢" (whole credits) or "1.5¢" (cheap goods). */
export function credits(n: number): string {
  return Math.abs(n) >= 10 ? `${Math.round(n)}¢` : `${Math.round(n * 10) / 10}¢`;
}

/** Add `delta` units of `key` on side `dir` (a new line, or the old one
 *  grown / shrunk); a line that reaches 0 goes. Returns a new basket. */
export function bump(basket: readonly TradeLine[], dir: TradeDir, key: string, unit: number, delta: number): TradeLine[] {
  const i = basket.findIndex((l) => l.dir === dir && l.key === key);
  if (i < 0) return delta > 0 ? [...basket, { dir, key, qty: delta, unit }] : [...basket];
  const qty = basket[i]!.qty + delta;
  return qty > 0 ? basket.map((l, j) => (j === i ? { ...l, qty } : l)) : basket.filter((_, j) => j !== i);
}

/** How many of `key` the basket already moves on side `dir`. */
export function qtyIn(basket: readonly TradeLine[], dir: TradeDir, key: string): number {
  return basket.find((l) => l.dir === dir && l.key === key)?.qty ?? 0;
}

/** One side of the basket as a `cargo_move` request (empty = nothing). */
export function sideItems(basket: readonly TradeLine[], dir: TradeDir): CargoItems | null {
  const goods: Partial<Record<GoodId, number>> = {};
  const packed: string[] = [];
  for (const l of basket) {
    if (l.dir !== dir || l.qty <= 0) continue;
    if (l.key.startsWith('g:')) {
      const id = l.key.slice(2) as GoodId;
      if (GOOD_IDS.includes(id)) goods[id] = (goods[id] ?? 0) + l.qty;
    } else if (l.key.startsWith('p:')) {
      for (let n = 0; n < l.qty; n++) packed.push(l.key.slice(2));
    }
  }
  const hasGoods = Object.keys(goods).length > 0;
  if (!hasGoods && packed.length === 0) return null;
  return { ...(hasGoods ? { goods } : {}), ...(packed.length > 0 ? { packed } : {}) };
}

/** The deal's requests in send order: the sells, then the buys. */
export function tradeMoves(basket: readonly TradeLine[]): { dir: 'put' | 'take'; items: CargoItems }[] {
  const out: { dir: 'put' | 'take'; items: CargoItems }[] = [];
  const sells = sideItems(basket, 'sell');
  const buys = sideItems(basket, 'buy');
  if (sells !== null) out.push({ dir: 'put', items: sells });
  if (buys !== null) out.push({ dir: 'take', items: buys });
  return out;
}

/** The cargo weight one side of the basket moves. */
function sideWeight(basket: readonly TradeLine[], dir: TradeDir): number {
  const items = sideItems(basket, dir);
  if (items === null) return 0;
  const h: Hold = { goods: { ...items.goods }, blueprints: [] };
  if (items.packed) h.packed = items.packed.map((product) => ({ product, quality: 0 }));
  return holdWeight(h);
}

export interface TradeCheck {
  /** Credits you end up with after the deal: sells minus buys (negative = you pay). */
  net: number;
  /** The hold's weight after the deal. */
  holdAfter: number;
  /** Why it can't go through, or null when it can. */
  why: string | null;
  /** What the confirm button says. */
  verb: 'Purchase' | 'Sell' | 'Confirm';
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Does the deal fit the hold and the wallet? `wallet` null = unknown here
 *  (the server still checks). */
export function checkTrade(basket: readonly TradeLine[], shipUsed: number, shipCapacity: number, wallet: number | null): TradeCheck {
  let net = 0;
  let buys = 0;
  let sells = 0;
  for (const l of basket) {
    if (l.dir === 'buy') { net -= l.unit * l.qty; buys += l.qty; } else { net += l.unit * l.qty; sells += l.qty; }
  }
  const holdAfter = shipUsed + sideWeight(basket, 'buy') - sideWeight(basket, 'sell');
  const verb = buys > 0 && sells > 0 ? 'Confirm' : sells > 0 ? 'Sell' : 'Purchase';
  let why: string | null = null;
  if (holdAfter > shipCapacity + 1e-9) why = `Won't fit: needs ${round1(holdAfter - shipCapacity)} more space`;
  else if (wallet !== null && -net > wallet + 1e-9) why = `Can't pay: needs ${credits(-net - wallet)} more`;
  return { net, holdAfter, why, verb };
}
