import { describe, it, expect } from 'vitest';
import { ClearanceGrid } from './clearance.js';
import type { GridObstacle } from '../structures/Grid.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Brute force: distance from each cell centre to the nearest blocked cell centre. */
function bruteForce(g: ClearanceGrid): Float64Array {
  const { cols, rows, cell } = g, n = cols * rows;
  const blocked: number[] = [];
  for (let i = 0; i < n; i++) if (g.dist[i] === 0) blocked.push(i);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % cols, y = (i / cols) | 0;
    let best = Infinity;
    for (const b of blocked) {
      const dx = (b % cols) - x, dy = ((b / cols) | 0) - y;
      best = Math.min(best, dx * dx + dy * dy);
    }
    out[i] = Math.sqrt(best) * cell;
  }
  return out;
}

describe('ClearanceGrid (exact distance transform)', () => {
  it('matches brute force exactly on random rock layouts', () => {
    const r = rng(5);
    const g = new ClearanceGrid();
    for (let trial = 0; trial < 40; trial++) {
      const cols = 8 + Math.floor(r() * 40), rows = 8 + Math.floor(r() * 40), cell = 64;
      const obs: GridObstacle[] = [];
      const count = Math.floor(r() * 8);
      for (let k = 0; k < count; k++) {
        obs.push({ x: r() * cols * cell, y: r() * rows * cell, radius: 30 + r() * 300 });
      }
      g.build(0, 0, cols, rows, cell, obs);
      const ref = bruteForce(g);
      for (let i = 0; i < cols * rows; i++) {
        if (ref[i] === Infinity) expect(g.dist[i]).toBe(Infinity);
        else expect(g.dist[i]).toBeCloseTo(ref[i]!, 2);
      }
    }
  });

  it('blocks a cell only when its centre is inside a convex part (turned by angle)', () => {
    // A 400×100 bar along local x, turned 90°: it should block a vertical strip.
    const bar = [{ x: -200, y: -50 }, { x: 200, y: -50 }, { x: 200, y: 50 }, { x: -200, y: 50 }];
    const g = new ClearanceGrid();
    g.build(-512, -512, 16, 16, 64, [{ x: 0, y: 0, radius: 210, parts: [bar], angle: Math.PI / 2 }]);
    expect(g.at(0, 150)).toBe(0);      // inside the turned bar
    expect(g.at(150, 0)).toBeGreaterThan(0); // inside the circle, outside the bar
    // Unturned, the same point is inside.
    g.build(-512, -512, 16, 16, 64, [{ x: 0, y: 0, radius: 210, parts: [bar] }]);
    expect(g.at(150, 0)).toBe(0);
  });

  it('a lane between two walls reads its half-width at the middle', () => {
    // Two solid rows of rock 10 cells apart: the middle cell is 5 cells from each.
    const obs: GridObstacle[] = [];
    for (let x = 0; x < 40; x++) {
      obs.push({ x: x * 64 + 32, y: 2 * 64 + 32, radius: 20 });
      obs.push({ x: x * 64 + 32, y: 12 * 64 + 32, radius: 20 });
    }
    const g = new ClearanceGrid();
    g.build(0, 0, 40, 16, 64, obs);
    expect(g.at(20 * 64 + 32, 7 * 64 + 32)).toBe(5 * 64);
    expect(g.blockedCount).toBe(80);
  });

  it('with nothing blocked every cell is Infinity', () => {
    const g = new ClearanceGrid();
    g.build(0, 0, 10, 10, 64, []);
    expect(g.at(100, 100)).toBe(Infinity);
    expect(g.blockedCount).toBe(0);
  });

  it('reuses its arrays once warm (#14) and prints ms per chunk', () => {
    // One fine chunk: 4096 u at 64 u cells = 64×64, with a dense rock patch.
    const r = rng(9);
    const obs: GridObstacle[] = [];
    for (let k = 0; k < 120; k++) obs.push({ x: r() * 4096, y: r() * 4096, radius: 40 + r() * 160 });
    const g = new ClearanceGrid();
    g.build(0, 0, 64, 64, 64, obs);
    const internals = g as unknown as Record<string, unknown>;
    const fields = ['dist', 'sq', 'f', 'd', 'v', 'z'];
    const before = fields.map((f) => internals[f]);
    const runs = 50;
    const t0 = performance.now();
    for (let k = 0; k < runs; k++) g.build(0, 0, 64, 64, 64, obs);
    const ms = (performance.now() - t0) / runs;
    fields.forEach((f, i) => expect(internals[f]).toBe(before[i]));
    console.log(`[nav clearance] 64x64 chunk, ${obs.length} rocks, ${g.blockedCount} blocked: ${ms.toFixed(3)} ms/build`);
  });
});
