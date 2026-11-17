import { describe, it, expect } from 'vitest';
import { CoarseFieldMap, COARSE_NAV_CELL } from './coarseField.js';
import { GraphSearch, type SearchGoal } from './search.js';
import { SLICED, slicedFieldLanes, cutFieldPad, type ChunkOpts } from '../terrain/fieldLayout.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const battleship = getShipKind('battleship').radius;
const destroyer = getShipKind('destroyer').radius;
const fighter = getShipKind('fighter').radius;
const opts = (seed: string, extra: Partial<ChunkOpts> = {}): ChunkOpts => ({
  seed, battleshipLength: battleship * 2, fighterLength: fighter * 2, ...extra,
});

class CellGoal implements SearchGoal {
  target = -1;
  map!: CoarseFieldMap;
  isGoal(i: number): boolean { return i === this.target; }
  heuristic(i: number): number {
    const m = this.map, dx = m.bestX[i]! - m.bestX[this.target]!, dy = m.bestY[i]! - m.bestY[this.target]!;
    return Math.sqrt(dx * dx + dy * dy) * 0.999; // admissible: edges cost best-point distances
  }
}

describe('CoarseFieldMap (analytic coarse layer)', () => {
  for (const seed of ['look', 'far-zoom', 'nav-a']) {
    it(`seed ${seed}: a battleship fits each lane end to end, and can route along it`, () => {
      const m = new CoarseFieldMap();
      const o = opts(seed);
      m.build(o);
      const R = SLICED.radius;
      for (const ln of slicedFieldLanes({ seed, battleshipLength: o.battleshipLength })) {
        const dx = ln.n.y, dy = -ln.n.x; // lane direction
        const at = (t: number) => ({ x: ln.o.x + dx * t, y: ln.o.y + dy * t });
        for (let t = -R * 1.1; t <= R * 1.1; t += COARSE_NAV_CELL / 4) {
          const p = at(t), i = m.cellAt(p.x, p.y);
          if (i < 0) continue;
          expect(m.room[i]!).toBeGreaterThanOrEqual(battleship);
        }
        // Route from outside one end of the lane to outside the other.
        const a = at(-R * 1.05), b = at(R * 1.05);
        const s = new GraphSearch(), g = new CellGoal();
        g.map = m; g.target = m.cellAt(b.x, b.y);
        m.clearance = battleship;
        expect(s.search(m, m.cellAt(a.x, a.y), g)).toBe(g.target);
      }
    });
  }

  it('streets are closed to every capital and open to fighters', () => {
    const m = new CoarseFieldMap();
    const seed = 'look', o = opts(seed);
    m.build(o);
    const R = SLICED.radius, pad = cutFieldPad();
    const lanes = slicedFieldLanes({ seed, battleshipLength: o.battleshipLength });
    let solid = 0;
    for (let i = 0; i < m.cols * m.rows; i++) {
      const cx = m.originX + (i % m.cols + 0.5) * m.cell, cy = m.originY + (((i / m.cols) | 0) + 0.5) * m.cell;
      const r = Math.hypot(cx, cy), h = m.cell; // keep a cell clear of every open region's edge
      if (r > R - pad - h || r < SLICED.holeShare * R + h) continue;
      if (lanes.some((ln) => Math.abs((cx - ln.o.x) * ln.n.x + (cy - ln.o.y) * ln.n.y) < ln.half + pad + h)) continue;
      solid++;
      expect(m.room[i]!).toBeLessThan(destroyer);
      expect(m.room[i]!).toBeGreaterThanOrEqual(fighter);
    }
    expect(solid).toBeGreaterThan(1000);
  });

  it('a clearing is open to its edge', () => {
    const m = new CoarseFieldMap();
    m.build(opts('look', { clearings: [{ x: 60_000, y: -40_000, r: 12_000 }] }));
    expect(m.room[m.cellAt(60_000, -40_000)]!).toBeCloseTo(12_000, 0);
    m.clearance = battleship;
    expect(m.roomAt(60_000 + 12_000 - battleship, -40_000)).toBeCloseTo(battleship, 0);
  });

  it('a capital routes round or through the lanes; a fighter goes straighter (prints build ms + bytes)', () => {
    const m = new CoarseFieldMap();
    const t0 = performance.now();
    m.build(opts('look'));
    const ms = performance.now() - t0;
    const bytes = m.room.byteLength * 3;
    const s = new GraphSearch(), g = new CellGoal();
    g.map = m;
    const a = m.cellAt(-157_000, 20_000), b = m.cellAt(157_000, -20_000);
    g.target = b;
    m.clearance = battleship;
    expect(s.search(m, a, g)).toBe(b);
    const capital = s.cost(b), capExp = s.expanded;
    m.clearance = fighter;
    expect(s.search(m, a, g)).toBe(b);
    expect(s.cost(b)).toBeLessThanOrEqual(capital);
    console.log(`[nav coarse] ${m.cols}x${m.rows} cells, ${(bytes / 1024).toFixed(0)} KB, build ${ms.toFixed(1)} ms; ` +
      `across the field: battleship ${(capital / 1000).toFixed(0)} km (${capExp} expanded), fighter ${(s.cost(b) / 1000).toFixed(0)} km (${s.expanded} expanded)`);
  });
});
