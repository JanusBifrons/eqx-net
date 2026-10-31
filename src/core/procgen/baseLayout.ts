/**
 * Base layout container — flat typed arrays, no per-piece objects
 * (plan: soft-leaping-truffle; budget: MAX_LAYOUT_BYTES_PER_BASE).
 *
 * Coordinates are BASE-LOCAL integers (the base origin is the descriptor's
 * x/y). Every piece is an axis-aligned rectangle stored by its min corner +
 * size, and lies entirely inside ONE chunk: `addRect` splits rectangles at
 * chunk boundaries, so a chunk's trimesh, culling rect and destroy-rebuild are
 * exact. Chunks are `BASE_CHUNK_SIZE` squares anchored at the base's local
 * min corner (-half, -half).
 *
 * Generation runs once per base (room create / client chunk stream), never in
 * a per-tick path, so the builder may grow its arrays.
 */
import { BASE_CHUNK_SIZE } from '../../shared-types/baseBudgets.js';
import { fnvMixU32 } from './rng.js';

export type BaseArchetype = 'warehouse' | 'city';

/** Bump on ANY change to generator output (the layout-hash lock enforces it). */
export const BASE_GENERATOR_VERSION = 3; // v3: density retune (v2 scale read sparse)

export interface BaseDescriptor {
  /** Generator version the layout was produced with. */
  readonly ver: number;
  readonly archetype: BaseArchetype;
  /** u32 seed. */
  readonly seed: number;
  /** World-space origin (integer u). */
  readonly x: number;
  readonly y: number;
  /** Footprint disc diameter (u). */
  readonly size: number;
}

export interface BaseLayout {
  readonly descriptor: BaseDescriptor;
  /** Half the side of the base's square footprint box (local coords in ±half). */
  readonly half: number;
  readonly chunksAcross: number;
  readonly count: number;
  readonly kind: Uint8Array;
  /** Min corner, base-local. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly w: Int32Array;
  readonly h: Int32Array;
  readonly chunk: Uint16Array;
  /** Gate centres (base-local), flat [x0, y0, x1, y1, ...]. */
  readonly gates: Int32Array;
  /** Re-seed attempts the validator needed (0 = first try passed). */
  readonly attempts: number;
}

export class LayoutBuilder {
  private n = 0;
  private cap = 256;
  private kind = new Uint8Array(this.cap);
  private x = new Int32Array(this.cap);
  private y = new Int32Array(this.cap);
  private w = new Int32Array(this.cap);
  private h = new Int32Array(this.cap);
  private chunk = new Uint16Array(this.cap);
  private readonly gateList: number[] = [];

  readonly chunksAcross: number;

  constructor(readonly half: number) {
    this.chunksAcross = Math.max(1, Math.ceil((2 * half) / BASE_CHUNK_SIZE));
  }

  /** Add an axis-aligned rectangle [x0,x1)×[y0,y1), split at chunk lines. */
  addRect(kindIndex: number, x0: number, y0: number, x1: number, y1: number): void {
    if (x1 <= x0 || y1 <= y0) return;
    const origin = -this.half;
    const cx0 = Math.floor((x0 - origin) / BASE_CHUNK_SIZE);
    const cx1 = Math.floor((x1 - 1 - origin) / BASE_CHUNK_SIZE);
    const cy0 = Math.floor((y0 - origin) / BASE_CHUNK_SIZE);
    const cy1 = Math.floor((y1 - 1 - origin) / BASE_CHUNK_SIZE);
    for (let cy = cy0; cy <= cy1; cy++) {
      const by0 = Math.max(y0, origin + cy * BASE_CHUNK_SIZE);
      const by1 = Math.min(y1, origin + (cy + 1) * BASE_CHUNK_SIZE);
      for (let cx = cx0; cx <= cx1; cx++) {
        const bx0 = Math.max(x0, origin + cx * BASE_CHUNK_SIZE);
        const bx1 = Math.min(x1, origin + (cx + 1) * BASE_CHUNK_SIZE);
        if (bx1 > bx0 && by1 > by0) this.push(kindIndex, bx0, by0, bx1 - bx0, by1 - by0, cy * this.chunksAcross + cx);
      }
    }
  }

  addGate(x: number, y: number): void {
    this.gateList.push(x, y);
  }

  get count(): number {
    return this.n;
  }

  private push(k: number, x: number, y: number, w: number, h: number, c: number): void {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.kind[i] = k;
    this.x[i] = x;
    this.y[i] = y;
    this.w[i] = w;
    this.h[i] = h;
    this.chunk[i] = c;
  }

  private grow(): void {
    this.cap *= 2;
    const k = new Uint8Array(this.cap); k.set(this.kind); this.kind = k;
    const x = new Int32Array(this.cap); x.set(this.x); this.x = x;
    const y = new Int32Array(this.cap); y.set(this.y); this.y = y;
    const w = new Int32Array(this.cap); w.set(this.w); this.w = w;
    const h = new Int32Array(this.cap); h.set(this.h); this.h = h;
    const c = new Uint16Array(this.cap); c.set(this.chunk); this.chunk = c;
  }

  build(descriptor: BaseDescriptor, attempts: number): BaseLayout {
    const n = this.n;
    return {
      descriptor,
      half: this.half,
      chunksAcross: this.chunksAcross,
      count: n,
      kind: this.kind.slice(0, n),
      x: this.x.slice(0, n),
      y: this.y.slice(0, n),
      w: this.w.slice(0, n),
      h: this.h.slice(0, n),
      chunk: this.chunk.slice(0, n),
      gates: Int32Array.from(this.gateList),
      attempts,
    };
  }
}

/** Stable 32-bit hash of a layout's geometry — the version-lock fingerprint. */
export function layoutHash(l: BaseLayout): number {
  let h = 0x811c9dc5;
  h = fnvMixU32(h, l.count);
  h = fnvMixU32(h, l.half);
  for (let i = 0; i < l.count; i++) {
    h = fnvMixU32(h, l.kind[i]!);
    h = fnvMixU32(h, l.x[i]! >>> 0);
    h = fnvMixU32(h, l.y[i]! >>> 0);
    h = fnvMixU32(h, l.w[i]!);
    h = fnvMixU32(h, l.h[i]!);
    h = fnvMixU32(h, l.chunk[i]!);
  }
  for (let i = 0; i < l.gates.length; i++) h = fnvMixU32(h, l.gates[i]! >>> 0);
  return h >>> 0;
}

/** Bytes held by a layout's typed arrays (the MAX_LAYOUT_BYTES_PER_BASE lock). */
export function layoutBytes(l: BaseLayout): number {
  return (
    l.kind.byteLength + l.x.byteLength + l.y.byteLength + l.w.byteLength +
    l.h.byteLength + l.chunk.byteLength + l.gates.byteLength
  );
}
