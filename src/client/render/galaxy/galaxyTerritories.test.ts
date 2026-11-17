import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, GALAXY_FACTIONS, axialToPixel, type GalaxySector } from '@core/galaxy/galaxy';
import {
  computeTerritories,
  factionColor,
  DEFAULT_FACTION_COLOR,
  factionBorderColor,
  DEFAULT_FACTION_BORDER_COLOR,
  boundaryEdges,
  frontEdges,
  HEX_EDGE_NEIGHBOUR_DIRS,
  splitChallenger,
  threatBracketStyle,
  flipRingStrength,
  FLIP_RING_MS,
  isNewFlip,
  ownerHatched,
} from './galaxyTerritories';
import { teamColorOf, setFactionLooks } from '../../../shared-types/factions.js';
import type { SectorControl } from '../../../shared-types/galaxySnapshot.js';
import { resolveSectorOwner, NEUTRAL_OWNER } from './sectorOwnership';

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

// The v1 production resolver: every sector is neutral (no capture mechanics yet).
const neutralOwnerOf = (s: GalaxySector): string => resolveSectorOwner(s.key);

describe('computeTerritories', () => {
  it('groups the whole connected galaxy into ONE neutral territory (everything is neutral today)', () => {
    // Equinox Phase 9 item 1: grouping is DYNAMIC (owner-driven), and today every
    // sector is NEUTRAL → the whole contiguous galaxy is a single territory that
    // breathes/shrinks together (vs the old 4 hard-coded region clusters).
    const territories = computeTerritories(GALAXY_SECTORS, 64, neutralOwnerOf);
    expect(territories).toHaveLength(1);
    expect(territories[0]!.ownerId).toBe(NEUTRAL_OWNER);
    expect(territories[0]!.sectorKeys.length).toBe(GALAXY_SECTORS.length);
  });

  it('every sector appears in exactly one territory; centroid is finite', () => {
    const territories = computeTerritories(GALAXY_SECTORS, 64, neutralOwnerOf);
    const all = territories.flatMap((t) => t.sectorKeys);
    expect(new Set(all).size).toBe(all.length); // no dupes
    expect(all.length).toBe(GALAXY_SECTORS.length); // covers every sector
    for (const t of territories) {
      expect(Number.isFinite(t.centroid.x)).toBe(true);
      expect(Number.isFinite(t.centroid.y)).toBe(true);
    }
  });

  it('is DYNAMIC: grouping follows the ownerOf callback, NOT the baked region', () => {
    // Two sectors with the SAME baked region but DIFFERENT owners → two
    // territories. Proves grouping reads ownerOf, not GalaxySector.region (the
    // exact "still statically grouped" complaint).
    const graph = [sec('a', 'core', 0, 0, ['b']), sec('b', 'core', 1, 0, ['a'])];
    const territories = computeTerritories(graph, 10, (s) => (s.key === 'a' ? 'p1' : 'p2'));
    expect(territories).toHaveLength(2);
    expect(territories.map((t) => t.ownerId).sort()).toEqual(['p1', 'p2']);
    for (const t of territories) expect(t.sectorKeys).toHaveLength(1);
  });

  it('merges contiguous SAME-owner sectors and centroids their pixel positions', () => {
    // Different baked regions, but the resolver gives the SAME owner → one merged
    // territory (the future "contiguous captured run" case).
    const graph = [sec('a', 'rA', 0, 0, ['b']), sec('b', 'rB', 1, 0, ['a'])];
    const [t, ...rest] = computeTerritories(graph, 10, () => 'shared');
    expect(rest).toHaveLength(0);
    expect(t!.sectorKeys).toEqual(['a', 'b']);
    expect(t!.ownerId).toBe('shared');
    const pa = axialToPixel({ q: 0, r: 0 }, 10);
    const pb = axialToPixel({ q: 1, r: 0 }, 10);
    expect(t!.centroid.x).toBeCloseTo((pa.x + pb.x) / 2, 6);
    expect(t!.centroid.y).toBeCloseTo((pa.y + pb.y) / 2, 6);
  });

  it('splits NON-contiguous same-owner sectors into separate territories', () => {
    // a(o1) — b(o2) — c(o1): a and c share an owner but are separated by b,
    // so contiguity yields THREE territories (a alone, b alone, c alone).
    const graph = [
      sec('a', 'r', 0, 0, ['b']),
      sec('b', 'r', 1, 0, ['a', 'c']),
      sec('c', 'r', 2, 0, ['b']),
    ];
    const territories = computeTerritories(graph, 10, (s) => (s.key === 'b' ? 'o2' : 'o1'));
    expect(territories).toHaveLength(3);
    expect(territories.filter((t) => t.ownerId === 'o1')).toHaveLength(2);
    for (const t of territories) expect(t.sectorKeys).toHaveLength(1);
  });
});

describe('resolveSectorOwner (v1 — neutral seam)', () => {
  it('returns NEUTRAL_OWNER for every real sector today', () => {
    for (const s of GALAXY_SECTORS) expect(resolveSectorOwner(s.key)).toBe(NEUTRAL_OWNER);
  });
});

