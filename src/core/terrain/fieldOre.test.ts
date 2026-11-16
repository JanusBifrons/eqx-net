import { describe, expect, it } from 'vitest';
import { SLICED } from './fieldLayout.js';
import {
  hotspotConc, hotspotsInBox, ORE_CELL, ORE_EDGE_DEPTH, ORE_TABLE, oreAt, oreAtField, oreForOutlines, oreSeed, visitCellHotspots,
  type OreConc,
} from './fieldOre.js';

const R = SLICED.radius;
const conc = (): OreConc => ({ ice: 0, crystal: 0 });

/** Count hotspots in a ring of cells (by cell centre's share of the field radius). */
function countHotspots(seed: string, rMin: number, rMax: number, minRadius: number): { spots: number; cells: number } {
  const base = oreSeed(seed);
  let spots = 0, cells = 0;
  const n = Math.ceil(R / ORE_CELL);
  for (let gy = -n; gy < n; gy++) for (let gx = -n; gx < n; gx++) {
    const mx = (gx + 0.5) * ORE_CELL, my = (gy + 0.5) * ORE_CELL;
    const r = Math.sqrt(mx * mx + my * my) / R;
    if (r < rMin || r >= rMax) continue;
    cells++;
    visitCellHotspots(base, R, gx, gy, (_x, _y, radius) => { if (radius >= minRadius) spots++; });
  }
  return { spots, cells };
}

describe('fieldOre: the cut field\'s ore map (F1a)', () => {
  it('no hotspot reaches past the 3×3 cells oreAt reads', () => {
    for (const row of ORE_TABLE) expect(row.radius[1] * (1 + ORE_EDGE_DEPTH)).toBeLessThanOrEqual(ORE_CELL);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 400; i++) pts.push([(i * 7919) % 60000 - 30000, (i * 104729) % 60000 - 30000]);
    const a = pts.map(([x, y]) => ({ ...oreAtField({ seed: 'look' }, x, y, conc()) }));
    const b = pts.map(([x, y]) => ({ ...oreAtField({ seed: 'look' }, x, y, conc()) }));
    const c = pts.map(([x, y]) => ({ ...oreAtField({ seed: 'other' }, x, y, conc()) }));
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('concentration is the peak at a hotspot centre and falls smoothly to 0 at its edge', () => {
    expect(hotspotConc(0, 0, 1000, 0.8, 0)).toBeCloseTo(0.8);
    expect(hotspotConc(500, 0, 1000, 0.8, 0)).toBeGreaterThan(hotspotConc(800, 0, 1000, 0.8, 0));
    expect(hotspotConc(1000, 0, 1000, 0.8, 0)).toBe(0);
    // Edge noise moves the edge out or in by up to ORE_EDGE_DEPTH.
    expect(hotspotConc(1100, 0, 1000, 0.8, 1)).toBeGreaterThan(0);
    expect(hotspotConc(700, 0, 1000, 0.8, -1)).toBe(0);
  });

  it('every hotspot oreAt sees peaks at its centre, and values stay in 0..1', () => {
    const spots = hotspotsInBox({ seed: 'look' }, -20000, -20000, 20000, 20000);
    expect(spots.length).toBeGreaterThan(5);
    const base = oreSeed('look'), out = conc();
    for (const h of spots) {
      oreAt(base, R, h.x, h.y, out);
      expect(out[h.resource]).toBeGreaterThanOrEqual(h.peak - 1e-9);
      expect(out.ice).toBeLessThanOrEqual(1);
      expect(out.crystal).toBeLessThanOrEqual(1);
    }
  });

  it('small pockets turn up all over; huge lodes crowd the middle (owner\'s loot table)', () => {
    const lode = Math.min(...ORE_TABLE.filter((r) => r.rolls === 1).map((r) => r.radius[0]));
    const core = countHotspots('look', 0, 0.4, lode), rim = countHotspots('look', 0.75, 1, lode);
    expect(core.spots / core.cells).toBeGreaterThan(0.3);
    expect(rim.spots / rim.cells).toBeLessThan(core.spots / core.cells / 4);
    const pocketsRim = countHotspots('look', 0.75, 1, 0);
    expect(pocketsRim.spots / pocketsRim.cells).toBeGreaterThan(0.5);
  });

  it('oreForOutlines gives each fan vertex exactly what oreAt gives at that point', () => {
    const base = oreSeed('look');
    const spot = hotspotsInBox({ seed: 'look' }, -20000, -20000, 20000, 20000).find((h) => h.radius > 1000)!;
    // Two rocks straddling the hotspot's edge: a triangle and a square.
    const r = spot.radius;
    const outlines = new Float32Array([
      3, spot.x, spot.y, spot.x + 200, spot.y, spot.x, spot.y + 200,
      4, spot.x + r * 0.8, spot.y, spot.x + r * 1.2, spot.y, spot.x + r * 1.2, spot.y + 300, spot.x + r * 0.8, spot.y + 300,
    ]);
    const ore = oreForOutlines(base, R, outlines);
    expect(ore.length).toBe((4 + 5) * 2);
    const pts: Array<[number, number]> = [
      [spot.x + 200 / 3, spot.y + 200 / 3], [spot.x, spot.y], [spot.x + 200, spot.y], [spot.x, spot.y + 200],
      [spot.x + r, spot.y + 150], [spot.x + r * 0.8, spot.y], [spot.x + r * 1.2, spot.y], [spot.x + r * 1.2, spot.y + 300], [spot.x + r * 0.8, spot.y + 300],
    ];
    const out = conc();
    pts.forEach(([x, y], v) => {
      oreAt(base, R, x, y, out);
      expect(ore[v * 2]).toBeCloseTo(out.ice, 5);
      expect(ore[v * 2 + 1]).toBeCloseTo(out.crystal, 5);
    });
    expect(ore[2 * 1 + (spot.resource === 'ice' ? 0 : 1)]).toBeGreaterThan(0);
  });

  it('most of the field is plain rock, with ice and crystal somewhere', () => {
    let plain = 0, ice = 0, crystal = 0;
    const out = conc(), base = oreSeed('look');
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 7919) % 200000) - 100000, y = ((i * 104729) % 200000) - 100000;
      oreAt(base, R, x, y, out);
      if (out.ice === 0 && out.crystal === 0) plain++;
      if (out.ice > 0) ice++;
      if (out.crystal > 0) crystal++;
    }
    expect(plain).toBeGreaterThan(2000);
    expect(ice).toBeGreaterThan(50);
    expect(crystal).toBeGreaterThan(50);
  });
});
