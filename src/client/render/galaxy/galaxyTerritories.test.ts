import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, GALAXY_FACTIONS, axialToPixel, type GalaxySector } from '@core/galaxy/galaxy';
import {
  computeTerritories,
  factionColor,
  DEFAULT_FACTION_COLOR,
} from './galaxyTerritories';

function sec(key: string, region: string, q: number, r: number, neighbours: string[]): GalaxySector {
  return {
    key,
    name: key,
    description: '',
    region,
    hex: { q, r },
    neighbours,
    asteroidConfigKey: 'none',
    droneCount: 0,
    features: [],
    defaultSpawn: { x: 0, y: 0 },
  };
}

describe('computeTerritories', () => {
  it('groups the real galaxy into one contiguous territory per faction', () => {
    const territories = computeTerritories(GALAXY_SECTORS, 64);
    // One territory per faction (every faction is graph-contiguous by construction).
    expect(territories).toHaveLength(GALAXY_FACTIONS.length);
    const factionIds = territories.map((t) => t.factionId).sort();
    expect(factionIds).toEqual(GALAXY_FACTIONS.map((f) => f.id).sort());
  });

  it('every sector appears in exactly one territory, all members share the faction', () => {
    const territories = computeTerritories(GALAXY_SECTORS, 64);
    const all = territories.flatMap((t) => t.sectorKeys);
    expect(new Set(all).size).toBe(all.length); // no dupes
    expect(all.length).toBe(GALAXY_SECTORS.length); // covers every sector
    const regionOf = new Map(GALAXY_SECTORS.map((s) => [s.key, s.region]));
    for (const t of territories) {
      for (const key of t.sectorKeys) expect(regionOf.get(key)).toBe(t.factionId);
      expect(Number.isFinite(t.centroid.x)).toBe(true);
      expect(Number.isFinite(t.centroid.y)).toBe(true);
    }
  });

  it('the core territory holds the three core sectors', () => {
    const core = computeTerritories(GALAXY_SECTORS, 64).find((t) => t.factionId === 'core')!;
    expect(core).toBeDefined();
    expect([...core.sectorKeys].sort()).toEqual(['lyra-fringe', 'sol-prime', 'vega-reach']);
  });

  it('merges contiguous same-faction sectors and centroids their pixel positions', () => {
    const graph = [sec('a', 'fA', 0, 0, ['b']), sec('b', 'fA', 1, 0, ['a'])];
    const [t, ...rest] = computeTerritories(graph, 10);
    expect(rest).toHaveLength(0);
    expect(t.sectorKeys).toEqual(['a', 'b']);
    const pa = axialToPixel({ q: 0, r: 0 }, 10);
    const pb = axialToPixel({ q: 1, r: 0 }, 10);
    expect(t.centroid.x).toBeCloseTo((pa.x + pb.x) / 2, 6);
    expect(t.centroid.y).toBeCloseTo((pa.y + pb.y) / 2, 6);
  });

  it('splits NON-contiguous same-faction sectors into separate territories', () => {
    // a(fA) — b(fB) — c(fA): a and c share a faction but are separated by b,
    // so contiguity yields THREE territories (a alone, b alone, c alone).
    const graph = [
      sec('a', 'fA', 0, 0, ['b']),
      sec('b', 'fB', 1, 0, ['a', 'c']),
      sec('c', 'fA', 2, 0, ['b']),
    ];
    const territories = computeTerritories(graph, 10);
    expect(territories).toHaveLength(3);
    expect(territories.filter((t) => t.factionId === 'fA')).toHaveLength(2);
    for (const t of territories) expect(t.sectorKeys).toHaveLength(1);
  });
});

describe('factionColor', () => {
  it('returns a distinct colour for each real faction', () => {
    const colors = GALAXY_FACTIONS.map((f) => factionColor(f.id));
    expect(new Set(colors).size).toBe(GALAXY_FACTIONS.length);
  });

  it('falls back to the neutral default for an unknown faction', () => {
    expect(factionColor('not-a-faction')).toBe(DEFAULT_FACTION_COLOR);
  });
});