describe('factionColor', () => {
  it('returns a distinct colour for each real faction', () => {
    const colors = GALAXY_FACTIONS.map((f) => factionColor(f.id));
    expect(new Set(colors).size).toBe(GALAXY_FACTIONS.length);
  });

  it('neutral ground is the neutral grey', () => {
    expect(factionColor(NEUTRAL_OWNER)).toBe(DEFAULT_FACTION_COLOR);
  });

  it('delegates every owner to the ship colour authority (teamColorOf)', () => {
    for (const id of ['core', 'verdant-reach', 'crimson-expanse', 'azure-deep', 'robots', 'drones', 'player-abc']) {
      expect(factionColor(id)).toBe(teamColorOf(id));
    }
  });

  it('a player faction paints its picked colour', () => {
    setFactionLooks([{ factionId: 'player-picked', colorSlot: 3, sigil: 7 }]);
    try {
      expect(factionColor('player-picked')).toBe(teamColorOf('player-picked'));
      setFactionLooks([{ factionId: 'player-picked', colorSlot: 8, sigil: 7 }]);
      expect(factionColor('player-picked')).toBe(teamColorOf('player-picked'));
    } finally {
      setFactionLooks([]);
    }
  });

  it('only the drones are hatched', () => {
    expect(ownerHatched('drones')).toBe(true);
    expect(ownerHatched('robots')).toBe(false);
    expect(ownerHatched('core')).toBe(false);
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
    expect(factionBorderColor(NEUTRAL_OWNER)).toBe(DEFAULT_FACTION_BORDER_COLOR);
  });
});

describe('front seams', () => {
  it('frontEdges lists edges facing another owner, not the map edge', () => {
    // (1,0) across edge 5 is fB; (-1,0) across edge 2 is off-map; rest fA.
    const at = (q: number, r: number): string | null =>
      q === 1 && r === 0 ? 'fB' : q === -1 && r === 0 ? null : 'fA';
    expect(frontEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, at, [])).toEqual([5]);
    expect(boundaryEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, at)).toEqual([2, 5]);
  });

  it('both owners on a front draw the shared edge (a two-colour seam)', () => {
    const at = (q: number, _r: number): string | null => (q <= 0 ? 'fA' : 'fB');
    const out: number[] = [];
    for (const ei of frontEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, at, out).slice()) {
      const d = HEX_EDGE_NEIGHBOUR_DIRS[ei]!;
      const back = frontEdges({ hex: d, region: 'fB' }, at, out);
      expect(back).toContain((ei + 3) % 6);
    }
  });

  it('reuses and clears the scratch array', () => {
    const out = [9, 9, 9];
    expect(frontEdges({ hex: { q: 0, r: 0 }, region: 'fA' }, () => 'fA', out)).toBe(out);
    expect(out).toEqual([]);
  });
});

function ctl(over: Partial<SectorControl>): SectorControl {
  return { holderShare: 60, challenger: null, challengerShare: 0, trend: 0, threat: 0, flippedAtMs: null, locked: false, ...over };
}

describe('split hex', () => {
  it('splits only when a different challenger has a share', () => {
    expect(splitChallenger(undefined, 'core')).toBeNull();
    expect(splitChallenger(ctl({}), 'core')).toBeNull();
    expect(splitChallenger(ctl({ challenger: 'robots', challengerShare: 0 }), 'core')).toBeNull();
    expect(splitChallenger(ctl({ challenger: 'core', challengerShare: 30 }), 'core')).toBeNull();
    expect(splitChallenger(ctl({ challenger: 'robots', challengerShare: 30 }), 'core')).toBe('robots');
  });

  it('a neutral sector with a leader splits grey / leader', () => {
    expect(splitChallenger(ctl({ holderShare: 0, challenger: 'robots', challengerShare: 40 }), NEUTRAL_OWNER)).toBe('robots');
  });
});

describe('threat brackets', () => {
  it('no brackets when calm or missing', () => {
    expect(threatBracketStyle(0).corners).toEqual([]);
    expect(threatBracketStyle(undefined).corners).toEqual([]);
  });

  it('grow with threat 1..3 (corners, arm, width)', () => {
    const s = [1, 2, 3].map((t) => threatBracketStyle(t));
    expect(s.map((x) => x.corners.length)).toEqual([2, 4, 6]);
    expect(s[0]!.arm).toBeLessThan(s[1]!.arm);
    expect(s[1]!.arm).toBeLessThan(s[2]!.arm);
    expect(s[0]!.width).toBeLessThan(s[2]!.width);
    for (const x of s) for (const c of x.corners) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(6); }
  });

  it('returns shared styles (no allocation per call)', () => {
    expect(threatBracketStyle(2)).toBe(threatBracketStyle(2));
  });
});

describe('flip ring', () => {
  it('fades from 1 to 0 over FLIP_RING_MS', () => {
    expect(flipRingStrength(0)).toBe(1);
    expect(flipRingStrength(FLIP_RING_MS / 2)).toBeCloseTo(0.5);
    expect(flipRingStrength(FLIP_RING_MS)).toBe(0);
    expect(flipRingStrength(-1)).toBe(0);
  });

  it('marks a flip only when flippedAtMs changes after the first poll', () => {
    expect(isNewFlip(undefined, 5000)).toBe(false); // first poll: an old flip
    expect(isNewFlip(null, 5000)).toBe(true);
    expect(isNewFlip(4000, 5000)).toBe(true);
    expect(isNewFlip(5000, 5000)).toBe(false);
    expect(isNewFlip(5000, null)).toBe(false);
  });
});
