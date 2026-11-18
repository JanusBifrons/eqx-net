import { describe, it, expect } from 'vitest';
import { CoarseFieldMap, COARSE_NAV_CELL, HeadingCoarseGraph, NAV_LANE_ENTRY_COST, NAV_TURN_STEP_COST } from './coarseField.js';
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

describe('HeadingCoarseGraph (navigation slice 11, capital commitment)', () => {
  /** 3 × 3 cells 1000 u apart; room 100 everywhere but `tight` cells (room 30). */
  function grid(tight: number[]): HeadingCoarseGraph {
    const m = new CoarseFieldMap();
    m.cols = 3; m.rows = 3;
    m.bestX = new Float32Array(9); m.bestY = new Float32Array(9); m.room = new Float32Array(9).fill(100);
    for (let i = 0; i < 9; i++) { m.bestX[i] = (i % 3) * 1000; m.bestY[i] = ((i / 3) | 0) * 1000; }
    for (const i of tight) m.room[i] = 30;
    m.clearance = 20;
    const g = new HeadingCoarseGraph();
    g.map = m; g.turnRadius = 50; // room 30 < 20 + 50: no turning there; 100 is room enough
    return g;
  }
  // Steps: k 0 +x, 1 −x, 2 +y, 3 −y; arrival code (node & 7) 0 = +x, 4 = −x, 2 = +y.
  it('in a lane cell only steps within 45° of the way in are open; open space turns freely', () => {
    const g = grid([4]);
    const inLaneGoingX = 4 * 8 + 0;
    expect(g.edgeTo(inLaneGoingX, 0)).toBe(5 * 8 + 0); // on forward
    expect(g.edgeTo(inLaneGoingX, 4)).toBe(8 * 8); // +x+y: 45°, into open space (one node)
    expect(g.edgeTo(inLaneGoingX, 1)).toBe(inLaneGoingX); // U-turn: closed
    expect(g.edgeTo(inLaneGoingX, 2)).toBe(inLaneGoingX); // 90°: closed
    const open = 0 * 8;
    expect(g.edgeTo(open, 2)).toBe(3 * 8); // 90° in open space: allowed, and open cells are one node
    expect(g.edgeTo(open, 4)).toBe(4 * 8 + 1); // into the lane: arrives pointing +x+y
    expect(g.startNode(4, -Math.PI / 2)).toBe(4 * 8 + 0); // in the lane: the nose counts
    expect(g.startNode(0, 2)).toBe(0); // in open space it doesn't
  });

  it('a turn in a lane costs turning radii per 45°, and entering a lane from open space costs more', () => {
    const g = grid([4]);
    const r = 50;
    expect(g.edgeCost(0, 2)).toBeCloseTo(1000, 3); // open space: turning is free
    expect(g.edgeCost(3 * 8, 0)).toBeCloseTo(1000 + NAV_LANE_ENTRY_COST * r, 3); // into the lane
    expect(g.edgeCost(4 * 8 + 0, 0)).toBeCloseTo(1000, 3); // straight out of it
    expect(g.edgeCost(4 * 8 + 0, 4)).toBeCloseTo(1000 * Math.SQRT2 + NAV_TURN_STEP_COST * r, 3); // 45° out of it
  });

  it('stepOf maps a ship angle to its compass step (0 faces +y)', () => {
    expect(HeadingCoarseGraph.stepOf(0)).toBe(2);
    expect(HeadingCoarseGraph.stepOf(-Math.PI / 2)).toBe(0);
    expect(HeadingCoarseGraph.stepOf(Math.PI / 2)).toBe(4);
    expect(HeadingCoarseGraph.stepOf(Math.PI)).toBe(6);
  });
});
