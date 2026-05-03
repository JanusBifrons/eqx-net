import { describe, it, expect } from 'vitest';
import { SpatialGrid, CELL_SIZE } from './SpatialGrid.js';

describe('SpatialGrid', () => {
  it('insert / query9 returns entities in the 3x3 window', () => {
    const g = new SpatialGrid();
    g.insert(1, 0, 0);
    g.insert(2, CELL_SIZE * 0.5, CELL_SIZE * 0.5); // same cell
    g.insert(3, CELL_SIZE * 1.5, 0); // adjacent cell to the right
    g.insert(4, CELL_SIZE * 4, 0);   // far away — outside 3x3 window of origin

    const out = new Set<number>();
    g.query9(0, 0, out);
    expect(out.has(1)).toBe(true);
    expect(out.has(2)).toBe(true);
    expect(out.has(3)).toBe(true);
    expect(out.has(4)).toBe(false);
  });

  it('move is a no-op when the entity stays in the same cell', () => {
    const g = new SpatialGrid();
    g.insert(1, 100, 100);
    const before = g.stats().cellCount;
    g.move(1, 200, 200);
    g.move(1, CELL_SIZE - 1, CELL_SIZE - 1); // still in cell (0, 0)
    expect(g.stats().cellCount).toBe(before);

    const out = new Set<number>();
    g.query9(0, 0, out);
    expect(out.has(1)).toBe(true);
  });

  it('move across a cell boundary updates membership', () => {
    const g = new SpatialGrid();
    g.insert(1, 100, 100);
    g.move(1, CELL_SIZE * 5, 0); // hop 5 cells east

    const farOut = new Set<number>();
    g.query9(5, 0, farOut);
    expect(farOut.has(1)).toBe(true);

    const originOut = new Set<number>();
    g.query9(0, 0, originOut);
    expect(originOut.has(1)).toBe(false);
  });

  it('remove drops the entity from membership and cleans empty buckets', () => {
    const g = new SpatialGrid();
    g.insert(1, 0, 0);
    g.insert(2, 0, 0);
    g.remove(1);
    expect(g.stats().entityCount).toBe(1);

    g.remove(2);
    expect(g.stats().entityCount).toBe(0);
    expect(g.stats().cellCount).toBe(0); // empty bucket cleaned up
  });

  it('query9 result equals brute-force scan over a synthetic 1000-entity set', () => {
    const g = new SpatialGrid();
    // Deterministic spread across ±10 cells (~ ±20_480 units).
    const positions: Array<[number, number]> = [];
    for (let i = 0; i < 1000; i++) {
      const x = ((i * 173) % 21) - 10;
      const y = ((i * 271) % 21) - 10;
      const px = x * CELL_SIZE + (i % CELL_SIZE);
      const py = y * CELL_SIZE + ((i * 7) % CELL_SIZE);
      positions.push([px, py]);
      g.insert(i, px, py);
    }

    const queryAt = (cx: number, cy: number): Set<number> => {
      const out = new Set<number>();
      g.query9(cx, cy, out);
      return out;
    };

    const bruteForce = (cx: number, cy: number): Set<number> => {
      const out = new Set<number>();
      for (let i = 0; i < positions.length; i++) {
        const [px, py] = positions[i]!;
        const ecx = Math.floor(px / CELL_SIZE);
        const ecy = Math.floor(py / CELL_SIZE);
        if (Math.abs(ecx - cx) <= 1 && Math.abs(ecy - cy) <= 1) out.add(i);
      }
      return out;
    };

    for (const [cx, cy] of [[0, 0], [3, -2], [7, 7], [-5, -5], [12, 0]] as Array<[number, number]>) {
      const a = queryAt(cx, cy);
      const b = bruteForce(cx, cy);
      expect(a.size).toBe(b.size);
      for (const id of b) expect(a.has(id)).toBe(true);
    }
  });

  it('clamps coords beyond ±32_000 instead of corrupting cell index', () => {
    const g = new SpatialGrid();
    g.insert(1, 1_000_000, 0);  // way out of bounds — clamped to 32_000
    const out = new Set<number>();
    g.query9(Math.floor(32_000 / CELL_SIZE), 0, out);
    expect(out.has(1)).toBe(true);
  });

  it('stats reports max cell population', () => {
    const g = new SpatialGrid();
    for (let i = 0; i < 5; i++) g.insert(i, 100, 100);
    g.insert(99, CELL_SIZE * 5, 0);
    const s = g.stats();
    expect(s.entityCount).toBe(6);
    expect(s.maxCellPopulation).toBe(5);
  });
});
