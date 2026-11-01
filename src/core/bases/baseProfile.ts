/**
 * Base profiles (plan soft-leaping-truffle v3, phase D1). Pure: where a base
 * is decides what it is.
 *
 * - **Tier** (how big): outpost ~60 %, settlement ~28 %, stronghold ~10 %,
 *   citadel ~2 %. Citadels only at a region's heart; edge and entry sectors
 *   are mostly outposts.
 * - **Role** (what it does in the production chain): mining outpost,
 *   refinery, workshop (a short chain ending in a product it sells),
 *   manufactory, assembly works (rare, region hearts only), trade hub.
 *   Sector features drive it: asteroids, minerals and nebulae mean mining;
 *   stations and chokepoints mean trade; hearts mean manufacturing.
 * - **Wealth, level cap, fence** follow the tier and how central the sector is.
 *
 * The context comes from the galaxy graph (`contextForSector`) or is built by
 * hand for showcase rooms. Every roll is seeded, so a base is the same each
 * time it is generated.
 */
import { GALAXY_SECTORS, getSector, isEntrySector, type SectorFeature } from '../galaxy/galaxy.js';

export const BASE_TIERS = ['outpost', 'settlement', 'stronghold', 'citadel'] as const;
export type BaseTier = (typeof BASE_TIERS)[number];

/** Production-chain roles (the colony role arrives with cities, D3). */
export const BASE_ROLES = ['mining', 'refinery', 'workshop', 'manufactory', 'assembly', 'trade'] as const;
export type BaseRole = (typeof BASE_ROLES)[number];

/** Which chain stages each role runs (0 raw … 3 end products). A workshop runs
 *  two adjacent stages of one chain; the generator picks which. */
export const ROLE_STAGES: Readonly<Record<BaseRole, readonly number[]>> = Object.freeze({
  mining: [0],
  refinery: [1],
  workshop: [1, 2],
  manufactory: [2],
  assembly: [2, 3],
  trade: [],
});

export interface BaseContext {
  /** Region (faction) id the sector belongs to. */
  region: string;
  /** Hops from the region's heart (0 = the heart). */
  hopsFromHeart: number;
  /** The region's largest hop distance (normalises centrality). */
  maxHops: number;
  /** A galaxy entry (edge) sector. */
  isEntry: boolean;
  /** Borders another region (a chokepoint gateway). */
  isChokepoint: boolean;
  features: readonly SectorFeature[];
}

export interface BaseProfile {
  tier: BaseTier;
  role: BaseRole;
  /** NPC side that owns it (civilian bases are traders; military later). */
  ownerSide: 'traders' | 'robots' | 'drones';
  /** Construction budget the generator spends (minerals-equivalent). */
  wealth: number;
  /** Highest structure level the generator may upgrade to. */
  levelCap: number;
  fenced: boolean;
}

/** Wealth range per tier (minerals-equivalent spend). */
export const TIER_WEALTH: Readonly<Record<BaseTier, readonly [number, number]>> = Object.freeze({
  outpost: [2_000, 6_000],
  settlement: [8_000, 20_000],
  stronghold: [30_000, 60_000],
  citadel: [80_000, 140_000],
});

export const TIER_LEVEL_CAP: Readonly<Record<BaseTier, readonly [number, number]>> = Object.freeze({
  outpost: [1, 2],
  settlement: [2, 3],
  stronghold: [3, 4],
  citadel: [4, 5],
});

/** A seeded uniform stream (mulberry32): deterministic, integer state. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string, for seeding from ids. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pickWeighted<T extends string>(weights: Readonly<Record<T, number>>, u: number): T {
  let total = 0;
  for (const k in weights) total += weights[k];
  let t = u * total;
  let last: T | undefined;
  for (const k in weights) {
    last = k;
    t -= weights[k];
    if (t < 0) return k;
  }
  return last!;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A region's heart: the sector nearest the region's hex centroid. */
function regionHeart(region: string): string {
  const members = GALAXY_SECTORS.filter((s) => s.region === region);
  const cq = members.reduce((n, s) => n + s.hex.q, 0) / members.length;
  const cr = members.reduce((n, s) => n + s.hex.r, 0) / members.length;
  let best = members[0]!;
  let bestD = Infinity;
  for (const s of members) {
    const d = (s.hex.q - cq) ** 2 + (s.hex.r - cr) ** 2 + (s.hex.q - cq) * (s.hex.r - cr);
    if (d < bestD || (d === bestD && s.key < best.key)) {
      bestD = d;
      best = s;
    }
  }
  return best.key;
}

/** The base context of a galaxy sector (hops within its region via BFS). */
export function contextForSector(key: string): BaseContext {
  const sector = getSector(key);
  if (!sector) throw new Error(`unknown sector ${key}`);
  const region = sector.region;
  const heart = regionHeart(region);
  const dist = new Map<string, number>([[heart, 0]]);
  const queue = [heart];
  while (queue.length > 0) {
    const k = queue.shift()!;
    for (const n of getSector(k)!.neighbours) {
      const ns = getSector(n);
      if (!ns || ns.region !== region || dist.has(n)) continue;
      dist.set(n, dist.get(k)! + 1);
      queue.push(n);
    }
  }
  let maxHops = 0;
  for (const d of dist.values()) maxHops = Math.max(maxHops, d);
  return {
    region,
    hopsFromHeart: dist.get(key) ?? maxHops,
    maxHops: Math.max(1, maxHops),
    isEntry: isEntrySector(key),
    isChokepoint: sector.neighbours.some((n) => getSector(n)?.region !== region),
    features: sector.features,
  };
}

/**
 * The profile of one base. `seed` varies bases within a sector (a sector can
 * hold several).
 */
export function baseProfileFor(ctx: BaseContext, seed: number): BaseProfile {
  const rnd = seededRandom(seed);
  // Centrality: 1 at the heart, 0 at the region's edge.
  const c = 1 - Math.min(1, ctx.hopsFromHeart / ctx.maxHops);
  const heart = ctx.hopsFromHeart === 0;
  const edge = ctx.isEntry || c <= 0.01;

  const tier: BaseTier = pickWeighted<BaseTier>(
    heart
      ? { outpost: 10, settlement: 25, stronghold: 40, citadel: 25 }
      : edge
        ? { outpost: 88, settlement: 11, stronghold: 1, citadel: 0 }
        : { outpost: 58, settlement: 32, stronghold: 9 * c + 1, citadel: 0 },
    rnd(),
  );

  const f = ctx.features;
  const extraction = f.includes('asteroid') || f.includes('minerals') || f.includes('nebula') || f.includes('blackhole');
  const big = tier === 'stronghold' || tier === 'citadel';
  const role: BaseRole = pickWeighted<BaseRole>(
    {
      mining: extraction ? 40 * (1 - c * 0.6) : 4,
      refinery: (f.includes('minerals') || extraction ? 14 : 6) * (0.6 + c * 0.6),
      workshop: 20,
      manufactory: 6 + 14 * c,
      assembly: heart && big ? 18 : 0,
      trade: (f.includes('station') ? 30 : 4) + (ctx.isChokepoint ? 12 : 0),
    },
    rnd(),
  );

  const [w0, w1] = TIER_WEALTH[tier];
  const wealth = Math.round(lerp(w0, w1, rnd() * 0.6 + c * 0.4));
  const [l0, l1] = TIER_LEVEL_CAP[tier];
  const levelCap = rnd() < 0.5 + c * 0.5 ? l1 : l0;
  const fenced = rnd() < (tier === 'outpost' ? 0.75 : 0.97);

  return { tier, role, ownerSide: 'traders', wealth, levelCap, fenced };
}
