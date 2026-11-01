/**
 * The galaxy's current regional price factors (plan soft-leaping-truffle v3,
 * T3). The ConvoyDirector recomputes them from every NPC base's stock on its
 * planning pass (~15 s) and publishes them here; the TradeDirector reads them
 * when it quotes. In memory only: on boot every factor is 1 until the first
 * pass. Process-global, like `tradeSink`.
 */
import { getSector } from '../../core/galaxy/galaxy.js';
import type { GoodId } from '../../shared-types/goods.js';

let factors = new Map<string, Partial<Record<GoodId, number>>>();

export function setRegionalPrices(next: Map<string, Partial<Record<GoodId, number>>>): void {
  factors = next;
}

/** The price factor for `good` in the region of `sectorKey` (1 when unknown:
 *  a test room, no pass yet, or a good the region doesn't trade). */
export function regionalPriceFactor(sectorKey: string | null | undefined, good: GoodId): number {
  if (!sectorKey) return 1;
  const region = getSector(sectorKey)?.region;
  if (region === undefined) return 1;
  return factors.get(region)?.[good] ?? 1;
}

/** Test seam. */
export function resetRegionalPrices(): void {
  factors = new Map();
}
