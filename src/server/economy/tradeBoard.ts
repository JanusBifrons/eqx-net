/**
 * The trade board's offer roster — what the `TradeDirector` keeps on sale:
 * one SELL and one BUY offer per good, plus rotating packed offers
 * (structures, hulls, a fresh Capital crate) in their own slots. Pure: the
 * director owns the offers array and calls `restockBoard` on each rotation.
 */
import { randomUUID } from 'node:crypto';
import type { GoodId } from '../../shared-types/goods.js';
import { GOOD_IDS } from '../../shared-types/goods.js';
import { MAX_OFFER_QTY } from '../../shared-types/economy.js';
import { packedHullProducts, packedStructureProducts, parseProduct } from '../../shared-types/blueprints.js';
import { hullBillValue, packBillValue } from '../../shared-types/recipes.js';
import { isPlayableShipKindId } from '../../shared-types/shipKinds.js';
import { isStructureKindId } from '../../shared-types/structureKinds.js';
import type { Rng } from '../livingworld/population.js';
import { CAPITAL_CRATE_PRODUCT, CAPITAL_OFFERS_ON_BOARD, CAPITAL_OFFER_MAX_QTY, capitalCrateBillValue } from './capitalCrateTrade.js';

export interface BoardOffer {
  offerId: string;
  kind: 'sell' | 'buy';
  /** null on a packed-item offer. */
  good: GoodId | null;
  /** Economy v2 W4b — a packed structure on sale (`structure:<kind>`). */
  product?: string;
  maxQty: number;
  expiresAtMs: number;
}

/** Economy v2 W4b — packed-structure offers kept on the board, and their size. */
export const PACKED_OFFERS_ON_BOARD = 4;
export const PACKED_OFFER_MAX_QTY = 3;
/** Economy v2 W5b — packed-HULL offers kept on the board. */
export const PACKED_HULL_OFFERS_ON_BOARD = 2;
/** Trader-made packed items are solid mid quality. */
export const TRADER_PACKED_QUALITY = 50;

/** Goods value of a packed product's pack recipe (0 ⇒ not sellable). */
export function packedBillOf(product: string): number {
  if (product === CAPITAL_CRATE_PRODUCT) return capitalCrateBillValue();
  const { ns, id } = parseProduct(product);
  if (ns === 'structure' && isStructureKindId(id)) return packBillValue(id);
  if (ns === 'hull' && isPlayableShipKindId(id)) return hullBillValue(id);
  return 0;
}

/** Drop expired / emptied offers and top the board back up. Returns the new
 *  offers array (the input is not mutated). */
export function restockBoard(current: readonly BoardOffer[], rng: Rng, now: number, offerTtlMs: number): BoardOffer[] {
  const offers = current.filter((o) => o.expiresAtMs > now && o.maxQty > 0);
  const ttl = (): number => now + offerTtlMs * (0.7 + rng() * 0.6);
  // Keep one SELL and one BUY offer per good on the board.
  for (const good of GOOD_IDS) {
    for (const kind of ['sell', 'buy'] as const) {
      if (offers.some((o) => o.product === undefined && o.good === good && o.kind === kind)) continue;
      const cap = good === 'core' ? 20 : good === 'alloy' ? 120 : MAX_OFFER_QTY;
      const maxQty = Math.max(5, Math.round(cap * (0.4 + rng() * 0.6)));
      offers.push({ offerId: `of-${randomUUID().slice(0, 10)}`, kind, good, maxQty, expiresAtMs: ttl() });
    }
  }
  // Economy v2 W4b — traders also SELL packed structures (the user's ruling:
  // most players buy them rather than make them). A rotating handful.
  stockPacked(offers, rng, ttl, packedStructureProducts(), PACKED_OFFERS_ON_BOARD);
  // Economy v2 W5b — and packed HULLS (their own slots, so ~25 structure
  // kinds never crowd the 4 ships off the board).
  stockPacked(offers, rng, ttl, packedHullProducts(), PACKED_HULL_OFFERS_ON_BOARD);
  // Playable base loop — a FRESH Capital crate, in its own slot.
  stockPacked(offers, rng, ttl, [CAPITAL_CRATE_PRODUCT], CAPITAL_OFFERS_ON_BOARD, CAPITAL_OFFER_MAX_QTY);
  return offers;
}

/** Keep `slots` packed offers whose product is one of `all`. */
function stockPacked(offers: BoardOffer[], rng: Rng, ttl: () => number, all: readonly string[], slots: number, maxQty = PACKED_OFFER_MAX_QTY): void {
  const products = all.filter((p) => packedBillOf(p) > 0);
  let onBoard = offers.filter((o) => o.product !== undefined && products.includes(o.product)).length;
  for (let tries = 0; onBoard < slots && tries < 20 && products.length > 0; tries++) {
    const product = products[Math.floor(rng() * products.length)]!;
    if (offers.some((o) => o.product === product)) continue;
    const qty = 1 + Math.floor(rng() * maxQty);
    offers.push({ offerId: `of-${randomUUID().slice(0, 10)}`, kind: 'buy', good: null, product, maxQty: qty, expiresAtMs: ttl() });
    onBoard++;
  }
}
