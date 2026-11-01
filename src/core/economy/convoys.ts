/**
 * Trade between NPC bases (plan soft-leaping-truffle v3, phase T2). Pure,
 * zone-blind planning: which base needs what, which base has it to spare, and
 * which convoys to send. The server's ConvoyDirector flies them.
 *
 * Rates are units per MINUTE, read from a base's own structures (processor
 * recipes, Reactor fuel, ammo turrets, drills). A base:
 *  - NEEDS an input when its stock falls below LOW_WATER_FRAC of
 *    TARGET_MINUTES of use; the convoy refills it to the target;
 *  - OFFERS anything it holds beyond TARGET_MINUTES of its own use, when that
 *    spare is at least MIN_LOAD_WEIGHT (a hauler doesn't fly for a crumb).
 * The matcher serves the most-starved importer first, from the nearest
 * exporter (galaxy hops), capped by a hauler's capacity. Deterministic.
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId } from '../../shared-types/goods.js';

/** Minutes of use a base keeps in stock. */
export const TARGET_MINUTES = 10;
/** A base asks for more below this fraction of its target. */
export const LOW_WATER_FRAC = 0.5;
/** The least spare weight worth a convoy. */
export const MIN_LOAD_WEIGHT = 20;

export interface BaseTradeView {
  /** Unique id of the base (e.g. `<sectorKey>|<owner>`). */
  key: string;
  sectorKey: string;
  /** Goods on hand across the base's storage network. */
  stock: Partial<Record<GoodId, number>>;
  /** Free storage weight. */
  freeCapacity: number;
  /** Consumption, units per minute. */
  uses: Partial<Record<GoodId, number>>;
  /** Production, units per minute. */
  makes: Partial<Record<GoodId, number>>;
}

export interface ConvoyPlan {
  from: string;
  to: string;
  good: GoodId;
  qty: number;
}

/** How many units of `g` the base wants delivered now (0 when it doesn't). */
export function needOf(b: BaseTradeView, g: GoodId): number {
  const use = b.uses[g] ?? 0;
  if (use <= 0) return 0;
  const target = Math.ceil(use * TARGET_MINUTES);
  const have = b.stock[g] ?? 0;
  if (have >= target * LOW_WATER_FRAC) return 0;
  const room = Math.floor(b.freeCapacity / Math.max(1e-9, GOOD_DEFS[g].weight));
  return Math.max(0, Math.min(target - have, room));
}

/** How many units of `g` the base can spare (0 when it can't). */
export function spareOf(b: BaseTradeView, g: GoodId): number {
  const have = b.stock[g] ?? 0;
  const keep = Math.ceil((b.uses[g] ?? 0) * TARGET_MINUTES);
  const spare = have - keep;
  if (spare <= 0) return 0;
  return spare * GOOD_DEFS[g].weight >= MIN_LOAD_WEIGHT ? spare : 0;
}

export interface MatchOptions {
  /** A hauler's cargo capacity (weight). */
  haulerCapacity: number;
  /** At most this many new convoys per plan. */
  maxConvoys: number;
  /** Galaxy hops between two sectors (Infinity = unreachable). */
  hops: (a: string, b: string) => number;
  /** `<to>|<good>` pairs already being delivered — not planned again. */
  inFlight?: ReadonlySet<string>;
}

/**
 * Plan convoys: for every (importer, good) need, most starved first, the
 * nearest exporter with spare sends up to a hauler-load. Never a base to
 * itself. Spare is reserved as it is planned, so two importers can't both
 * count on the same units.
 */
export function matchConvoys(bases: readonly BaseTradeView[], o: MatchOptions): ConvoyPlan[] {
  const spare = new Map<string, number>();
  const spareKey = (k: string, g: GoodId): string => `${k}|${g}`;
  for (const b of bases) for (const g of GOOD_IDS) {
    const s = spareOf(b, g);
    if (s > 0) spare.set(spareKey(b.key, g), s);
  }
  const needs: Array<{ b: BaseTradeView; g: GoodId; qty: number; fill: number }> = [];
  for (const b of bases) for (const g of GOOD_IDS) {
    if (o.inFlight?.has(`${b.key}|${g}`)) continue;
    const qty = needOf(b, g);
    if (qty <= 0) continue;
    const target = Math.ceil((b.uses[g] ?? 0) * TARGET_MINUTES);
    needs.push({ b, g, qty, fill: (b.stock[g] ?? 0) / Math.max(1, target) });
  }
  needs.sort((x, y) => x.fill - y.fill || (x.b.key < y.b.key ? -1 : x.b.key > y.b.key ? 1 : 0) || (x.g < y.g ? -1 : x.g > y.g ? 1 : 0));

  const plans: ConvoyPlan[] = [];
  for (const n of needs) {
    if (plans.length >= o.maxConvoys) break;
    let best: BaseTradeView | null = null;
    let bestHops = Infinity;
    for (const e of bases) {
      if (e.key === n.b.key) continue;
      if ((spare.get(spareKey(e.key, n.g)) ?? 0) <= 0) continue;
      const h = o.hops(e.sectorKey, n.b.sectorKey);
      if (h < bestHops || (h === bestHops && best !== null && e.key < best.key)) { best = e; bestHops = h; }
    }
    if (best === null || !Number.isFinite(bestHops)) continue;
    const k = spareKey(best.key, n.g);
    const cap = Math.floor(o.haulerCapacity / Math.max(1e-9, GOOD_DEFS[n.g].weight));
    const qty = Math.min(n.qty, spare.get(k)!, cap);
    if (qty <= 0) continue;
    spare.set(k, spare.get(k)! - qty);
    plans.push({ from: best.key, to: n.b.key, good: n.g, qty });
  }
  return plans;
}
