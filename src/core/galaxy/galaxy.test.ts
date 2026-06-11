import { describe, it, expect } from 'vitest';
import {
  GALAXY_SECTORS,
  DEFAULT_SECTOR_KEY,
  getSector,
  getNeighbours,
  isNeighbour,
  getEntrySectors,
  isEntrySector,
  axialToPixel,
} from './galaxy.js';

describe('galaxy graph', () => {
  it('has exactly 7 sectors (1 centre + 6 outers)', () => {
    expect(GALAXY_SECTORS).toHaveLength(7);
  });

  it('default sector key resolves', () => {
    expect(getSector(DEFAULT_SECTOR_KEY)).toBeDefined();
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
        expect(b!.neighbours, `${bKey} should list ${a.key} as neighbour`).toContain(a.key);
      }
    }
  });

  it('no self-loops in the graph', () => {
    for (const sec of GALAXY_SECTORS) {
      expect(sec.neighbours).not.toContain(sec.key);
    }
  });

  it('sol-prime is the centre and has exactly 6 neighbours', () => {
    const sol = getSector('sol-prime');
    expect(sol).toBeDefined();
    expect(sol!.hex).toEqual({ q: 0, r: 0 });
    expect(sol!.neighbours).toHaveLength(6);
  });

  it('every outer sector has exactly 3 neighbours and is at hex distance 1 from sol-prime', () => {
    for (const sec of GALAXY_SECTORS) {
      if (sec.key === 'sol-prime') continue;
      expect(sec.neighbours, `${sec.key} should have 3 neighbours`).toHaveLength(3);
      // Axial hex distance: max(|q|, |r|, |q+r|)
      const dist = Math.max(Math.abs(sec.hex.q), Math.abs(sec.hex.r), Math.abs(sec.hex.q + sec.hex.r));
      expect(dist, `${sec.key} should be hex distance 1 from sol-prime`).toBe(1);
    }
  });

  it('every outer sector lists sol-prime as a neighbour', () => {
    for (const sec of GALAXY_SECTORS) {
      if (sec.key === 'sol-prime') continue;
      expect(sec.neighbours).toContain('sol-prime');
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

  describe('isNeighbour', () => {
    it('returns true for adjacent sectors', () => {
      expect(isNeighbour('sol-prime', 'orion-belt')).toBe(true);
      expect(isNeighbour('orion-belt', 'sol-prime')).toBe(true);
    });

    it('returns false for non-adjacent sectors', () => {
      // Two outers that share sol-prime but are NOT ring-adjacent.
      // orion-belt is at top; cygnus-arm is at bottom-right; they are 2 hexes apart on the ring.
      expect(isNeighbour('orion-belt', 'cygnus-arm')).toBe(false);
      expect(isNeighbour('orion-belt', 'kepler-spur')).toBe(false);
    });

    it('returns false for unknown source', () => {
      expect(isNeighbour('nonexistent', 'sol-prime')).toBe(false);
    });
  });

  describe('getNeighbours', () => {
    it('returns resolved sector entries', () => {
      const ns = getNeighbours('sol-prime');
      expect(ns).toHaveLength(6);
      expect(ns.every((s) => typeof s.key === 'string')).toBe(true);
    });

    it('returns empty array on unknown source', () => {
      expect(getNeighbours('nonexistent')).toEqual([]);
    });
  });

  describe('entry sectors (drone warp-in edge)', () => {
    it('getEntrySectors returns exactly the 6 ring outers (the map edge), never the centre', () => {
      const entry = getEntrySectors();
      expect(entry.length).toBe(6);
      const keys = entry.map((s) => s.key).sort();
      expect(keys).toEqual(
        GALAXY_SECTORS.filter((s) => s.key !== DEFAULT_SECTOR_KEY).map((s) => s.key).sort(),
      );
      expect(keys).not.toContain(DEFAULT_SECTOR_KEY);
    });

    it('isEntrySector is true for every outer + false for the centre', () => {
      expect(isEntrySector(DEFAULT_SECTOR_KEY)).toBe(false);
      for (const s of GALAXY_SECTORS) {
        expect(isEntrySector(s.key)).toBe(s.key !== DEFAULT_SECTOR_KEY);
      }
      expect(isEntrySector('not-a-sector')).toBe(false);
    });

    it('every entry sector is at hex distance 1 from the centre (the outermost ring)', () => {
      const dist = (h: { q: number; r: number }) =>
        (Math.abs(h.q) + Math.abs(h.r) + Math.abs(h.q + h.r)) / 2;
      for (const s of getEntrySectors()) expect(dist(s.hex)).toBe(1);
    });
  });

  describe('axialToPixel', () => {
    it('places sol-prime at origin', () => {
      const p = axialToPixel({ q: 0, r: 0 }, 50);
      expect(p).toEqual({ x: 0, y: 0 });
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
});
