/**
 * The traders' blueprint board (economy v2 W6, plan peppy-jumping-pinwheel).
 *
 * Traders keep `BLUEPRINT_OFFERS_ON_BOARD` blueprints for sale: mostly copies,
 * sometimes an original (`BOARD_ORIGINAL_CHANCE`). Each offer is ONE real
 * blueprint (pre-rolled, so what you see is what you get) and leaves the board
 * when bought. The board is galaxy-wide and regenerates after a restart (it is
 * not worth persisting). Buying/selling is instant and room-side (the room
 * owns the storage + wallet group): see `SectorRoom` `bp_*` handlers.
 */
import { randomUUID } from 'node:crypto';
import { blueprintProducts, blueprintQuality, makeBlueprint, productName } from '../../shared-types/blueprints.js';
import {
  TRADER_BP_BUY_FRAC, TRADER_BP_MARKUP, blueprintValue, type BpListing,
} from '../../shared-types/blueprintMarket.js';
import type { BlueprintItem } from '../../shared-types/items.js';
import { repPriceFactor } from '../../core/economy/market.js';

export const BLUEPRINT_OFFERS_ON_BOARD = 4;
export const BOARD_ORIGINAL_CHANCE = 0.1;
export const BLUEPRINT_OFFER_TTL_MS = 20 * 60 * 1000;

interface BoardBlueprint {
  offerId: string;
  bp: BlueprintItem;
  expiresAtMs: number;
}

/** What `playerId` pays for `bp` at trader standing `rep`. */
export function bpBuyPrice(bp: BlueprintItem, rep: number): number {
  return Math.max(1, Math.round((blueprintValue(bp) * TRADER_BP_MARKUP) / repPriceFactor(rep)));
}

/** What traders pay `playerId` for `bp` (0 ⇒ they won't buy it). */
export function bpSellPrice(bp: BlueprintItem, rep: number): number {
  if (bp.bound === true) return 0;
  return Math.round(blueprintValue(bp) * TRADER_BP_BUY_FRAC * repPriceFactor(rep));
}

export function listing(bp: BlueprintItem, id: string, price: number): BpListing {
  return {
    id,
    name: productName(bp.product),
    kind: bp.kind,
    runs: bp.runs,
    material: bp.material,
    output: bp.output,
    quality: blueprintQuality(bp),
    price,
  };
}

export class BlueprintMarket {
  private offers: BoardBlueprint[] = [];

  constructor(private readonly deps: { rng?: () => number; now?: () => number } = {}) {}

  private rng(): number {
    return (this.deps.rng ?? Math.random)();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Drop expired offers and restock the board. Control cadence. */
  refresh(): void {
    const now = this.now();
    this.offers = this.offers.filter((o) => o.expiresAtMs > now);
    const products = blueprintProducts();
    while (this.offers.length < BLUEPRINT_OFFERS_ON_BOARD && products.length > 0) {
      const product = products[Math.floor(this.rng() * products.length)]!;
      const kind = this.rng() < BOARD_ORIGINAL_CHANCE ? 'bpo' : 'bpc';
      const bp = makeBlueprint(product, kind, () => this.rng());
      if (blueprintValue(bp) <= 0) continue;
      this.offers.push({
        offerId: `bpo-${randomUUID().slice(0, 10)}`,
        bp,
        expiresAtMs: now + BLUEPRINT_OFFER_TTL_MS * (0.7 + this.rng() * 0.6),
      });
    }
  }

  /** The board at `rep` (prices are what the player pays). */
  offersFor(rep: number): BpListing[] {
    this.refresh();
    return this.offers.map((o) => listing(o.bp, o.offerId, bpBuyPrice(o.bp, rep)));
  }

  /** The offer's blueprint (a copy — the board keeps its own), or null. */
  peek(offerId: string): BlueprintItem | null {
    const o = this.offers.find((x) => x.offerId === offerId && x.expiresAtMs > this.now());
    return o ? { ...o.bp } : null;
  }

  /** Take the offer off the board (it was bought). */
  remove(offerId: string): void {
    this.offers = this.offers.filter((o) => o.offerId !== offerId);
  }
}

let market: BlueprintMarket | null = null;

/** The galaxy-wide board (lazily created). */
export function getBlueprintMarket(): BlueprintMarket {
  if (market === null) market = new BlueprintMarket();
  return market;
}

/** Test seam. */
export function setBlueprintMarket(m: BlueprintMarket | null): void {
  market = m;
}
