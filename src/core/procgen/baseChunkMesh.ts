/**
 * Base collider geometry: the OUTLINE of the union of solid pieces
 * (plan: soft-leaping-truffle, PR-V).
 *
 * Why an outline (measured 2026-10-31, ship sliding along 30 adjacent pieces,
 * 600 u/s, damping-only floor 565): trimesh 340, trimesh without soft CCD 435,
 * compound cuboids 215 — every representation with INTERNAL edges snags at the
 * seams between adjacent pieces (FIX_INTERNAL_EDGES made no difference).
 * A polyline of the union's boundary has no internal edges: 565, i.e. a clean
 * slide. It costs the same in the broad-phase as one trimesh per chunk (0.088
 * vs 0.086 ms/step, 25 ships + 4000 pieces) and, with soft CCD, never tunnels
 * (0/184 at 2× top speed on a 16 u wall).
 *
 * The union is computed over the WHOLE base with an integer sweep, so
 * boundary segments are maximal and never break at chunk lines; each segment
 * is assigned to the chunk containing its start point (it may extend past
 * that chunk — physics doesn't care, and the client streams neighbours).
 *
 * Pure + deterministic + integer: the server worker and the client predWorld
 * call the same function (Invariant #15). Generation-time only (once per base,
 * and once per destroy-rebuild) — not a per-tick path.
 */
import { basePieceKindAt } from '../../shared-types/basePieceKinds.js';
import { BASE_CHUNK_SIZE } from '../../shared-types/baseBudgets.js';
import type { BaseLayout } from './baseLayout.js';

export interface ChunkOutline {
  /** World-space vertices, flat [x0, y0, x1, y1, ...]. */
  readonly vertices: Float32Array;
  /** Segment index pairs into `vertices` (Rapier polyline indices). */
  readonly indices: Uint32Array;
}

/** True when piece `i`'s destroy bit is set in a u32 bit mask. */
export function isPieceDead(dead: Uint32Array | null | undefined, i: number): boolean {
  if (!dead) return false;
  const w = dead[i >>> 5];
  return w !== undefined && (w & (1 << (i & 31))) !== 0;
}

/** Number of chunks in a layout's grid. */
export function chunkCount(l: BaseLayout): number {
  return l.chunksAcross * l.chunksAcross;
}

/** World-space AABB of a chunk: [minX, minY, maxX, maxY]. */
export function chunkBounds(l: BaseLayout, chunk: number, out: Float64Array): Float64Array {
  const cx = chunk % l.chunksAcross;
  const cy = (chunk - cx) / l.chunksAcross;
  out[0] = l.descriptor.x - l.half + cx * BASE_CHUNK_SIZE;
  out[1] = l.descriptor.y - l.half + cy * BASE_CHUNK_SIZE;
  out[2] = out[0]! + BASE_CHUNK_SIZE;
  out[3] = out[1]! + BASE_CHUNK_SIZE;
  return out;
}

function chunkOfPoint(l: BaseLayout, x: number, y: number): number {
  const n = l.chunksAcross;
  const cx = Math.min(n - 1, Math.max(0, Math.floor((x + l.half) / BASE_CHUNK_SIZE)));
  const cy = Math.min(n - 1, Math.max(0, Math.floor((y + l.half) / BASE_CHUNK_SIZE)));
  return cy * n + cx;
}

/** Union of half-open intervals → sorted, merged, non-adjacent list. */
function mergeIntervals(iv: Array<[number, number]>): Array<[number, number]> {
  iv.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Symmetric difference of two merged interval lists. */
function xorIntervals(p: Array<[number, number]>, q: Array<[number, number]>): Array<[number, number]> {
  const pts = new Set<number>();
  for (const [a, b] of p) { pts.add(a); pts.add(b); }
  for (const [a, b] of q) { pts.add(a); pts.add(b); }
  const xs = [...pts].sort((a, b) => a - b);
  const inP = (x: number): boolean => p.some(([a, b]) => x >= a && x < b);
  const inQ = (x: number): boolean => q.some(([a, b]) => x >= a && x < b);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]!, b = xs[i + 1]!;
    if (inP(a) !== inQ(a)) {
      const last = out[out.length - 1];
      if (last && last[1] === a) last[1] = b;
      else out.push([a, b]);
    }
  }
  return out;
}

/**
 * Boundary segments of the union of solid, alive pieces, in BASE-LOCAL
 * integer coordinates: flat [x0, y0, x1, y1, ...] per segment.
 */
export function baseOutlineSegments(l: BaseLayout, dead?: Uint32Array | null): Int32Array {
  const rx0: number[] = [], ry0: number[] = [], rx1: number[] = [], ry1: number[] = [];
  for (let i = 0; i < l.count; i++) {
    if (!basePieceKindAt(l.kind[i]!).solid || isPieceDead(dead, i)) continue;
    rx0.push(l.x[i]!); ry0.push(l.y[i]!); rx1.push(l.x[i]! + l.w[i]!); ry1.push(l.y[i]! + l.h[i]!);
  }
  const segs: number[] = [];
  // Horizontal edges at each distinct y: coverage just below XOR just above.
  emitAxis(rx0, ry0, rx1, ry1, (y, a, b) => segs.push(a, y, b, y));
  // Vertical edges: same sweep with axes swapped.
  emitAxis(ry0, rx0, ry1, rx1, (x, a, b) => segs.push(x, a, x, b));
  return Int32Array.from(segs);
}

function emitAxis(
  a0: number[], b0: number[], a1: number[], b1: number[],
  emit: (line: number, from: number, to: number) => void,
): void {
  const lines = [...new Set([...b0, ...b1])].sort((p, q) => p - q);
  for (const line of lines) {
    const below: Array<[number, number]> = [];
    const above: Array<[number, number]> = [];
    for (let i = 0; i < a0.length; i++) {
      if (b0[i]! < line && line <= b1[i]!) below.push([a0[i]!, a1[i]!]);
      if (b0[i]! <= line && line < b1[i]!) above.push([a0[i]!, a1[i]!]);
    }
    for (const [from, to] of xorIntervals(mergeIntervals(below), mergeIntervals(above))) emit(line, from, to);
  }
}

/**
 * Per-chunk polyline collider geometry (world space). Chunks with no
 * segments get an empty outline (no body is spawned).
 */
export function buildChunkOutlines(l: BaseLayout, dead?: Uint32Array | null): ChunkOutline[] {
  const segs = baseOutlineSegments(l, dead);
  const perChunk: number[][] = [];
  for (let c = 0; c < chunkCount(l); c++) perChunk.push([]);
  for (let s = 0; s < segs.length; s += 4) {
    perChunk[chunkOfPoint(l, segs[s]!, segs[s + 1]!)]!.push(segs[s]!, segs[s + 1]!, segs[s + 2]!, segs[s + 3]!);
  }
  const ox = l.descriptor.x, oy = l.descriptor.y;
  return perChunk.map((list) => {
    const n = list.length / 4;
    const vertices = new Float32Array(n * 4);
    const indices = new Uint32Array(n * 2);
    for (let k = 0; k < n; k++) {
      vertices[k * 4] = ox + list[k * 4]!;
      vertices[k * 4 + 1] = oy + list[k * 4 + 1]!;
      vertices[k * 4 + 2] = ox + list[k * 4 + 2]!;
      vertices[k * 4 + 3] = oy + list[k * 4 + 3]!;
      indices[k * 2] = k * 2;
      indices[k * 2 + 1] = k * 2 + 1;
    }
    return { vertices, indices };
  });
}
