import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, GALAXY_FACTIONS, axialToPixel, type GalaxySector } from '@core/galaxy/galaxy';
import {
  computeTerritories,
  factionColor,
  DEFAULT_FACTION_COLOR,
  factionBorderColor,
  DEFAULT_FACTION_BORDER_COLOR,
  boundaryEdges,
  HEX_EDGE_NEIGHBOUR_DIRS,
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

// Replicates GalaxyMapLayer.hexVertices EXACTLY (vertex angles 30°/90°/…/330°);
// the border port's correctness hinges on this matching the live layer.
function hexVerts(size: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    out.push({ x: size * Math.cos(a), y: size * Math.sin(a) });
  }
  return out;
}

describe('faction outer-edge outline', () => {
  it('HEX_EDGE_NEIGHBOUR_DIRS agrees with hexVertices edge order (each edge normal points at its neighbour)', () => {
    const v = hexVerts(64);
    for (let ei = 0; ei < 6; ei++) {
      const a = v[ei]!;
      const b = v[(ei + 1) % 6]!;
      // Edge midpoint (from centre) IS the edge's outward normal direction.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = HEX_EDGE_NEIGHBOUR_DIRS[ei]!;
      const np = axialToPixel({ q: d.q, r: d.r }, 64); // the neighbour's pixel direction
      const dot =
        (mid.x * np.x + mid.y * np.y) / (Math.hypot(mid.x, mid.y) * Math.hypot(np.x, np.y));
      expect(dot, `edge ${ei} normal must point at neighbour dir ${d.q},${d.r}`).toBeGreaterThan(0.99);
    }
  });

  it('boundaryEdges: a hex fully surrounded by its own faction has no border edges', () => {
    expect(boundaryEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, () => 'fA')).toEqual([]);
  });

  it('boundaryEdges: an isolated hex borders on all six edges', () => {
    const at = (q: number, r: number): string | null => (q === 0 && r === 0 ? 'fA' : null);
    expect(boundaryEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, at)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('boundaryEdges: one different-faction neighbour marks exactly that edge', () => {
    // The neighbour across edge 5 is (1,0); make only it a different faction.
    const at = (q: number, r: number): string | null => (q === 1 && r === 0 ? 'fB' : 'fA');
    expect(boundaryEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, at)).toEqual([5]);
  });
});

describe('factionBorderColor', () => {
  it('returns a distinct (brighter) colour per faction + a default for unknown', () => {
    const colors = GALAXY_FACTIONS.map((f) => factionBorderColor(f.id));
    expect(new Set(colors).size).toBe(GALAXY_FACTIONS.length);
    expect(factionBorderColor('not-a-faction')).toBe(DEFAULT_FACTION_BORDER_COLOR);
  });
});
