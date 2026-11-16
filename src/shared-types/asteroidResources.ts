/**
 * Asteroid resource types (plan soft-leaping-truffle v3, phase P1). What a
 * Miner gets from a rock depends on the rock: plain rock gives minerals, ice
 * gives ice, and crystal-veined rock gives minerals plus some crystal. Which
 * kinds a sector's field holds depends on its galaxy `features`.
 *
 * Pure data + a seeded roll (the RNG is injected). P2 wires it to asteroid
 * spawns (the asteroid's wire byte) and the Miner's yield.
 *
 * **Append-only:** `ASTEROID_RESOURCE_IDS` order will ride the wire.
 */
import { GOOD_DEFS, GOOD_IDS, type GoodId } from './goods.js';

export const ASTEROID_RESOURCE_IDS = ['rock', 'ice', 'crystal'] as const;
export type AsteroidResourceId = (typeof ASTEROID_RESOURCE_IDS)[number];

/** Sector features that change a field's mix (from `src/core/galaxy/galaxy.ts`). */
export type AsteroidFieldFeature = 'asteroid' | 'nebula' | 'minerals' | 'blackhole' | 'station';

/**
 * Of every 10 units a Miner extracts, how many of each good. Whole numbers so
 * the yield stays integer.
 */
export const ASTEROID_YIELD: Readonly<Record<AsteroidResourceId, Readonly<Partial<Record<GoodId, number>>>>> =
  Object.freeze({
    rock: { minerals: 10 },
    ice: { ice: 10 },
    crystal: { minerals: 8, crystal: 2 },
  });

/** Display names (no raw ids in player-facing text). */
export const ASTEROID_RESOURCE_NAMES: Readonly<Record<AsteroidResourceId, string>> = Object.freeze({
  rock: 'Rock',
  ice: 'Ice',
  crystal: 'Crystal-veined rock',
});

/** Relative weights of each kind in a sector's field. Every sector has some
 *  rock; features shift the mix. */
export function asteroidMixFor(features: readonly AsteroidFieldFeature[]): Record<AsteroidResourceId, number> {
  const mix = { rock: 80, ice: 15, crystal: 5 };
  if (features.includes('nebula')) mix.ice += 25;
  if (features.includes('minerals')) mix.crystal += 15;
  if (features.includes('blackhole')) mix.crystal += 20;
  return mix;
}

/** Pick an asteroid's kind for a sector. `u` is a uniform roll in [0, 1). */
export function rollAsteroidResource(u: number, features: readonly AsteroidFieldFeature[]): AsteroidResourceId {
  const mix = asteroidMixFor(features);
  const total = mix.rock + mix.ice + mix.crystal;
  let t = Math.min(Math.max(u, 0), 0.999999) * total;
  for (const id of ASTEROID_RESOURCE_IDS) {
    t -= mix[id];
    if (t < 0) return id;
  }
  return 'rock';
}

export function asteroidResourceIndex(id: AsteroidResourceId): number {
  return ASTEROID_RESOURCE_IDS.indexOf(id);
}

export function asteroidResourceFromIndex(i: number): AsteroidResourceId {
  return ASTEROID_RESOURCE_IDS[i] ?? 'rock';
}

/** A yield mix: of every 10 units mined, how much of each good. A kind's row is
 *  `ASTEROID_YIELD[kind]`; a cut-field rock's comes from the ore map at the
 *  point mined (`oreRow`). */
export type YieldRow = Readonly<Partial<Record<GoodId, number>>>;

const rowOf = (r: AsteroidResourceId | YieldRow): YieldRow => (typeof r === 'string' ? ASTEROID_YIELD[r] : r);

/** THE split of `drawn` mined units into goods by a yield row (minerals first,
 *  the rest shared by the other goods; floors). Every extractor uses it: the
 *  grid Miner, robot harvesters, the mining laser. Writes every good into the
 *  reused `out` (0 where none), so it allocates nothing (#14). */
export function yieldInto(y: YieldRow, drawn: number, out: Partial<Record<GoodId, number>>): Partial<Record<GoodId, number>> {
  const ym = y.minerals ?? 0;
  const minerals = Math.floor((drawn * ym) / 10);
  const rest = drawn - minerals;
  for (const g of GOOD_IDS) {
    if (g === 'minerals') { out.minerals = minerals; continue; }
    const share = y[g] ?? 0;
    if (share > 0) out[g] = Math.floor((rest * share) / (10 - ym));
    else if (out[g] !== undefined) out[g] = 0;
  }
  return out;
}

/** Does a row yield anything besides minerals? */
export function yieldHasGoods(y: YieldRow): boolean {
  for (const g of GOOD_IDS) if (g !== 'minerals' && (y[g] ?? 0) > 0) return true;
  return false;
}

/** The goods `drawn` units of a rock yield, as a fresh record of the non-zero
 *  goods (`yieldInto` for hot paths). */
export function asteroidYield(resource: AsteroidResourceId | YieldRow, drawn: number): Partial<Record<GoodId, number>> {
  const out = yieldInto(rowOf(resource), drawn, {});
  for (const g of GOOD_IDS) if (out[g] === 0) delete out[g];
  return out;
}

/** Cargo weight one mined unit of this rock becomes (so a hold can size a draw). */
export function asteroidYieldWeightPerUnit(resource: AsteroidResourceId | YieldRow): number {
  const y = rowOf(resource);
  let w = 0;
  for (const g of GOOD_IDS) w += ((y[g] ?? 0) / 10) * GOOD_DEFS[g].weight;
  return w;
}

/**
 * The yield row of a cut-field point from its ore concentrations (0..1 each,
 * `core/terrain/fieldOre.ts` `oreAt`): ice and crystal take their share of
 * every 10 units, minerals the rest, so plain rock is all minerals and a rich
 * spot mostly ore (owner: what you cut off decides what you get). Shares over
 * 10 together are scaled down. Into the reused `out`.
 */
export function oreRow(conc: { ice: number; crystal: number }, out: Partial<Record<GoodId, number>>): YieldRow {
  let ice = 10 * Math.min(Math.max(conc.ice, 0), 1);
  let crystal = 10 * Math.min(Math.max(conc.crystal, 0), 1);
  const t = ice + crystal;
  if (t > 10) { ice *= 10 / t; crystal *= 10 / t; }
  out.minerals = Math.max(0, 10 - ice - crystal);
  out.ice = ice;
  out.crystal = crystal;
  return out;
}
