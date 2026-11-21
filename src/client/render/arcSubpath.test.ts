import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { arcSubpath } from './arcSubpath';
import { strokeVertices } from './strokeVertices.testutil';

/** Records the path calls arcSubpath makes. */
function recorder(): { pts: number[]; moves: number; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void } {
  return {
    pts: [],
    moves: 0,
    moveTo(x, y) { this.moves++; this.pts.push(x, y); },
    lineTo(x, y) { this.pts.push(x, y); },
  };
}

describe('arcSubpath', () => {
  it('starts and ends on the arc, one moveTo, no repeated point', () => {
    const r = recorder();
    arcSubpath(r, 10, 20, 5, 0, Math.PI / 2);
    expect(r.moves).toBe(1);
    expect(r.pts[0]).toBeCloseTo(15);
    expect(r.pts[1]).toBeCloseTo(20);
    expect(r.pts[r.pts.length - 2]).toBeCloseTo(10);
    expect(r.pts[r.pts.length - 1]).toBeCloseTo(25);
    for (let i = 2; i < r.pts.length; i += 2) {
      expect(r.pts[i] !== r.pts[i - 2] || r.pts[i + 1] !== r.pts[i - 1]).toBe(true);
    }
  });

  it('a0 > a1 wraps the positive way, like arc(..., false): pi to 0 runs over the top (-y)', () => {
    const r = recorder();
    arcSubpath(r, 0, 0, 3, Math.PI, 0);
    let minY = Infinity;
    for (let i = 1; i < r.pts.length; i += 2) minY = Math.min(minY, r.pts[i]!);
    expect(minY).toBeCloseTo(-3);
  });

  it('after a fill and a stroke on one Graphics, several arcs in one stroke tessellate finite and local', () => {
    const g = new Graphics();
    g.rect(300, 300, 4, 4).fill({ color: 0xffffff });
    g.moveTo(300, 300).lineTo(310, 310).stroke({ color: 0xffffff, width: 1 });
    arcSubpath(g, 300, 300, 20, 0, 1);
    arcSubpath(g, 300, 300, 20, 2, 3);
    g.stroke({ color: 0xffffff, width: 2 });
    const v = strokeVertices(g);
    for (const n of v) {
      expect(Number.isFinite(n)).toBe(true);
      expect(Math.abs(n - 300)).toBeLessThan(25);
    }
  });
});
