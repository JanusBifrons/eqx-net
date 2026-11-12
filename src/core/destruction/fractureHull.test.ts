/**
 * Capital fracture (S1, docs/architecture/capital-destruction.md): the pure,
 * deterministic hull splitter every side runs from (outline, seed, kill
 * point, cuts, cap).
 *
 * Dev review: `EQX_FRACTURE_SVG=1 pnpm vitest run src/core/destruction`
 * prints an SVG of a battleship fracture (and its build time) to stdout.
 */
import { describe, expect, it } from 'vitest';
import {
  fractureHull,
  FRACTURE_MAX_PIECES,
  FRACTURE_QUANTUM,
  type FractureInput,
  type FracturePiece,
} from './fractureHull.js';
import { SHIP_KINDS } from '../../shared-types/shipKinds.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';

type V = { x: number; y: number };

// ── independent geometry oracles (not shared with the implementation) ──

function area(poly: ReadonlyArray<V>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function tupleArea(poly: ReadonlyArray<readonly [number, number]>): number {
  return Math.abs(area(poly.map(([x, y]) => ({ x, y }))));
}

function orient(a: V, b: V, c: V): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSeg(a: V, b: V, p: V): boolean {
  return (
    Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y)
  );
}

function segsTouch(a: V, b: V, c: V, d: V): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

/** Simple = no two non-adjacent edges touch, no repeated vertex, no spike
 *  (an edge folding straight back on its neighbour: a zero-width bridge). */
