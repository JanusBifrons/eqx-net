import { describe, expect, it } from 'vitest';
import { ALIEN_GATE_EDGE_RADIUS, alienGateSite, alienGateSites } from './alienGates.js';
import { GALAXY_SECTORS, getSector } from './galaxy.js';
import { ALIEN_GATE } from '../../shared-types/structureKinds.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';

describe('alien gate sites (v4 A)', () => {
  it('every sector has one gate per neighbour', () => {
    for (const s of GALAXY_SECTORS) {
      expect(alienGateSites(s.key).map((g) => g.neighbour).sort()).toEqual([...s.neighbours].sort());
    }
  });

  it('twins face each other across the border', () => {
    for (const s of GALAXY_SECTORS) {
      for (const n of s.neighbours) {
        const here = alienGateSite(s.key, n)!;
        const there = alienGateSite(n, s.key)!;
        // Opposite bearings: the twin points straight back.
        expect(here.x).toBeCloseTo(-there.x, -1);
        expect(here.y).toBeCloseTo(-there.y, -1);
      }
    }
  });

  it('every gate sits inside the playable area', () => {
    const half = ALIEN_GATE.footprint.w / 2;
    for (const s of GALAXY_SECTORS) {
      for (const g of alienGateSites(s.key)) {
        expect(Math.abs(g.x) + half).toBeLessThanOrEqual(SECTOR_PLAYABLE_HALF_EXTENT);
        expect(Math.abs(g.y) + half).toBeLessThanOrEqual(SECTOR_PLAYABLE_HALF_EXTENT);
        expect(Math.hypot(g.x, g.y)).toBeCloseTo(ALIEN_GATE_EDGE_RADIUS, -1);
      }
    }
  });

  it("a sector's gates don't overlap each other", () => {
    const w = ALIEN_GATE.footprint.w;
    for (const s of GALAXY_SECTORS) {
      const gs = alienGateSites(s.key);
      for (let i = 0; i < gs.length; i++) {
        for (let j = i + 1; j < gs.length; j++) {
          const apart = Math.abs(gs[i]!.x - gs[j]!.x) >= w || Math.abs(gs[i]!.y - gs[j]!.y) >= w;
          expect(apart, `${s.key}: ${gs[i]!.neighbour} vs ${gs[j]!.neighbour}`).toBe(true);
        }
      }
    }
  });

  it('an unknown sector has no gates', () => {
    expect(getSector('nowhere')).toBeUndefined();
    expect(alienGateSites('nowhere')).toEqual([]);
  });
});
