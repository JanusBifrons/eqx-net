/**
 * Playable base loop — Capital crates on the trade board. The board's own
 * packed-offer path (`TradeDirector.stockPacked` / `quotePacked`) sells a
 * FRESH crate (5,000 minerals inside) in its own slot; traders never buy one
 * back. The rules live here so the 900-line director only calls them.
 */
import { CAPITAL_STARTING_MINERALS } from '../../core/structures/structureGridConstants.js';
import { BASE_PRICES } from '../../shared-types/economy.js';
import type { Hold } from '../../shared-types/goods.js';
import type { PackedItem } from '../../shared-types/items.js';
import { capitalCrateItem } from '../structures/StructurePlacementSubsystem.js';

export const CAPITAL_CRATE_PRODUCT = 'structure:capital';
/** A Capital crate has its own board slot, so the ~25 other structures never
 *  crowd it off; one crate per offer. */
export const CAPITAL_OFFERS_ON_BOARD = 1;
export const CAPITAL_OFFER_MAX_QTY = 1;

/** Goods value of a fresh crate: the minerals inside at the base mineral
 *  price. `quotePacked` adds the trader markup, which outweighs the best
 *  reputation discount, so the price always sits above the minerals' worth. */
export function capitalCrateBillValue(): number {
  return CAPITAL_STARTING_MINERALS * BASE_PRICES.minerals;
}

/** The packed item a trader hands over for `product`: a Capital is a fresh
 *  one-of-a-kind crate with its full bank; anything else a plain item. */
export function traderPackedItem(product: string, quality: number): PackedItem {
  return product === CAPITAL_CRATE_PRODUCT ? capitalCrateItem(quality, CAPITAL_STARTING_MINERALS) : { product, quality };
}

export const CAPITAL_NOT_BOUGHT = 'Traders never buy a Capital crate back.';

/** Why traders refuse to buy the packed items `keys` (by product, or by uid
 *  for a one-of-a-kind item) out of `hold`, or null when nothing is refused. */
export function packedSellRefusal(hold: Hold, keys: readonly string[]): string | null {
  for (const key of keys) {
    const item = key === CAPITAL_CRATE_PRODUCT ? { product: key } : hold.packed?.find((p) => p.uid === key || p.product === key);
    if (item?.product === CAPITAL_CRATE_PRODUCT) return CAPITAL_NOT_BOUGHT;
  }
  return null;
}
