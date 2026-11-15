import { describe, it, expect } from 'vitest';
import { slicedField, FIELD_LAYOUT_VERSION, rocksInChunk, chunkOf, rockKey, unpackRockKey, CHUNK_SIZE } from './fieldLayout.js';

// A small field (20 km radius) keeps the tests fast; the rules are the same.
const B = 5752, F = 48, R = 20_000;
const WHOLE = { x0: -R * 1.2, y0: -R * 1.2, x1: R * 1.2, y1: R * 1.2 };
const cut = (view = WHOLE, seed = 'test') => slicedField({ seed, battleshipLength: B, fighterLength: F, view, radius: R });

describe('cut field (macro terrain v2, A1)', () => {
  it('has a layout version', () => {
    expect(FIELD_LAYOUT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic: the same seed cuts the same rocks', () => {
    const a = cut(), b = cut();
    expect(a.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
    expect(cut(WHOLE, 'other')).not.toEqual(a);
  });

  it('gives every piece its own cut path (no shared random streams)', () => {
    const rocks = cut();
    const paths = new Set(rocks.map((r) => r.path));
    expect(paths.size).toBe(rocks.length);
  });

  it('cutting a sub-area gives the very same rocks as cutting the whole field', () => {
    const all = cut();
    const whole = new Map(all.map((r) => [r.path, r]));
    // A 4 km window centred on a real rock (lanes and the core hole are wide
    // in a field this small).
    const at = all[Math.floor(all.length / 2)]!;
    const view = { x0: at.cx - 2000, y0: at.cy - 2000, x1: at.cx + 2000, y1: at.cy + 2000 };
    const part = cut(view);
    expect(part.length).toBeGreaterThan(5);
    for (const r of part) expect(whole.get(r.path), `piece ${r.path}`).toEqual(r);
    // And no rock of the whole field that reaches into the view is missing.
    const inView = (r: { verts: Array<{ x: number; y: number }> }) =>
      r.verts.some((p) => p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1);
    const partPaths = new Set(part.map((r) => r.path));
    for (const r of whole.values()) if (inView(r)) expect(partPaths.has(r.path), `missing ${r.path}`).toBe(true);
  });
});

describe('chunks and rock keys (macro terrain v2, A2)', () => {
  const OPTS = { seed: 'test', battleshipLength: B, fighterLength: F, radius: R };
  // Every chunk the 20 km test field (plus padding) can touch.
  const span = Math.ceil((R * 1.2) / CHUNK_SIZE);
  const chunks: Array<[number, number]> = [];
  for (let cx = -span; cx < span; cx++) for (let cy = -span; cy < span; cy++) chunks.push([cx, cy]);

  it('every rock of the whole field lands in exactly one chunk, and chunk cuts equal the full cut', () => {
    const whole = new Map(cut().map((r) => [r.path, r]));
    const seen = new Map<number, string>();
    for (const [cx, cy] of chunks) {
      for (const r of rocksInChunk(OPTS, cx, cy)) {
        expect(seen.has(r.path), `rock ${r.path} in two chunks`).toBe(false);
        seen.set(r.path, `${cx},${cy}`);
        const w = whole.get(r.path)!;
        expect(w, `chunk rock ${r.path} missing from the full cut`).toBeDefined();
        expect(r.verts).toEqual(w.verts);
        expect(chunkOf(w.cx, w.cy)).toEqual({ cx, cy });
      }
    }
    expect(seen.size).toBe(whole.size);
  });

  it('gives every rock a unique key that unpacks to its chunk and index', () => {
    const keys = new Set<number>();
    for (const [cx, cy] of chunks) {
      const rocks = rocksInChunk(OPTS, cx, cy);
      rocks.forEach((r, i) => {
        expect(r.index).toBe(i);
        expect(unpackRockKey(r.key)).toEqual({ cx, cy, index: i });
        expect(keys.has(r.key)).toBe(false);
        keys.add(r.key);
      });
    }
    expect(keys.size).toBeGreaterThan(100);
  });

  it('a chunk names its rocks the same however often or in whatever order it is cut', () => {
    const [cx, cy] = chunks[Math.floor(chunks.length / 2)]!;
    const first = rocksInChunk(OPTS, cx, cy);
    rocksInChunk(OPTS, cx + 1, cy); // cutting a neighbour first changes nothing
    expect(rocksInChunk(OPTS, cx, cy)).toEqual(first);
  });

  it('packs keys for negative chunk coordinates', () => {
    expect(unpackRockKey(rockKey(-37, 12, 513))).toEqual({ cx: -37, cy: 12, index: 513 });
    expect(unpackRockKey(rockKey(37, -128, 0))).toEqual({ cx: 37, cy: -128, index: 0 });
  });
});
