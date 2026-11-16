/**
 * Far zoom (macro terrain plan v2, B4): the coarse cut field. When the cut
 * stops at `FIELD_COARSE_MIN_SIZE` every piece is kept whole (no rim drop, no
 * street inset) and roughened one level, so from far out the coarse pieces
 * cover where the real rocks are. docs/architecture/macro-terrain.md.
 */
import { describe, it, expect } from 'vitest';
import { cutFieldOpts } from './chunkStreamer.js';
import { CHUNK_SIZE, chunkOf, coarseFieldTiles, COARSE_TILE_CHUNKS, FIELD_COARSE_MIN_SIZE, rocksInChunk, SLICED, slicedFieldLanes, type SlicedRock } from './fieldLayout.js';
import { fnvMixU32 } from '../random/rng.js';

type Pt = { x: number; y: number };
const field = cutFieldOpts('far-zoom');
const SAMPLE: ReadonlyArray<readonly [number, number]> = [[15, 0], [-12, 7], [3, -20], [-25, -9], [20, 20], [0, 30]];

const t0 = performance.now();
const tiles = coarseFieldTiles(field);
const ms = performance.now() - t0;
const pieces: SlicedRock[] = tiles.flatMap((t) => t.pieces);
const boxes = pieces.map((p) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of p.verts) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
  return { x0, y0, x1, y1 };
});

function inPoly(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const inAnyPiece = (p: Pt): boolean => pieces.some((c, i) => {
  const b = boxes[i]!;
  return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && inPoly(p, c.verts);
});

describe('far-zoom coarse field (macro terrain v2, B4)', () => {
  it('covers at least 90 % of the real rocks (their drawn centres) in sample chunks', () => {
    let n = 0, hit = 0;
    for (const [cx, cy] of SAMPLE) for (const r of rocksInChunk(field, cx, cy)) {
      let x = 0, y = 0;
      for (const v of r.verts) { x += v.x; y += v.y; }
      n++; if (inAnyPiece({ x: x / r.verts.length, y: y / r.verts.length })) hit++;
    }
    console.log(`coarse coverage ${hit}/${n} = ${((100 * hit) / n).toFixed(1)} %`);
    expect(n).toBeGreaterThan(100);
    expect(hit / n).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps both lanes clear: no point on a lane centre line is inside a coarse piece', () => {
    const lanes = slicedFieldLanes(field);
    expect(lanes.length).toBe(SLICED.lanes);
    for (const ln of lanes) {
      const dx = ln.n.y, dy = -ln.n.x;
      for (let t = -SLICED.radius; t <= SLICED.radius; t += 250) {
        const p = { x: ln.o.x + dx * t, y: ln.o.y + dy * t };
        expect(inAnyPiece(p), `lane point ${p.x.toFixed(0)},${p.y.toFixed(0)}`).toBe(false);
      }
    }
  });

  it('fits the whole field in the point budget (<= 200k points)', () => {
    let pts = 0;
    for (const p of pieces) pts += p.verts.length;
    console.log(`coarse field: ${pieces.length} pieces, ${pts} points, ${tiles.length} tiles, ${ms.toFixed(1)} ms`);
    expect(pieces.length).toBeGreaterThan(1000);
    expect(pts).toBeLessThanOrEqual(200_000);
  });

  it('leaves the full-detail rocks exactly as they were (hash from the parent commit)', () => {
    let h = 2166136261 >>> 0, n = 0;
    const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
    for (const [cx, cy] of SAMPLE) for (const r of rocksInChunk(field, cx, cy)) {
      n++; h = fnvMixU32(h, r.key); h = fnvMixU32(h, r.path >>> 0);
      for (const v of r.verts) for (const q of [v.x, v.y]) { f64[0] = q; h = fnvMixU32(fnvMixU32(h, u32[0]!), u32[1]!); }
    }
    expect(n).toBe(164);
    expect(h >>> 0).toBe(1305361875);
  });

  it('puts every coarse piece in exactly one tile: the 8x8-chunk tile of its pre-warp centre', () => {
    expect(FIELD_COARSE_MIN_SIZE).toBe(2048);
    expect(COARSE_TILE_CHUNKS).toBe(8);
    const seen = new Set<number>();
    const tileKeys = new Set<string>();
    for (const t of tiles) {
      const k = `${t.tx},${t.ty}`;
      expect(tileKeys.has(k), `tile ${k} twice`).toBe(false);
      tileKeys.add(k);
      expect(t.pieces.length).toBeGreaterThan(0);
      for (const p of t.pieces) {
        expect(seen.has(p.path), `piece ${p.path} in two tiles`).toBe(false);
        seen.add(p.path);
        const c = chunkOf(p.cx, p.cy);
        expect({ tx: Math.floor(c.cx / COARSE_TILE_CHUNKS), ty: Math.floor(c.cy / COARSE_TILE_CHUNKS) }).toEqual({ tx: t.tx, ty: t.ty });
        expect(p.cx >= t.tx * COARSE_TILE_CHUNKS * CHUNK_SIZE && p.cx < (t.tx + 1) * COARSE_TILE_CHUNKS * CHUNK_SIZE).toBe(true);
      }
    }
    expect(seen.size).toBe(pieces.length);
  });
});
