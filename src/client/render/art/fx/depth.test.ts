/**
 * Depth, scale and speed (plan iridescent-seeking-rainbow v4, round 2).
 */
import { describe, it, expect } from 'vitest';
import { DEPTH_LADDER, hashKey, landmarkScreen, nebulaCell, nebulaDensityAt, nebulaDensityAtSeed, nebulaRegions, visitNebulae, sectorSky, skyCell, SKY_LAYERS, SPEED_FX, speedFactor, visitSkyLayer, newSpeedFxState, stepSpeedFx, speedZoomFor } from './depth.js';

describe('depth ladder', () => {
  it('spreads from very far to in front of the world, far to near', () => {
    const behind = DEPTH_LADDER.filter((b) => b.parallax < 1);
    expect(Math.min(...behind.map((b) => b.parallax))).toBeLessThanOrEqual(0.01);
    expect(Math.max(...behind.map((b) => b.parallax))).toBeGreaterThanOrEqual(0.4);
    expect(DEPTH_LADDER.some((b) => b.parallax > 1)).toBe(true);
  });
});

describe('sectorSky', () => {
  it('is the same every visit and differs between sectors', () => {
    expect(sectorSky('sol-prime')).toEqual(sectorSky('sol-prime'));
    expect(sectorSky('sol-prime')).not.toEqual(sectorSky('vega-reach'));
  });

  it('crossing the sector carries nearby landmarks across the screen', () => {
    // Planets move by (camera travel × parallax): a 12 000 u run must move a
    // planet by more than a screen width, so the sky changes as you travel.
    const planet = ['emerald-span', 'sol-prime', 'vega-reach', 'a', 'b', 'c'].flatMap((k) => sectorSky(k)).find((l) => l.kind === 'planet')!;
    const a = { x: 0, y: 0, scale: 1 }, b = { x: 0, y: 0, scale: 1 };
    landmarkScreen(planet, 0, 0, 1, 0.3, 1280, 720, a);
    landmarkScreen(planet, 12_000, 0, 1, 0.3, 1280, 720, b);
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(1280);
  });
});