function isSimple(poly: ReadonlyArray<V>): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (poly[i]!.x === poly[j]!.x && poly[i]!.y === poly[j]!.y) return false;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const c = poly[(i + 2) % n]!;
    // spike: c lies back along b→a
    if (orient(a, b, c) === 0 && (c.x - b.x) * (a.x - b.x) + (c.y - b.y) * (a.y - b.y) > 0) return false;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent via wrap
      if (segsTouch(a, b, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

function isConvexCcw(poly: ReadonlyArray<V>, scale: number): boolean {
  const n = poly.length;
  if (n < 3) return false;
  const eps = 1e-9 * scale * scale;
  for (let i = 0; i < n; i++) {
    if (orient(poly[i]!, poly[(i + 1) % n]!, poly[(i + 2) % n]!) < -eps) return false;
  }
  return area(poly) > 0;
}

function hull(kind: 'heavy-cruiser' | 'battleship'): ReadonlyArray<readonly [number, number]> {
  return shipHullOutline(SHIP_KINDS[kind]);
}

/** A strongly concave "U" (two prongs joined at the bottom): a Voronoi cell
 *  across its mouth cuts it into two disjoint parts. */
const U_HULL: ReadonlyArray<readonly [number, number]> = [
  [-300, -400], [-100, -400], [-100, 200], [100, 200], [100, -400], [300, -400],
  [300, 400], [-300, 400],
];

function battleshipInput(seed = 1234, maxPieces = 24): FractureInput {
  return { hull: hull('battleship'), seed, killPoint: { x: 120, y: -1500 }, maxPieces };
}

function sumArea(pieces: ReadonlyArray<FracturePiece>): number {
  let s = 0;
  for (const p of pieces) s += p.area;
  return s;
}

describe('fractureHull', () => {
  const cases: Array<[string, FractureInput]> = [
    ['battleship', battleshipInput()],
    ['heavy cruiser', { hull: hull('heavy-cruiser'), seed: 99, killPoint: { x: -100, y: 900 }, maxPieces: 20 }],
    ['concave U', { hull: U_HULL, seed: 7, killPoint: { x: 0, y: 300 }, maxPieces: 16 }],
    ['battleship + section cuts', {
      ...battleshipInput(42),
      sectionCuts: [
        { a: { x: -1000, y: -800 }, b: { x: 1000, y: -800 } },
        { a: { x: -1000, y: 900 }, b: { x: 1000, y: 1000 } },
      ],
    }],
  ];

  it.each(cases)('%s: piece areas sum to the hull area', (_n, input) => {
    const pieces = fractureHull(input);
    expect(pieces.length).toBeGreaterThan(3);
    const want = tupleArea(input.hull);
    expect(Math.abs(sumArea(pieces) - want) / want).toBeLessThan(0.005);
    for (const p of pieces) expect(p.area).toBeCloseTo(area(p.outline), 6);
  });

  it('same seed gives a deep-equal result', () => {
    const a = fractureHull(battleshipInput(555));
    const b = fractureHull(battleshipInput(555));
    expect(b).toEqual(a);
  });

  it('a different seed gives a different result', () => {
    const a = fractureHull(battleshipInput(555));
    const b = fractureHull(battleshipInput(556));
    expect(b).not.toEqual(a);
  });

  it.each(cases)('%s: every outline is simple and CCW, on the 1/64 grid', (_n, input) => {
    for (const p of fractureHull(input)) {
      expect(isSimple(p.outline)).toBe(true);
      expect(area(p.outline)).toBeGreaterThan(0);
      for (const v of p.outline) {
        expect(Number.isInteger(v.x / FRACTURE_QUANTUM)).toBe(true);
        expect(Number.isInteger(v.y / FRACTURE_QUANTUM)).toBe(true);
      }
    }
  });

  it.each(cases)('%s: every convex part is convex and the parts tile the piece', (_n, input) => {
    for (const p of fractureHull(input)) {
      expect(p.convexParts.length).toBeGreaterThan(0);
      let s = 0;
      for (const part of p.convexParts) {
        expect(isConvexCcw(part, 3000)).toBe(true);
        s += area(part);
      }
      expect(Math.abs(s - p.area) / p.area).toBeLessThan(1e-6);
    }
  });

  it('pieces near the kill point are smaller on average than far ones', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const input = battleshipInput(seed, 32);
      const k = input.killPoint;
      const pieces = fractureHull(input)
        .map((p) => ({ a: p.area, d: Math.hypot(p.centroid.x - k.x, p.centroid.y - k.y) }))
        .sort((p, q) => p.d - q.d);
      const third = Math.floor(pieces.length / 3);
      const mean = (xs: typeof pieces): number => xs.reduce((s, p) => s + p.a, 0) / xs.length;
      expect(mean(pieces.slice(0, third))).toBeLessThan(mean(pieces.slice(-third)));
    }
  });

  it('a concave hull cut across its mouth yields separate pieces, not bridges', () => {
    // Many seeds over a U: some cell must span both prongs.
    for (let seed = 0; seed < 20; seed++) {
      const pieces = fractureHull({ hull: U_HULL, seed, killPoint: { x: 0, y: -350 }, maxPieces: 6 });
      for (const p of pieces) {
        expect(isSimple(p.outline)).toBe(true);
        // A piece never contains the notch's interior point.
        expect(pointIn(p.outline, { x: 0, y: -100 })).toBe(false);
      }
      const want = tupleArea(U_HULL);
      expect(Math.abs(sumArea(pieces) - want) / want).toBeLessThan(0.005);
    }
  });

  it('the piece cap holds', () => {
    for (const cap of [1, 2, 5, 12, 40]) {
      for (const input of [battleshipInput(9, cap), { hull: U_HULL, seed: 3, killPoint: { x: 0, y: 0 }, maxPieces: cap }]) {
        const pieces = fractureHull(input);
        expect(pieces.length).toBeLessThanOrEqual(cap);
        expect(pieces.length).toBeGreaterThanOrEqual(1);
      }
    }
    expect(fractureHull(battleshipInput(9, 10_000)).length).toBeLessThanOrEqual(FRACTURE_MAX_PIECES);
  });

  it('flags new cut edges, and only cut edges leave the hull outline', () => {
    const input = battleshipInput(77);
    const outline = input.hull.map(([x, y]) => ({ x, y }));
    let cuts = 0;
    for (const p of fractureHull(input)) {
      expect(p.cutEdges.length).toBe(p.outline.length);
      let pieceCuts = 0;
      for (let i = 0; i < p.outline.length; i++) {
        const a = p.outline[i]!;
        const b = p.outline[(i + 1) % p.outline.length]!;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (p.cutEdges[i]) pieceCuts++;
        else expect(distToOutline(outline, mid)).toBeLessThan(0.1);
      }
      expect(pieceCuts).toBeGreaterThan(0);
      cuts += pieceCuts;
    }
    expect(cuts).toBeGreaterThan(20);
  });

  it('cut edges are jagged: a cut run bends', () => {
    let bends = 0;
    for (const p of fractureHull(battleshipInput(31))) {
      const n = p.outline.length;
      for (let i = 0; i < n; i++) {
        if (!p.cutEdges[i] || !p.cutEdges[(i + 1) % n]) continue;
        if (orient(p.outline[i]!, p.outline[(i + 1) % n]!, p.outline[(i + 2) % n]!) !== 0) bends++;
      }
    }
    expect(bends).toBeGreaterThan(30);
  });

  it('section cuts are respected: no piece straddles a section line', () => {
    const y0 = -800;
    const pieces = fractureHull({ ...battleshipInput(42), sectionCuts: [{ a: { x: -1000, y: y0 }, b: { x: 1000, y: y0 } }] });
    for (const p of pieces) {
      const above = p.outline.some((v) => v.y > y0 + 1e-9);
      const below = p.outline.some((v) => v.y < y0 - 1e-9);
      expect(above && below).toBe(false);
    }
  });

  it('sweep: 40 seeds per hull stay valid (area, simple, convex parts, cap)', () => {
    const hulls: Array<ReadonlyArray<readonly [number, number]>> = [hull('battleship'), hull('heavy-cruiser'), U_HULL];
    for (const h of hulls) {
      const want = tupleArea(h);
      for (let seed = 100; seed < 140; seed++) {
        const kx = ((seed * 37) % 200) - 100;
        const ky = ((seed * 53) % 1000) - 500;
        const pieces = fractureHull({ hull: h, seed, killPoint: { x: kx, y: ky }, maxPieces: 8 + (seed % 25) });
        expect(pieces.length).toBeLessThanOrEqual(8 + (seed % 25));
        expect(Math.abs(sumArea(pieces) - want) / want).toBeLessThan(0.005);
        for (const p of pieces) {
          expect(isSimple(p.outline)).toBe(true);
          let s = 0;
          for (const part of p.convexParts) {
            expect(isConvexCcw(part, 3000)).toBe(true);
            s += area(part);
          }
          expect(Math.abs(s - p.area) / p.area).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('golden: the battleship fracture output is locked (bump FRACTURE_ALGO_VERSION if this changes)', () => {
    const pieces = fractureHull(battleshipInput(20261112));
    expect({ pieces: pieces.length, hash: hashPieces(pieces) }).toEqual(GOLDEN);
  });

  it.runIf(!!process.env.EQX_FRACTURE_SVG)('prints a review SVG', () => {
    const input = { ...battleshipInput(20261112), sectionCuts: [{ a: { x: -1000, y: 900 }, b: { x: 1000, y: 900 } }] };
    const t0 = performance.now();
    const pieces = fractureHull(input);
    const ms = performance.now() - t0;
    console.log(`fracture: ${pieces.length} pieces in ${ms.toFixed(1)} ms`);
    console.log(toSvg(input, pieces));
  });
});

const GOLDEN = { pieces: 24, hash: 2002695480 };

function hashPieces(pieces: ReadonlyArray<FracturePiece>): number {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const p of pieces) {
    mix(p.outline.length);
    for (let i = 0; i < p.outline.length; i++) {
      mix(Math.round(p.outline[i]!.x / FRACTURE_QUANTUM));
      mix(Math.round(p.outline[i]!.y / FRACTURE_QUANTUM));
      mix(p.cutEdges[i] ? 1 : 0);
    }
    mix(p.convexParts.length);
  }
  return h >>> 0;
}

function pointIn(poly: ReadonlyArray<V>, p: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToOutline(poly: ReadonlyArray<V>, p: V): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

function toSvg(input: FractureInput, pieces: ReadonlyArray<FracturePiece>): string {
  const xs = input.hull.map(([x]) => x);
  const ys = input.hull.map(([, y]) => y);
  const pad = 60;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - minX + pad;
  const h = Math.max(...ys) - minY + pad;
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${Math.round(w / 8)}" height="${Math.round(h / 8)}">`];
  out.push(`<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#0b0e14"/>`);
  pieces.forEach((p, k) => {
    const pts = p.outline.map((v) => `${v.x},${v.y}`).join(' ');
    out.push(`<polygon points="${pts}" fill="hsl(${(k * 47) % 360},25%,38%)" stroke="#9aa4b2" stroke-width="3"/>`);
    for (let i = 0; i < p.outline.length; i++) {
      if (!p.cutEdges[i]) continue;
      const a = p.outline[i]!;
      const b = p.outline[(i + 1) % p.outline.length]!;
      out.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#ff8a1f" stroke-width="7"/>`);
    }
  });
  out.push(`<circle cx="${input.killPoint.x}" cy="${input.killPoint.y}" r="22" fill="#fff"/>`);
  out.push('</svg>');
  return out.join('\n');
}
