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
import type { GoodId } from './goods.js';

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
