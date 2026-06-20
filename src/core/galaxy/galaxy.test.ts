import { describe, it, expect } from 'vitest';
import {
  GALAXY_SECTORS,
  GALAXY_FACTIONS,
  ENTRY_SECTOR_KEYS,
  DEFAULT_SECTOR_KEY,
  getSector,
  getFaction,
  getNeighbours,
  isNeighbour,
  getEntrySectors,
  isEntrySector,
  axialToPixel,
  type AxialHex,
} from './galaxy.js';

/** Current baked sector count (Living Galaxy P1). The galaxy is "tunable 20-25";
 *  bump this when scripts/generate-galaxy.ts is re-run with a different size. */
const EXPECTED_SECTOR_COUNT = 21;

/** The home/core faction id (the rest are frontier regions). */
const CORE_FACTION = 'core';

/** Keys that pre-date the multi-region expansion and MUST survive — they are
 *  persistence identities (game_snapshots.sector_id + roster last_sector_key). */
const LEGACY_KEYS = [
  'sol-prime',
  'orion-belt',
  'vega-reach',
  'cygnus-arm',
  'kepler-spur',
  'andromeda-rim',
  'lyra-fringe',
];

const hexDistance = (a: AxialHex, b: AxialHex): number =>
  (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;

/** BFS over the galaxy graph, restricted to sectors `accept`s. */
function reachable(start: string, accept: (key: string) => boolean): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of getNeighbours(cur)) {
      if (seen.has(n.key) || !accept(n.key)) continue;
      seen.add(n.key);
      queue.push(n.key);
    }
  }
  return seen;
}

const frontierFactions = (): string[] =>
  GALAXY_FACTIONS.map((f) => f.id).filter((id) => id !== CORE_FACTION);

describe('galaxy graph', () => {
  it(`has the baked number of sectors (${EXPECTED_SECTOR_COUNT}, within the tunable 20-25 range)`, () => {
    expect(GALAXY_SECTORS).toHaveLength(EXPECTED_SECTOR_COUNT);
    expect(GALAXY_SECTORS.length).toBeGreaterThanOrEqual(20);
    expect(GALAXY_SECTORS.length).toBeLessThanOrEqual(25);
  });

  it('default sector key resolves and is the core hub at the origin', () => {
    const sol = getSector(DEFAULT_SECTOR_KEY);
    expect(sol).toBeDefined();
    expect(sol!.hex).toEqual({ q: 0, r: 0 });
    expect(sol!.region).toBe(CORE_FACTION);
  });

  it('preserves every legacy sector key (persistence identities)', () => {
    for (const k of LEGACY_KEYS) {
      expect(getSector(k), `legacy key '${k}' must still exist`).toBeDefined();
    }
  });

  it('every sector key is unique', () => {
    const keys = GALAXY_SECTORS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every hex coordinate is unique', () => {
    const coords = GALAXY_SECTORS.map((s) => `${s.hex.q},${s.hex.r}`);
    expect(new Set(coords).size).toBe(coords.length);
  });

  it('every neighbour key resolves to an existing sector (no dangling edges)', () => {
    for (const sec of GALAXY_SECTORS) {
      for (const nKey of sec.neighbours) {
        expect(getSector(nKey), `${sec.key} → ${nKey} dangles`).toBeDefined();
      }
    }
  });

  it('edges are symmetric (A→B implies B→A)', () => {
    for (const a of GALAXY_SECTORS) {
      for (const bKey of a.neighbours) {
        const b = getSector(bKey);
        expect(b, `${bKey} should exist`).toBeDefined();
        expect(b!.neighbours, `${bKey} should list ${a.key}`).toContain(a.key);
      }
    }
  });

  it('no self-loops in the graph', () => {
    for (const sec of GALAXY_SECTORS) {
      expect(sec.neighbours).not.toContain(sec.key);
    }
  });

  it('every sector has at least one neighbour', () => {
    for (const sec of GALAXY_SECTORS) {
      expect(sec.neighbours.length, `${sec.key} is isolated`).toBeGreaterThan(0);
    }
  });

  it('the whole graph is connected (reachable from sol-prime)', () => {
    const reached = reachable(DEFAULT_SECTOR_KEY, () => true);
    expect(reached.size).toBe(GALAXY_SECTORS.length);
  });

  it('every edge connects hex-adjacent sectors (no long lines on the map)', () => {
    for (const a of GALAXY_SECTORS) {
      for (const bKey of a.neighbours) {
        const b = getSector(bKey)!;
        expect(hexDistance(a.hex, b.hex), `${a.key} ↔ ${bKey} not hex-adjacent`).toBe(1);
      }
    }
  });
});

