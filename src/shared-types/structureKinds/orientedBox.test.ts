/**
 * Oriented-box math (base platforms 16): the separating-axis overlap test,
 * box vs circle, the bounding box, and the exact quarter-turn (cos, sin).
 */
import { describe, expect, it } from 'vitest';
import {
  isStructureQuarterTurn,
  orientedBoxBoundsInto,
  orientedBoxesOverlap,
  orientedBoxOverlapsCircle,
  structureRotationCosSinInto,
} from './geometry.js';

const D = Math.PI / 180;
const c = (deg: number) => Math.cos(deg * D);
const s = (deg: number) => Math.sin(deg * D);

/** Independent oracle: the four corners of each box and a vertex-projection
 *  separating-axis test (a different formula from the radius one under test). */
function corners(x: number, y: number, hw: number, hh: number, deg: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
    out.push([x + lx * c(deg) - ly * s(deg), y + lx * s(deg) + ly * c(deg)]);
  }
  return out;
}
function oracle(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = poly[i]!, [x1, y1] = poly[(i + 1) % 4]!;
      const ax = -(y1 - y0), ay = x1 - x0;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [px, py] of a) { const d = px * ax + py * ay; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [px, py] of b) { const d = px * ax + py * ay; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
    }
  }
  return true;
}

describe('orientedBoxesOverlap', () => {
  it('axis-aligned boxes: the old rule, touching is legal', () => {
    expect(orientedBoxesOverlap(0, 0, 1, 1, 1, 0, 2, 0, 1, 1, 1, 0)).toBe(false); // touching
    expect(orientedBoxesOverlap(0, 0, 1, 1, 1, 0, 1.999, 0, 1, 1, 1, 0)).toBe(true);
    expect(orientedBoxesOverlap(0, 0, 1, 1, 1, 0, 3, 3, 1, 1, 1, 0)).toBe(false);
  });

  it('a 45° square reaches √2 out: touching corner-to-face is legal, one hair closer overlaps', () => {
    const touch = 1 + Math.SQRT2;
    expect(orientedBoxesOverlap(0, 0, 1, 1, 1, 0, touch + 1e-9, 0, 1, 1, c(45), s(45))).toBe(false);
    expect(orientedBoxesOverlap(0, 0, 1, 1, 1, 0, touch - 1e-6, 0, 1, 1, c(45), s(45))).toBe(true);
  });

  it('a long box turned 30°: inside its axis-aligned bounds but clear of the box itself', () => {
    // 10×1 half extents turned 30°; a small square near the bounds' corner.
    const b = orientedBoxBoundsInto(10, 1, c(30), s(30), { hw: 0, hh: 0 });
    const px = b.hw - 0.5, py = -(b.hh - 0.5); // inside the bounds, off the long diagonal
    expect(orientedBoxesOverlap(0, 0, 10, 1, c(30), s(30), px, py, 0.25, 0.25, 1, 0)).toBe(false);
    // On the box's long axis the same square overlaps.
    expect(orientedBoxesOverlap(0, 0, 10, 1, c(30), s(30), 8 * c(30), 8 * s(30), 0.25, 0.25, 1, 0)).toBe(true);
  });

  it('agrees with a vertex-projection oracle on many turned pairs (30° steps)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let hits = 0, misses = 0;
    for (let n = 0; n < 2000; n++) {
      const ad = Math.floor(rnd() * 12) * 30, bd = Math.floor(rnd() * 12) * 30;
      const ahw = 1 + rnd() * 5, ahh = 1 + rnd() * 5, bhw = 1 + rnd() * 5, bhh = 1 + rnd() * 5;
      const bx = (rnd() - 0.5) * 20, by = (rnd() - 0.5) * 20;
      const want = oracle(corners(0, 0, ahw, ahh, ad), corners(bx, by, bhw, bhh, bd));
      const got = orientedBoxesOverlap(0, 0, ahw, ahh, c(ad), s(ad), bx, by, bhw, bhh, c(bd), s(bd));
      expect(got, `a ${ad}° b ${bd}° at (${bx}, ${by})`).toBe(want);
      if (got) hits++; else misses++;
    }
    expect(hits).toBeGreaterThan(200);
    expect(misses).toBeGreaterThan(200);
  });

  it('is symmetric in its two boxes', () => {
    expect(orientedBoxesOverlap(0, 0, 3, 1, c(30), s(30), 3, 2.2, 2, 0.5, c(60), s(60)))
      .toBe(orientedBoxesOverlap(3, 2.2, 2, 0.5, c(60), s(60), 0, 0, 3, 1, c(30), s(30)));
  });
});

describe('orientedBoxOverlapsCircle', () => {
  it('axis-aligned: the old box-vs-circle rule (touching legal)', () => {
    expect(orientedBoxOverlapsCircle(0, 0, 2, 1, 1, 0, 3, 0, 1)).toBe(false);
    expect(orientedBoxOverlapsCircle(0, 0, 2, 1, 1, 0, 2.9, 0, 1)).toBe(true);
  });

  it('a quarter turn swaps which side is long', () => {
    expect(orientedBoxOverlapsCircle(0, 0, 2, 1, 0, 1, 0, 2.5, 1)).toBe(true);
    expect(orientedBoxOverlapsCircle(0, 0, 2, 1, 0, 1, 2.5, 0, 1)).toBe(false);
  });

  it('a 30° turn: a circle at the bounds corner misses, one beside the long face hits', () => {
    // 350×150 halves turned 30° (a Solar): axis bounds corner (350, 150) is clear.
    expect(orientedBoxOverlapsCircle(0, 0, 350, 150, c(30), s(30), 360, 160, 20)).toBe(false);
    // (0, 200) is outside the axis box's 150 half height, but inside the turned box's reach.
    expect(orientedBoxOverlapsCircle(0, 0, 350, 150, c(30), s(30), 0, 200, 30)).toBe(true);
  });
});

describe('orientedBoxBoundsInto / structureRotationCosSinInto', () => {
  it('quarter turns give exact 0 / ±1 and bounds equal to the swapped box', () => {
    const t = { cos: 0, sin: 0 };
    expect(structureRotationCosSinInto(90, t)).toEqual({ cos: 0, sin: 1 });
    expect(structureRotationCosSinInto(180, t)).toEqual({ cos: -1, sin: 0 });
    expect(structureRotationCosSinInto(270, t)).toEqual({ cos: 0, sin: -1 });
    expect(structureRotationCosSinInto(0, t)).toEqual({ cos: 1, sin: 0 });
    structureRotationCosSinInto(90, t);
    expect(orientedBoxBoundsInto(350, 150, t.cos, t.sin, { hw: 0, hh: 0 })).toEqual({ hw: 150, hh: 350 });
  });

  it('a 30° turn bounds the real corners', () => {
    const t = structureRotationCosSinInto(30, { cos: 0, sin: 0 });
    expect(t.cos).toBeCloseTo(Math.sqrt(3) / 2, 12);
    const b = orientedBoxBoundsInto(350, 150, t.cos, t.sin, { hw: 0, hh: 0 });
    const cs = corners(0, 0, 350, 150, 30);
    expect(b.hw).toBeCloseTo(Math.max(...cs.map((p) => p[0])), 9);
    expect(b.hh).toBeCloseTo(Math.max(...cs.map((p) => p[1])), 9);
  });

  it('isStructureQuarterTurn', () => {
    expect([0, 90, 180, 270, 360, -90].every(isStructureQuarterTurn)).toBe(true);
    expect([30, 60, 120, 150, 210, 330].some(isStructureQuarterTurn)).toBe(false);
  });
});
