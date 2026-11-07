/**
 * Solar-system sectors (Phase 4), switch ON: arrivals land in a gate pocket
 * (as if through its gate), a squad arrives together at ONE pocket, and the
 * Ancients' gates sit in their gate pockets. Switch off is today's layout
 * (locked by population.test.ts / alienGates tests).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Pop = typeof import('./population.js');
type Sites = typeof import('../../core/galaxy/sectorSites.js');
type Gates = typeof import('../../core/galaxy/alienGates.js');
let pop: Pop, sites: Sites, gates: Gates;

beforeAll(async () => {
  vi.stubEnv('EQX_SOLAR_SECTORS', '1');
  vi.resetModules();
  pop = await import('./population.js');
  sites = await import('../../core/galaxy/sectorSites.js');
  gates = await import('../../core/galaxy/alienGates.js');
});
afterAll(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const inGatePocket = (sectorKey: string, x: number, y: number): string | null => {
  for (const s of sites.sectorSites(sectorKey)) {
    if (s.kind === 'gate' && Math.hypot(x - s.x, y - s.y) <= s.r + 600) return s.id;
  }
  return null;
};

describe('solar-system sector arrivals', () => {
  it('a squad arrives together on the rim of ONE gate pocket, heading in', () => {
    const poses = ['a', 'b', 'c', 'd'].map((b) => pop.squadEdgePose('squad-1', 'sol-prime', b, 3));
    const pockets = new Set(poses.map((p) => inGatePocket('sol-prime', p.x, p.y)));
    expect(pockets.size).toBe(1);
    expect([...pockets][0]).toMatch(/^gate:/);
    let spread = 0;
    for (const a of poses) for (const b of poses) spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y));
    expect(spread).toBeLessThan(1500);
    // Heading into the pocket: velocity points at its centre.
    const site = sites.sectorSites('sol-prime').find((s) => s.id === [...pockets][0])!;
    const p = poses[0]!;
    expect((site.x - p.x) * p.vx + (site.y - p.y) * p.vy).toBeGreaterThan(0);
  });

  it('a lone arrival lands in a gate pocket too', () => {
    let i = 0;
    const rng = (): number => [0.1, 0.7, 0.3][i++ % 3]!;
    const p = pop.sectorEdgePose(rng, 'vega-reach');
    expect(inGatePocket('vega-reach', p.x, p.y)).toMatch(/^gate:/);
  });

  it("the Ancients' gates sit in their gate pockets", () => {
    for (const g of gates.alienGateSites('sol-prime')) {
      const pocket = sites.sectorSites('sol-prime').find((s) => s.id === `gate:${g.neighbour}`)!;
      expect(Math.hypot(g.x - pocket.x, g.y - pocket.y)).toBeLessThan(2);
    }
  });
});

describe('solar-system sector belts', () => {
  it('each belt pocket holds a mining field of rocks inside it, with unique ids', async () => {
    const reg = await import('../galaxy/GalaxyRegistry.js');
    const cfg = reg.resolveSectorConfig('sol-prime');
    const belts = sites.sectorSites('sol-prime').filter((s) => s.kind === 'belt');
    expect(belts.length).toBeGreaterThan(0);
    for (const b of belts) {
      const rocks = cfg.asteroidConfig.filter((a) => a.id.startsWith(`${b.id}-`));
      expect(rocks.length).toBeGreaterThanOrEqual(16);
      for (const r of rocks) expect(Math.hypot(r.x - b.x, r.y - b.y)).toBeLessThanOrEqual(b.r);
    }
    expect(new Set(cfg.asteroidConfig.map((a) => a.id)).size).toBe(cfg.asteroidConfig.length);
  });
});

describe('solar-system sector flocking', () => {
  it('a roaming squad flocks round the pocket it is in, not the sector origin', async () => {
    const lwd = await import('./LivingWorldDirector.js');
    const gate = sites.sectorSites('sol-prime').find((s) => s.kind === 'gate')!;
    expect(lwd.flockCentre('sol-prime', gate.x + 800, gate.y - 500)).toEqual({ x: gate.x, y: gate.y });
    expect(lwd.flockCentre('sol-prime', 300, -200)).toEqual({ x: 0, y: 0 }); // home pocket
  });
});
