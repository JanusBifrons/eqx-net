/**
 * Macro terrain v2: one cut-field chunk as flat typed arrays, so the client's
 * worker cut can hand it to the main thread by transfer (no structured clone
 * of thousands of `{x, y}` objects) with everything the main thread needs
 * already worked out: the draw outlines, the ore per fan vertex, and each
 * rock's body (`fieldRockBody`, kept in float64 so both sides' colliders stay
 * bit-identical, #15). docs/architecture/macro-terrain.md.
 */
import { fieldRockBody, type FieldRockBody } from './chunkStreamer.js';
import { SLICED, type ChunkRock, type CoarseTile, type SlicedRock } from './fieldLayout.js';
import { oreForOutlines, oreSeed } from './fieldOre.js';

export interface PackedChunk {
  /** Per rock: its packed rock key (`rockKey`). */
  keys: Uint32Array;
  /** Per rock: its start in `outlines` and `rel` (same layout). */
  starts: Int32Array;
  /** Per rock: body centre x, y and bounding radius (game space). */
  bodies: Float64Array;
  /** [n, dx0, dy0, …] per rock: the outline relative to the body centre. */
  rel: Float64Array;
  /** [n, x0, y0, …] per rock in game space, for drawing. */
  outlines: Float32Array;
  /** [ice, crystal] per fan vertex (`oreForOutlines`). */
  ore: Float32Array;
  /** Per rock: its start in `parts`. */
  partStarts: Int32Array;
  /** [m, (n, dx0, dy0, …) × m] per rock: its collider's convex parts
   *  relative to the body centre (`FieldRockBody.parts`); m = 0 ⇒ null. */
  parts: Float64Array;
}

/** A chunk's (or far-zoom tile's) outlines as one flat array (cheap to post
 *  to the render worker). */
export function packOutlines(rocks: readonly Pick<SlicedRock, 'verts'>[]): Float32Array {
  let len = 0;
  for (const r of rocks) len += 1 + r.verts.length * 2;
  const out = new Float32Array(len);
  let i = 0;
  for (const r of rocks) {
    out[i++] = r.verts.length;
    for (const v of r.verts) { out[i++] = v.x; out[i++] = v.y; }
  }
  return out;
}

/** A far-zoom tile packed for drawing: outlines and ore only (its pieces are
 *  never bodies). Same layout as `PackedChunk.outlines` / `.ore`. */
export interface PackedCoarseTile { tx: number; ty: number; outlines: Float32Array; ore: Float32Array }

/** Pack a far-zoom tile (`coarseFieldTiles`). `seed` is the field seed. */
export function packCoarseTile(tile: CoarseTile, seed: string): PackedCoarseTile {
  const outlines = packOutlines(tile.pieces);
  return { tx: tile.tx, ty: tile.ty, outlines, ore: oreForOutlines(oreSeed(seed), SLICED.radius, outlines) };
}

/** Pack a cut chunk (worker side). `seed` is the field seed. */
export function packChunk(rocks: readonly ChunkRock[], seed: string): PackedChunk {
  const n = rocks.length;
  const keys = new Uint32Array(n), starts = new Int32Array(n), bodies = new Float64Array(n * 3);
  const outlines = packOutlines(rocks);
  const rel = new Float64Array(outlines.length);
  const partStarts = new Int32Array(n);
  const bs = rocks.map(fieldRockBody);
  let plen = 0;
  for (const b of bs) { plen += 1; for (const p of b.parts ?? []) plen += 1 + p.length * 2; }
  const parts = new Float64Array(plen);
  let i = 0, j = 0;
  bs.forEach((b, r) => {
    keys[r] = rocks[r]!.key; starts[r] = i;
    bodies[r * 3] = b.x; bodies[r * 3 + 1] = b.y; bodies[r * 3 + 2] = b.radius;
    rel[i++] = b.verts.length;
    for (const v of b.verts) { rel[i++] = v.x; rel[i++] = v.y; }
    partStarts[r] = j;
    parts[j++] = b.parts?.length ?? 0;
    for (const p of b.parts ?? []) {
      parts[j++] = p.length;
      for (const v of p) { parts[j++] = v.x; parts[j++] = v.y; }
    }
  });
  return { keys, starts, bodies, rel, outlines, ore: oreForOutlines(oreSeed(seed), SLICED.radius, outlines), partStarts, parts };
}

/** Rock `r`'s body, built on demand (only rocks that get a collider). */
export function packedRockBody(c: PackedChunk, r: number): FieldRockBody {
  const s = c.starts[r]!, n = c.rel[s]!;
  const verts: { x: number; y: number }[] = new Array(n);
  for (let k = 0; k < n; k++) verts[k] = { x: c.rel[s + 1 + k * 2]!, y: c.rel[s + 2 + k * 2]! };
  let j = c.partStarts[r]!;
  const m = c.parts[j++]!;
  let parts: { x: number; y: number }[][] | null = null;
  if (m > 0) {
    parts = new Array<{ x: number; y: number }[]>(m);
    for (let q = 0; q < m; q++) {
      const pn = c.parts[j++]!, p: { x: number; y: number }[] = new Array(pn);
      for (let k = 0; k < pn; k++) { p[k] = { x: c.parts[j]!, y: c.parts[j + 1]! }; j += 2; }
      parts[q] = p;
    }
  }
  return { x: c.bodies[r * 3]!, y: c.bodies[r * 3 + 1]!, radius: c.bodies[r * 3 + 2]!, verts, parts };
}

/** The buffers to transfer when posting a packed chunk. */
export const packedBuffers = (c: PackedChunk): ArrayBuffer[] =>
  [c.keys, c.starts, c.bodies, c.rel, c.outlines, c.ore, c.partStarts, c.parts].map((a) => a.buffer as ArrayBuffer);

/** Hide rock `r` in the chunk's draw outlines: every vertex onto their mean,
 *  so its fan has no area. The rock count, indices and ore stay as they were
 *  (the layer finds a rock by its index). For a broken-up rock (consumed). */
export function collapsePackedRock(c: PackedChunk, r: number): void {
  const o = c.outlines, s = c.starts[r]!, n = o[s]!;
  let mx = 0, my = 0;
  for (let k = 0; k < n; k++) { mx += o[s + 1 + k * 2]!; my += o[s + 2 + k * 2]!; }
  mx /= n; my /= n;
  for (let k = 0; k < n; k++) { o[s + 1 + k * 2] = mx; o[s + 2 + k * 2] = my; }
}
