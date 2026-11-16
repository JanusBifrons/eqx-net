import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS, getSector } from './galaxy.js';
import { sectorSites } from './sectorSites.js';
import { galaxyNebula, isNebulaSector, NEBULA_SECTOR_SPACING, nebulaDensity, sectorGalaxyOrigin, sectorNebulaPeak } from './nebulaField.js';

const marked = GALAXY_SECTORS.filter((s) => s.features.includes('nebula')).map((s) => s.key);
const clear = GALAXY_SECTORS.filter((s) => !s.features.includes('nebula')).map((s) => s.key);

describe('nebula field (galaxy-placed nebulae)', () => {
  it('every nebula-marked sector is deep at its centre; the galaxy has some', () => {
    expect(marked.length).toBeGreaterThan(0);
    for (const k of marked) {
      expect(isNebulaSector(k)).toBe(true);
      expect(nebulaDensity(k, 0, 0), k).toBeGreaterThan(0.95);
    }
  });

  it('sectors with no nebula mark are clear everywhere (no fly-through cloud)', () => {
    for (const k of clear) expect(sectorNebulaPeak(k), k).toBe(0);
  });

  it('is continuous across a shared edge: the midpoint is the same point seen from both sides', () => {
    for (const k of marked) {
      const a = getSector(k)!, oa = sectorGalaxyOrigin(k)!;
      for (const nk of a.neighbours.filter((n) => isNebulaSector(n))) {
        const ob = sectorGalaxyOrigin(nk)!;
        const dx = ob.x - oa.x, dy = ob.y - oa.y;
        expect(Math.hypot(dx, dy)).toBeCloseTo(NEBULA_SECTOR_SPACING, 0);
        expect(nebulaDensity(k, dx / 2, dy / 2)).toBeCloseTo(nebulaDensity(nk, -dx / 2, -dy / 2), 9);
      }
    }
  });

  it('uses game axes: a neighbour lies the way its gate points (Y up)', () => {
    const k = marked[0]!;
    const o = sectorGalaxyOrigin(k)!;
    for (const g of sectorSites(k).filter((s) => s.kind === 'gate')) {
      const n = sectorGalaxyOrigin(g.neighbour!)!;
      const toward = Math.atan2(n.y - o.y, n.x - o.x), gate = Math.atan2(g.y, g.x);
      expect(Math.abs(Math.atan2(Math.sin(toward - gate), Math.cos(toward - gate)))).toBeLessThan(0.01);
    }
  });

  it('joined clouds: between two touching nebula sectors stays thick; toward open space it thins', () => {
    const pair = marked.flatMap((k) => getSector(k)!.neighbours.filter((n) => isNebulaSector(n)).map((n) => [k, n] as const))[0];
    expect(pair, 'the galaxy has touching nebula marks').toBeDefined();
    const [k, n] = pair!;
    const oa = sectorGalaxyOrigin(k)!, ob = sectorGalaxyOrigin(n)!;
    const between = galaxyNebula((oa.x + ob.x) / 2, (oa.y + ob.y) / 2);
    expect(between).toBeGreaterThan(0.75);
    const open = getSector(k)!.neighbours.find((m) => !isNebulaSector(m));
    if (open) {
      const oc = sectorGalaxyOrigin(open)!;
      expect(galaxyNebula((oa.x + oc.x) / 2, (oa.y + oc.y) / 2)).toBeLessThan(between - 0.15);
    }
  });

  it('a nebula sector has a nebula peak; off-galaxy keys are clear', () => {
    for (const k of marked) expect(sectorNebulaPeak(k)).toBeGreaterThan(0.95);
    expect(nebulaDensity('test-sector-fast', 0, 0)).toBe(0);
    expect(sectorNebulaPeak('nowhere')).toBe(0);
  });

  it('thinning (future gas extractors): thinner the more is taken, never empty, only inside the circle', () => {
    const k = marked[0]!;
    const full = nebulaDensity(k, 0, 0);
    const some = nebulaDensity(k, 0, 0, [{ x: 0, y: 0, r: 20_000, taken: 1 }]);
    const lots = nebulaDensity(k, 0, 0, [{ x: 0, y: 0, r: 20_000, taken: 8 }]);
    expect(some).toBeLessThan(full);
    expect(lots).toBeLessThan(some);
    expect(lots).toBeGreaterThan(0);
    expect(nebulaDensity(k, 30_000, 0, [{ x: 0, y: 0, r: 20_000, taken: 8 }])).toBe(nebulaDensity(k, 30_000, 0));
  });

  it('allocates nothing per query', () => {
    const k = marked[0]!;
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) return; // counted under `pnpm test:gc`
    let s = 0;
    for (let i = 0; i < 1000; i++) s += nebulaDensity(k, i, -i);
    gc(); const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200_000; i++) s += nebulaDensity(k, i * 3, -i);
    gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024);
    expect(s).toBeGreaterThan(0);
  });
});