describe('nebula volumes', () => {
  it('density is 1 at a region core, 0 outside, and smooth between', () => {
    const regs = [{ x: 0, y: 0, r: 1000, variant: 'emission' as const, seed: 1 }];
    expect(nebulaDensityAt(0, 0, regs)).toBeCloseTo(1);
    expect(nebulaDensityAt(1500, 0, regs)).toBe(0);
    const mid = nebulaDensityAt(800, 0, regs);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('every sector gets 1 to 3 regions, seeded from its key', () => {
    for (const k of ['a', 'b', 'c', 'sol-prime']) {
      const r = nebulaRegions(k);
      expect(r.length).toBeGreaterThanOrEqual(1);
      expect(r.length).toBeLessThanOrEqual(3);
      expect(nebulaRegions(k)).toEqual(r);
    }
  });
});

describe('speed effects', () => {
  it('levels grow from off to large, and off does nothing', () => {
    expect(SPEED_FX.off).toEqual({ stretch: 0, zoomOut: 0, streakGain: 0 });
    expect(SPEED_FX.small.stretch).toBeLessThan(SPEED_FX.medium.stretch);
    expect(SPEED_FX.medium.zoomOut).toBeLessThan(SPEED_FX.large.zoomOut);
  });

  it('speedFactor clamps to 0..1', () => {
    expect(speedFactor(0)).toBe(0);
    expect(speedFactor(375)).toBeCloseTo(0.5);
    expect(speedFactor(5000)).toBe(1);
  });
});

describe('endless sky (sector size is arbitrary)', () => {
  it('a cell is the same every time; different sectors fill cells differently', () => {
    const a = { kind: 'planet', wx: 0, wy: 0, parallax: 0, size: 0, tint: 0, seed: 0 } as import('./depth.js').Landmark;
    const b = { ...a };
    const filled = (seed: number): string => {
      let s = '';
      for (let i = 0; i < 40; i++) s += skyCell(seed, 3, i, -i, a) ? '1' : '0';
      return s;
    };
    expect(skyCell(hashKey('sky:x'), 3, 4, 5, a)).toBe(skyCell(hashKey('sky:x'), 3, 4, 5, b));
    expect(a).toEqual(b);
    expect(filled(hashKey('sky:sol'))).not.toBe(filled(hashKey('sky:vega')));
  });

  it('landmarks keep coming however far you fly, at about the same density', () => {
    const seed = hashKey('sky:any');
    const scratch = { kind: 'planet', wx: 0, wy: 0, parallax: 0, size: 0, tint: 0, seed: 0 } as import('./depth.js').Landmark;
    const countAround = (cx: number): number => {
      let n = 0;
      for (let k = 0; k < 40; k++) {
        for (let li = 0; li < SKY_LAYERS.length; li++) visitSkyLayer(seed, li, cx + k * 9000, 0, 1, 1280, 720, scratch, () => { n++; });
      }
      return n / 40;
    };
    const near = countAround(0), far = countAround(1_000_000);
    expect(far).toBeGreaterThan(0);
    expect(Math.abs(near - far) / Math.max(near, far)).toBeLessThan(0.35);
  });
});

describe('endless nebula volumes (C2)', () => {
  const region = () => ({ x: 0, y: 0, r: 0, variant: 'emission' as const, seed: 0 }) as import('./depth.js').NebulaRegion;
  it('regions keep coming however far you fly, and a core is full density', () => {
    const seed = hashKey('neb:any');
    const g = region();
    let found = 0;
    for (let i = 0; i < 60; i++) if (nebulaCell(seed, 100 + i, -50, g)) found++;
    expect(found).toBeGreaterThan(10); // ~40 % of cells, a million units out
    // Find one and check its density.
    for (let i = 0; !nebulaCell(seed, i, 3, g); i++);
    expect(nebulaDensityAtSeed(seed, g.x, g.y, region())).toBeCloseTo(1);
    expect(nebulaDensityAtSeed(seed, g.x + g.r * 1.05, g.y, region())).toBe(0);
  });

  it('visitNebulae finds the region you are in', () => {
    const seed = hashKey('neb:any');
    const g = region();
    for (let i = 0; !nebulaCell(seed, i, 0, g); i++);
    const cx = g.x, cy = g.y;
    let n = 0;
    visitNebulae(seed, cx, cy, 100, region(), () => { n++; });
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('speed effects state (C3)', () => {
  it('eases up to full speed in about 0.6 s and back down when stopping', () => {
    const st = newSpeedFxState();
    let x = 0, t = 0;
    stepSpeedFx(st, x, 0, t);
    const at = (ms: number): void => { while (t < ms) { t += 16; x += 900 * 0.016; stepSpeedFx(st, x, 0, t); } };
    at(160);
    expect(st.sf).toBeGreaterThan(0.2);
    expect(st.sf).toBeLessThan(0.6);
    at(1500);
    expect(st.sf).toBeGreaterThan(0.95);
    expect(st.vx).toBeGreaterThan(800);
    expect(Math.abs(st.vy)).toBeLessThan(1);
    for (let i = 0; i < 100; i++) { t += 16; stepSpeedFx(st, x, 0, t); }
    expect(st.sf).toBeLessThan(0.01);
  });

  it('ignores jumps (respawn, sector change) and re-primes after a hitch', () => {
    const st = newSpeedFxState();
    stepSpeedFx(st, 0, 0, 0);
    stepSpeedFx(st, 0, 0, 16);
    stepSpeedFx(st, 50_000, 0, 32); // a teleport
    expect(st.sf).toBe(0);
    stepSpeedFx(st, 90_000, 0, 1000); // a 1 s gap: re-prime, no speed
    expect(st.sf).toBe(0);
    stepSpeedFx(st, 90_000, 0, 1016);
    expect(st.sf).toBe(0);
  });

  it('large asks for up to 20 % zoom-out; off asks for none', () => {
    expect(speedZoomFor('large', 1)).toBeCloseTo(0.8, 10);
    expect(speedZoomFor('large', 0)).toBe(1);
    expect(speedZoomFor('off', 1)).toBe(1);
  });
});
