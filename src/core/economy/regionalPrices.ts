/**
 * Regional prices (plan soft-leaping-truffle v3, phase T3). Pure, zone-blind.
 *
 * Each galaxy region's NPC bases hold stock and use goods at known rates
 * (convoys.ts). A good's regional price factor compares the region's stock
 * with its TARGET_MINUTES of use:
 *  - short of it (a refinery was razed, convoys raided) → dearer;
 *  - a glut (a producing region with little local use) → cheaper.
 * factor = clamp(((stock + CUSHION) / (target + CUSHION)) ^ -EXP, MIN, MAX).
 * The cushion keeps a region that neither holds nor uses a good at 1.
 * Players profit by moving goods from a cheap region to a dear one.
 */
import { GOOD_IDS, type GoodId } from '../../shared-types/goods.js';
import { TARGET_MINUTES } from './convoys.js';

export const REGION_PRICE_MIN = 0.75;
export const REGION_PRICE_MAX = 1.5;
/** Units added to both sides of the ratio (small stocks don't swing wildly). */
export const REGION_PRICE_CUSHION = 50;
/** How strongly the ratio moves the price. */
export const REGION_PRICE_EXP = 0.35;

export interface RegionBase {
  region: string;
  stock: Partial<Record<GoodId, number>>;
  /** Consumption, units per minute. */
  uses: Partial<Record<GoodId, number>>;
}

/** The factor for a region holding `stock` of a good it uses `target` of. */
export function regionFactor(stock: number, target: number): number {
  const ratio = (Math.max(0, stock) + REGION_PRICE_CUSHION) / (Math.max(0, target) + REGION_PRICE_CUSHION);
  const f = Math.pow(ratio, -REGION_PRICE_EXP);
  return Math.min(REGION_PRICE_MAX, Math.max(REGION_PRICE_MIN, f));
}

/** Per region, per good: the price factor. Goods a region neither holds nor
 *  uses are omitted (factor 1). */
export function regionPriceFactors(bases: readonly RegionBase[]): Map<string, Partial<Record<GoodId, number>>> {
  const sums = new Map<string, { stock: Partial<Record<GoodId, number>>; target: Partial<Record<GoodId, number>> }>();
  for (const b of bases) {
    let s = sums.get(b.region);
    if (!s) { s = { stock: {}, target: {} }; sums.set(b.region, s); }
    for (const g of GOOD_IDS) {
      const n = b.stock[g] ?? 0;
      if (n > 0) s.stock[g] = (s.stock[g] ?? 0) + n;
      const u = b.uses[g] ?? 0;
      if (u > 0) s.target[g] = (s.target[g] ?? 0) + u * TARGET_MINUTES;
    }
  }
  const out = new Map<string, Partial<Record<GoodId, number>>>();
  for (const [region, s] of sums) {
    const f: Partial<Record<GoodId, number>> = {};
    for (const g of GOOD_IDS) {
      const stock = s.stock[g] ?? 0, target = s.target[g] ?? 0;
      if (stock <= 0 && target <= 0) continue;
      f[g] = Math.round(regionFactor(stock, target) * 1000) / 1000;
    }
    out.set(region, f);
  }
  return out;
}
