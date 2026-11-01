/**
 * D1 (plan soft-leaping-truffle v3) — base profiles across the real galaxy.
 * A seed sweep checks the shape the user asked for: most bases modest, most
 * fenced, citadels only at region hearts, wealth rising toward the heart,
 * and roles following each sector's features.
 */
import { describe, expect, it } from 'vitest';
import { GALAXY_SECTORS } from '../galaxy/galaxy.js';
import { BASE_TIERS, baseProfileFor, contextForSector, type BaseProfile, type BaseTier } from './baseProfile.js';

const SEEDS = 200;
const all: Array<{ key: string; hops: number; maxHops: number; p: BaseProfile }> = [];
for (const s of GALAXY_SECTORS) {
  const ctx = contextForSector(s.key);
  for (let seed = 1; seed <= SEEDS; seed++) all.push({ key: s.key, hops: ctx.hopsFromHeart, maxHops: ctx.maxHops, p: baseProfileFor(ctx, seed * 7919 + s.key.length) });
}
const share = (pred: (x: (typeof all)[number]) => boolean) => all.filter(pred).length / all.length;

describe('baseProfileFor across the galaxy', () => {
  it('is deterministic per seed', () => {
    const ctx = contextForSector(GALAXY_SECTORS[3]!.key);
    expect(baseProfileFor(ctx, 42)).toEqual(baseProfileFor(ctx, 42));
  });

  it('most bases are modest: outposts are the majority and citadels are rare', () => {
    const tiers = Object.fromEntries(BASE_TIERS.map((t) => [t, share((x) => x.p.tier === t)])) as Record<BaseTier, number>;
    expect(tiers.outpost).toBeGreaterThan(0.5);
    expect(tiers.citadel).toBeLessThan(0.05);
    expect(tiers.citadel).toBeGreaterThan(0);
  });

  it('citadels only appear at a region heart', () => {
    for (const x of all) if (x.p.tier === 'citadel') expect(x.hops, x.key).toBe(0);
  });

  it('most bases are fenced', () => {
    expect(share((x) => x.p.fenced)).toBeGreaterThanOrEqual(0.8);
  });

  it('wealth rises toward the region heart', () => {
    const mean = (pred: (x: (typeof all)[number]) => boolean) => {
      const xs = all.filter(pred);
      return xs.reduce((n, x) => n + x.p.wealth, 0) / xs.length;
    };
    const heart = mean((x) => x.hops === 0);
    const edge = mean((x) => x.hops === x.maxHops);
    expect(heart).toBeGreaterThan(edge * 2);
  });

  it('roles follow features: stations trade, extraction sectors mine, assembly only at hearts', () => {
    const station = all.filter((x) => GALAXY_SECTORS.find((s) => s.key === x.key)!.features.includes('station'));
    const noExtraction = all.filter((x) => {
      const f = GALAXY_SECTORS.find((s) => s.key === x.key)!.features;
      return !f.some((g) => g === 'asteroid' || g === 'minerals' || g === 'nebula' || g === 'blackhole');
    });
    const extraction = all.filter((x) => !noExtraction.includes(x));
    const rate = (xs: typeof all, role: string) => xs.filter((x) => x.p.role === role).length / Math.max(1, xs.length);
    if (station.length > 0) expect(rate(station, 'trade')).toBeGreaterThan(rate(all, 'trade'));
    expect(rate(extraction, 'mining')).toBeGreaterThan(rate(noExtraction, 'mining'));
    for (const x of all) if (x.p.role === 'assembly') expect(x.hops, x.key).toBe(0);
  });

  it('every role appears somewhere in the galaxy', () => {
    for (const role of ['mining', 'refinery', 'workshop', 'manufactory', 'assembly', 'trade']) {
      expect(all.some((x) => x.p.role === role), role).toBe(true);
    }
  });
});
