/**
 * Solar-system sector pockets (plan prancy-squishing-donut Phase 4): checked
 * on every real galaxy sector.
 */
import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, getNeighbours, getSector, axialToPixel } from './galaxy.js';
import { sectorSites, nearestSite, SOLAR_HALF_EXTENT, POCKET_MIN_GAP, POCKET_MAX_GAP } from './sectorSites.js';

describe('sectorSites', () => {
  it('is deterministic per sector key', () => {
    for (const s of GALAXY_SECTORS) expect(sectorSites(s.key)).toEqual(sectorSites(s.key));
    expect(sectorSites('nowhere')).toEqual([]);
  });

  for (const sector of GALAXY_SECTORS) {
    it(`${sector.key}: home at the origin, a gate per neighbour, pockets 50-150 km apart, in bounds`, () => {
      const sites = sectorSites(sector.key);
      expect(sites[0]).toMatchObject({ id: 'home', kind: 'home', x: 0, y: 0 });
      // One gate pocket per neighbour, facing it.
      const gates = sites.filter((s) => s.kind === 'gate');
      const neighbours = getNeighbours(sector.key);
      expect(gates.map((g) => g.neighbour).sort()).toEqual(neighbours.map((n) => n.key).sort());
      for (const g of gates) {
        const a = axialToPixel(sector.hex, 1), b = axialToPixel(getSector(g.neighbour!)!.hex, 1);
        const want = Math.atan2(-(b.y - a.y), b.x - a.x), got = Math.atan2(g.y, g.x);
        expect(Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)))).toBeLessThan(0.01);
      }
      // Every kind beyond home and gates is present: belt(s), base, combat.
      for (const k of ['belt', 'base', 'combat'] as const) expect(sites.some((s) => s.kind === k), k).toBe(true);
      // Spacing + bounds.
      for (const s of sites) {
        expect(Math.abs(s.x) + s.r).toBeLessThanOrEqual(SOLAR_HALF_EXTENT);
        expect(Math.abs(s.y) + s.r).toBeLessThanOrEqual(SOLAR_HALF_EXTENT);
        let nearest = Infinity;
        for (const o of sites) {
          if (o === s) continue;
          const d = Math.hypot(o.x - s.x, o.y - s.y);
          nearest = Math.min(nearest, d);
          if (s.kind !== 'gate' || o.kind !== 'gate') expect(d, `${s.id}↔${o.id}`).toBeGreaterThanOrEqual(POCKET_MIN_GAP);
        }
        if (s.kind !== 'gate') expect(nearest, `${s.id} isolated`).toBeLessThanOrEqual(POCKET_MAX_GAP);
      }
    });
  }

  it('nearestSite finds the closest pocket of a kind', () => {
    const sites = sectorSites('sol-prime');
    expect(nearestSite(sites, 10, 10)?.id).toBe('home');
    const belt = sites.find((s) => s.kind === 'belt')!;
    expect(nearestSite(sites, belt.x + 100, belt.y, 'belt')?.id).toBe(belt.id);
  });
});

describe('alien gate site search at solar-system extents', () => {
  it('searches a window around the ideal site, not the whole ±200,000 u sector', async () => {
    const { alienGateCandidates } = await import('./alienGates.js');
    const site = { neighbour: 'x', x: 170_000, y: 20_000 };
    const c = alienGateCandidates(site, 800, 200_000);
    // The whole-sector grid was ~2.56 M candidates per gate (boot time + heap).
    expect(c.length).toBeLessThan(30_000);
    expect(c[0]).toEqual({ x: 170_000, y: 20_000 });
    for (const p of c) expect(Math.abs(p.x)).toBeLessThanOrEqual(200_000 - 800);
  });
  it('is unchanged for today’s 5,000 u sectors (the window covers them)', async () => {
    const { alienGateCandidates } = await import('./alienGates.js');
    const c = alienGateCandidates({ neighbour: 'x', x: 4100, y: 0 }, 800, 5000);
    const lim = Math.floor((5000 - 800) / 250) * 250;
    expect(c.length).toBe(((2 * lim) / 250 + 1) ** 2 + 1);
  });
});