describe('factions / regions', () => {
  it('every sector belongs to a known faction', () => {
    for (const sec of GALAXY_SECTORS) {
      expect(getFaction(sec.region), `${sec.key} has unknown region '${sec.region}'`).toBeDefined();
    }
  });

  it('has a core faction plus >= 1 frontier faction, each with a display name', () => {
    expect(getFaction(CORE_FACTION)).toBeDefined();
    expect(frontierFactions().length).toBeGreaterThanOrEqual(1);
    for (const f of GALAXY_FACTIONS) {
      expect(f.displayName.length).toBeGreaterThan(0);
    }
  });

  it('every faction is graph-contiguous (the hover-shrink territory invariant)', () => {
    // A whole same-faction region must be reachable via same-faction neighbours
    // (P4 collects the territory by BFS over same-faction neighbours).
    for (const f of GALAXY_FACTIONS) {
      const members = GALAXY_SECTORS.filter((s) => s.region === f.id);
      if (members.length === 0) continue;
      const reached = reachable(members[0]!.key, (k) => getSector(k)!.region === f.id);
      expect(reached.size, `faction '${f.id}' is not contiguous`).toBe(members.length);
    }
  });

  it('each frontier region connects to the core through exactly one chokepoint', () => {
    for (const region of frontierFactions()) {
      let coreEdges = 0;
      for (const sec of GALAXY_SECTORS) {
        if (sec.region !== region) continue;
        for (const nKey of sec.neighbours) {
          if (getSector(nKey)!.region === CORE_FACTION) coreEdges++;
        }
      }
      expect(coreEdges, `region '${region}' should have exactly one core edge`).toBe(1);
    }
  });
});

describe('entry sectors (drone warp-in edge)', () => {
  it('ENTRY_SECTOR_KEYS is non-empty and every key resolves', () => {
    expect(ENTRY_SECTOR_KEYS.size).toBeGreaterThan(0);
    for (const k of ENTRY_SECTOR_KEYS) {
      expect(getSector(k), `entry key '${k}' must resolve`).toBeDefined();
    }
  });

  it('getEntrySectors returns exactly the baked entry set', () => {
    const got = getEntrySectors().map((s) => s.key).sort();
    expect(got).toEqual([...ENTRY_SECTOR_KEYS].sort());
  });

  it('isEntrySector matches set membership; unknown keys are false', () => {
    for (const s of GALAXY_SECTORS) {
      expect(isEntrySector(s.key)).toBe(ENTRY_SECTOR_KEYS.has(s.key));
    }
    expect(isEntrySector('not-a-sector')).toBe(false);
  });

  it('no entry sector is a core sector', () => {
    for (const k of ENTRY_SECTOR_KEYS) {
      expect(getSector(k)!.region, `entry '${k}' must not be core`).not.toBe(CORE_FACTION);
    }
  });

  it('every frontier region has at least one entry sector', () => {
    for (const region of frontierFactions()) {
      const entries = GALAXY_SECTORS.filter((s) => s.region === region && isEntrySector(s.key));
      expect(entries.length, `region '${region}' has no entry sector`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('lookups', () => {
  describe('isNeighbour', () => {
    it('returns true for adjacent sectors (incl. a chokepoint)', () => {
      expect(isNeighbour('sol-prime', 'vega-reach')).toBe(true);
      expect(isNeighbour('vega-reach', 'orion-belt')).toBe(true); // Verdant chokepoint
      expect(isNeighbour('orion-belt', 'vega-reach')).toBe(true);
    });

    it('returns false across a chokepoint barrier / for distant sectors', () => {
      // orion-belt reaches the core only via vega-reach, never sol-prime directly.
      expect(isNeighbour('orion-belt', 'sol-prime')).toBe(false);
      expect(isNeighbour('sol-prime', 'greenfall')).toBe(false);
    });

    it('#17 — Thornfield and Cygnus-Arm are NOT neighbours (different regions, no shared edge)', () => {
      // Smoke-report regression lock: a Thornfield → Cygnus-Arm jump was reported.
      // They share no galaxy-graph edge, so a same-tick jump is impossible; the
      // server rejects it (TransitOrchestrator not_neighbour). If anyone ever
      // links these two sectors this fails loudly, alongside the orchestrator lock.
      expect(isNeighbour('thornfield', 'cygnus-arm')).toBe(false);
      expect(isNeighbour('cygnus-arm', 'thornfield')).toBe(false);
    });

    it('returns false for unknown source', () => {
      expect(isNeighbour('nonexistent', 'sol-prime')).toBe(false);
    });
  });

  describe('getNeighbours', () => {
    it('returns resolved sector entries', () => {
      const ns = getNeighbours('sol-prime');
      expect(ns.length).toBeGreaterThan(0);
      expect(ns.every((s) => typeof s.key === 'string')).toBe(true);
    });

    it('returns empty array on unknown source', () => {
      expect(getNeighbours('nonexistent')).toEqual([]);
    });
  });

  describe('getFaction', () => {
    it('resolves a known faction and returns undefined otherwise', () => {
      expect(getFaction(CORE_FACTION)).toBeDefined();
      expect(getFaction('not-a-faction')).toBeUndefined();
    });
  });
});

describe('axialToPixel', () => {
  it('places sol-prime at origin', () => {
    expect(axialToPixel({ q: 0, r: 0 }, 50)).toEqual({ x: 0, y: 0 });
  });

  it('places (q=1, r=0) east of origin', () => {
    const p = axialToPixel({ q: 1, r: 0 }, 50);
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBe(0);
  });

  it('places (q=0, r=1) south of origin', () => {
    const p = axialToPixel({ q: 0, r: 1 }, 50);
    expect(p.y).toBeGreaterThan(0);
  });
});
