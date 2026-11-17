import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_KINDS_LIST,
  STRUCTURE_OUTLINE_FAMILY,
  getStructureKind,
  structureHullPoints,
  structureOutline,
} from './structureKinds.js';

type P = { x: number; y: number };

function signedArea(poly: readonly P[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function cross(o: P, a: P, b: P): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Proper or touching intersection of segments ab and cd. */
function segmentsIntersect(a: P, b: P, c: P, d: P): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

function isSimple(poly: readonly P[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share a vertex.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

const KIND_IDS = STRUCTURE_KINDS_LIST.map((k) => k.id);

describe('structureOutline', () => {
  it('is deterministic per kind and style', () => {
    for (const id of KIND_IDS) {
      expect(structureOutline(id)).toEqual(structureOutline(id));
      expect(structureOutline(id, 'b')).toEqual(structureOutline(id, 'b'));
    }
  });

  it('returns a fresh array each call', () => {
    const a = structureOutline('capital');
    a[0]!.x = 1e9;
    expect(structureOutline('capital')[0]!.x).not.toBe(1e9);
  });

  it.each(KIND_IDS)('%s: inside footprint, CCW, simple, ≥5 vertices, not a rectangle', (id) => {
    const { w, h } = getStructureKind(id).footprint;
    const hw = w / 2;
    const hh = h / 2;
    const poly = structureOutline(id);
    expect(poly.length).toBeGreaterThanOrEqual(5);
    for (const p of poly) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(hw + 1e-9);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(hh + 1e-9);
      // No footprint corner survives: never the box.
      expect(Math.abs(p.x) > hw - 1e-6 && Math.abs(p.y) > hh - 1e-6).toBe(false);
    }
    expect(signedArea(poly)).toBeGreaterThan(0);
    expect(isSimple(poly)).toBe(true);
    // At least one edge is diagonal, so it is not an axis-aligned rectangle.
    const diagonal = poly.some((a, i) => {
      const b = poly[(i + 1) % poly.length]!;
      return Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6;
    });
    expect(diagonal).toBe(true);
  });

  it('every style variant keeps the same guarantees', () => {
    for (const id of KIND_IDS) {
      for (const style of ['a', 'b', 'c', 'heavy']) {
        const poly = structureOutline(id, style);
        expect(poly.length).toBeGreaterThanOrEqual(5);
        expect(signedArea(poly)).toBeGreaterThan(0);
        expect(isSimple(poly)).toBe(true);
      }
    }
  });

  it('connector (line node) is a regular flat-top hexagon', () => {
    expect(STRUCTURE_OUTLINE_FAMILY.connector).toBe('hex');
    const poly = structureOutline('connector');
    expect(poly).toHaveLength(6);
    const r = Math.hypot(poly[0]!.x, poly[0]!.y);
    for (let i = 0; i < 6; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % 6]!;
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(r, 6);
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeCloseTo(r, 6);
    }
    // Flat top: the two highest vertices share a y.
    const ys = poly.map((p) => p.y).sort((a, b) => b - a);
    expect(ys[0]).toBeCloseTo(ys[1]!, 6);
  });

  it('a style variant changes seeded families but not the hex', () => {
    expect(structureOutline('connector', 'x')).toEqual(structureOutline('connector'));
    const seeded = KIND_IDS.filter((id) => STRUCTURE_OUTLINE_FAMILY[id] !== 'hex');
    expect(seeded.some((id) => JSON.stringify(structureOutline(id, 'x')) !== JSON.stringify(structureOutline(id)))).toBe(true);
  });

  it('unknown kind falls back to the Capital', () => {
    expect(structureOutline('nope')).toEqual(structureOutline('capital'));
    expect(structureOutline(null)).toEqual(structureOutline('capital'));
  });

  it('structureHullPoints still returns the footprint box (Stage 3 flips it)', () => {
    const { w, h } = getStructureKind('solar').footprint;
    expect(structureHullPoints('solar')).toEqual([
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ]);
  });

  it('style c: ordered outlines (convex, symmetric about both axes, ≥5 vertices, hex nodes)', () => {
    for (const id of KIND_IDS) {
      const poly = structureOutline(id, 'c');
      const { w, h } = getStructureKind(id).footprint;
      expect(poly.length, id).toBeGreaterThanOrEqual(5);
      // Convex: every turn is a left turn (CCW).
      for (let i = 0; i < poly.length; i++) {
        expect(cross(poly[i]!, poly[(i + 1) % poly.length]!, poly[(i + 2) % poly.length]!), id).toBeGreaterThan(0);
      }
      // Symmetric: the mirror of every vertex (in x, and in y) is a vertex.
      const has = (x: number, y: number): boolean => poly.some((q) => Math.abs(q.x - x) < 1e-9 && Math.abs(q.y - y) < 1e-9);
      for (const p of poly) expect(has(-p.x, p.y) && has(p.x, -p.y), id).toBe(true);
      // No footprint corner survives (chamfered, never square); fills the box.
      for (const p of poly) expect(Math.abs(p.x) > w / 2 - 1e-6 && Math.abs(p.y) > h / 2 - 1e-6, id).toBe(false);
      if (STRUCTURE_OUTLINE_FAMILY[id] === 'hex') expect(poly, id).toEqual(structureOutline(id));
    }
  });

  it('style c leaves every other style outline unchanged (hash pinned before 1i)', () => {
    // Kinds appended after the pin (the Territory Lock) are left out, so the
    // pin still guards every outline it covered.
    const pinned = KIND_IDS.filter((id) => id !== 'territory_lock');
    const json = JSON.stringify(pinned.map((id) => [undefined, 'a', 'b'].map((st) => structureOutline(id, st))));
    let hh = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) {
      hh ^= json.charCodeAt(i);
      hh = Math.imul(hh, 0x01000193) >>> 0;
    }
    // Re-pinned in 2c++: FREIGHT_DOCK's footprint grew to 1000×400 (every
    // style's outline is footprint-derived; nothing else moved).
    expect(hh.toString(16)).toBe('55a60991');
  });
});
