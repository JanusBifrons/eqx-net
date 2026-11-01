/**
 * Deterministic, integer-only RNG streams for procedural generation
 * (plan: soft-leaping-truffle; method: docs/architecture/procedural-bases-research.md §2).
 *
 * The same layout must be produced on the server worker, the client predWorld
 * and the render worker (Invariant #15), so:
 *  - every sub-generator owns its OWN stream (`stream(seed, 'racks')`), so
 *    adding a step never shifts another step's numbers;
 *  - the API is integer-only (`u32`, `int`, `chance`) — no float results leak
 *    into geometry;
 *  - mulberry32 + FNV-1a use spec-defined integer ops (`Math.imul`, `>>>`),
 *    bit-identical on Node and every browser engine (same algorithm as
 *    `src/core/swarm/asteroidShape.ts` `mulberry32`).
 */

/** 32-bit FNV-1a over a string — stable across runs and engines. */
export function fnv1a32(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= s.charCodeAt(i) >>> 8;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mix a u32 into a running FNV-1a hash (4 bytes, little-endian). */
export function fnvMixU32(h: number, v: number): number {
  let x = h >>> 0;
  for (let b = 0; b < 4; b++) {
    x ^= (v >>> (b * 8)) & 0xff;
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x >>> 0;
}

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Next uniformly distributed unsigned 32-bit integer (mulberry32). */
  u32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Integer in [lo, hi] inclusive. `hi < lo` returns `lo`. */
  int(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    const span = hi - lo + 1;
    return lo + (this.u32() % span);
  }

  /** True with probability `num / den` (integer odds — no floats). */
  chance(num: number, den: number): boolean {
    return this.u32() % den < num;
  }

  /** Pick one element. */
  pick<T>(items: readonly T[]): T {
    return items[this.u32() % items.length]!;
  }
}

/** A named, independent stream derived from a base seed. */
export function stream(seed: number, name: string): Rng {
  return new Rng(fnvMixU32(fnv1a32(name), seed >>> 0));
}
