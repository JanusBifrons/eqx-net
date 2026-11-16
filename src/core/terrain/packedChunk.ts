/**
 * Macro terrain v2: one cut-field chunk as flat typed arrays, so the client's
 * worker cut can hand it to the main thread by transfer (no structured clone
 * of thousands of `{x, y}` objects) with everything the main thread needs
 * already worked out: the draw outlines, the ore per fan vertex, and each
 * rock's body (`fieldRockBody`, kept in float64 so both sides' colliders stay
 * bit-identical, #15). docs/architecture/macro-terrain.md.
 */
import { fieldRockBody, type FieldRockBody } from './chunkStreamer.js';
import { SLICED, type ChunkRock } from './fieldLayout.js';
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
}

/** A chunk's outlines as one flat array (cheap to post to the render worker). */
export function packOutlines(rocks: readonly ChunkRock[]): Float32Array {
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

/** Pack a cut chunk (worker side). `seed` is the field seed. */
export function packChunk(rocks: readonly ChunkRock[], seed: string): PackedChunk {
  const n = rocks.length;
  const keys = new Uint32Array(n), starts = new Int32Array(n), bodies = new Float64Array(n * 3);
  const outlines = packOutlines(rocks);
  const rel = new Float64Array(outlines.length);
  let i = 0;
  rocks.forEach((rock, r) => {
    const b = fieldRockBody(rock);
    keys[r] = rock.key; starts[r] = i;
    bodies[r * 3] = b.x; bodies[r * 3 + 1] = b.y; bodies[r * 3 + 2] = b.radius;
    rel[i++] = b.verts.length;
    for (const v of b.verts) { rel[i++] = v.x; rel[i++] = v.y; }
  });
  return { keys, starts, bodies, rel, outlines, ore: oreForOutlines(oreSeed(seed), SLICED.radius, outlines) };
}

/** Rock `r`'s body, built on demand (only rocks that get a collider). */
export function packedRockBody(c: PackedChunk, r: number): FieldRockBody {
  const s = c.starts[r]!, n = c.rel[s]!;
  const verts: { x: number; y: number }[] = new Array(n);
  for (let k = 0; k < n; k++) verts[k] = { x: c.rel[s + 1 + k * 2]!, y: c.rel[s + 2 + k * 2]! };
  return { x: c.bodies[r * 3]!, y: c.bodies[r * 3 + 1]!, radius: c.bodies[r * 3 + 2]!, verts };
}

/** The buffers to transfer when posting a packed chunk. */
export const packedBuffers = (c: PackedChunk): ArrayBuffer[] =>
  [c.keys, c.starts, c.bodies, c.rel, c.outlines, c.ore].map((a) => a.buffer as ArrayBuffer);
