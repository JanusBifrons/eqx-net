/**
 * Art lab forge — polygon rasterising and the distance transform.
 *
 * Pure, allocation-at-bake-time only (never per frame). Everything here works
 * on plain typed arrays so it runs in node (unit tests), the main thread or a
 * worker alike.
 */

/** A bake grid: `w × h` texels, `ppu` texels per world unit, with the world
 *  origin (the entity centre) at texel `(ox, oy)`. Local space is Pixi-up:
 *  the nose of a ship is at -y. */
export interface Grid {
  w: number;
  h: number;
  ppu: number;
  ox: number;
  oy: number;
}

export type Poly = ReadonlyArray<readonly [number, number]>;

/** A grid big enough to hold `polys` (world units) plus `marginU` on every side. */
export function gridFor(polys: readonly Poly[], ppu: number, marginU: number): Grid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) {
    for (const [x, y] of p) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  // Symmetric about the centre so the sprite anchor is the texture centre.
  const hx = Math.max(Math.abs(x0), Math.abs(x1)) + marginU;
  const hy = Math.max(Math.abs(y0), Math.abs(y1)) + marginU;
  const w = Math.ceil(hx * 2 * ppu);
  const h = Math.ceil(hy * 2 * ppu);
  return { w, h, ppu, ox: w / 2, oy: h / 2 };
}

/** Even-odd point-in-polygon. */
export function insidePoly(p: Poly, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i]![0], yi = p[i]![1], xj = p[j]![0], yj = p[j]![1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Coverage (0..1) of polygon `p` over the grid, `ss × ss` samples per texel. */
export function rasterPoly(g: Grid, p: Poly, ss = 4): Float32Array {
  const out = new Float32Array(g.w * g.h);
  // Bounding box in texels.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const tx0 = Math.max(0, Math.floor(x0 * g.ppu + g.ox) - 1);
  const tx1 = Math.min(g.w - 1, Math.ceil(x1 * g.ppu + g.ox) + 1);
  const ty0 = Math.max(0, Math.floor(y0 * g.ppu + g.oy) - 1);
  const ty1 = Math.min(g.h - 1, Math.ceil(y1 * g.ppu + g.oy) + 1);
  const inv = 1 / (ss * ss);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      let n = 0;
      for (let sy = 0; sy < ss; sy++) {
        const wy = (ty + (sy + 0.5) / ss - g.oy) / g.ppu;
        for (let sx = 0; sx < ss; sx++) {
          const wx = (tx + (sx + 0.5) / ss - g.ox) / g.ppu;
          if (insidePoly(p, wx, wy)) n++;
        }
      }
      out[ty * g.w + tx] = n * inv;
    }
  }
  return out;
}

const BIG = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher 2012). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -BIG;
  z[1] = BIG;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = BIG;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/**
 * Euclidean distance (texels) from each texel INSIDE `mask` (> 0.5) to the
 * nearest texel outside it; 0 outside. Exact, O(w·h).
 */
export function distanceInside(mask: Float32Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i]! > 0.5 ? BIG : 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]!;
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i]!);
  return out;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (kind ids → seeds). */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Box blur (separable, radius r texels, clamped edges), for cavity / AO.
 *  Sliding window: O(1) per texel whatever the radius. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}
