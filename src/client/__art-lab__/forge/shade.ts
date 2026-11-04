/**
 * Art lab forge — the light pass, baked.
 *
 *  - `litFrame`: one fully lit RGBA frame (sun at a given LOCAL azimuth), for
 *    the "Machined" look. A ship keeps N of these (one per sun azimuth) and
 *    cross-fades the two nearest at run time, so the light never pops while
 *    the hull itself rotates freely. Structures don't rotate: one frame.
 *  - `pixelFrame`: the "Lit pixel" look. The hull is rotated AND lit in the
 *    bake, then snapped to per-material palette ramps with ordered dither on
 *    the light bands only, hard-edged, with a 1 px outline. Drawn unrotated on
 *    a snapped grid, so nearest sampling never invents a colour.
 *
 * Everything is linear-light internally and tone-mapped once on output.
 */
import { MAT, cavity, type Fields } from './fields.js';
import { boxBlur } from './raster.js';
import { BAYER4, linToSrgb, ramp } from './palette.js';

export interface LightRig {
  /** World azimuth TO the sun, radians, Pixi space (x right, y down). */
  sunAz: number;
  /** Sun elevation above the plane, radians. */
  sunElev: number;
  sunColor: [number, number, number];
  ambient: [number, number, number];
  rim: [number, number, number];
  exposure: number;
}

export const DEFAULT_RIG: LightRig = {
  sunAz: (-35 / 180) * Math.PI,
  sunElev: (38 / 180) * Math.PI,
  sunColor: [1.5, 1.36, 1.2],
  ambient: [0.05, 0.06, 0.095],
  rim: [0.1, 0.18, 0.36],
  exposure: 1.0,
};

interface MatParams { gloss: number; spec: number }
const MATP: Record<number, MatParams> = {
  [MAT.NONE]: { gloss: 8, spec: 0 },
  [MAT.METAL]: { gloss: 34, spec: 0.35 },
  [MAT.PAINT]: { gloss: 18, spec: 0.16 },
  [MAT.TRIM]: { gloss: 8, spec: 0.04 },
  [MAT.GLASS]: { gloss: 90, spec: 1.6 },
  [MAT.NOZZLE]: { gloss: 10, spec: 0.08 },
  [MAT.LIGHT]: { gloss: 10, spec: 0.05 },
  [MAT.WINDOW]: { gloss: 60, spec: 0.6 },
};

/** Per-field-set cache of derived maps (normals, cavity). */
interface Derived { nx: Float32Array; ny: Float32Array; nz: Float32Array; cav: Float32Array }
const derivedCache = new WeakMap<Fields, Derived>();

function derived(f: Fields): Derived {
  const hit = derivedCache.get(f);
  if (hit) return hit;
  const { w, h, ppu } = f.g;
  const nx = new Float32Array(w * h), ny = new Float32Array(w * h), nz = new Float32Array(w * h);
  // A 1-texel blur first: the distance transform is exact but stepped, and
  // its steps otherwise show as streaks on the slopes.
  const H = ppu >= 2 ? boxBlur(f.height, w, h, 1) : f.height;
  const at = (x: number, y: number): number => H[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    const interiorRow = y > 0 && y < h - 1;
    for (let x = 0; x < w; x++) {
      // Sobel, slope in world units per world unit. Interior texels read the
      // field directly; only the border pays for clamping.
      let gx: number, gy: number;
      if (interiorRow && x > 0 && x < w - 1) {
        const c = y * w + x, u = c - w, d = c + w;
        const ul = H[u - 1]!, um = H[u]!, ur = H[u + 1]!, ml = H[c - 1]!, mr = H[c + 1]!, dl = H[d - 1]!, dm = H[d]!, dr = H[d + 1]!;
        gx = (ur + 2 * mr + dr - ul - 2 * ml - dl) / 8;
        gy = (dl + 2 * dm + dr - ul - 2 * um - ur) / 8;
      } else {
        gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
        gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
      }
      const sx = -gx * ppu, sy = -gy * ppu;
      const len = Math.hypot(sx, sy, 1);
      const i = y * w + x;
      nx[i] = sx / len; ny[i] = sy / len; nz[i] = 1 / len;
    }
  }
  const d = { nx, ny, nz, cav: cavity(f, 2.5) };
  derivedCache.set(f, d);
  return d;
}

/** Hard-ish sun shadow by marching the height field toward the sun. */
function shadowMap(f: Fields, az: number, elev: number): Float32Array {
  const { w, h, ppu } = f.g;
  const out = new Float32Array(w * h).fill(1);
  // March in steps of ~0.75 world units (not one texel), so the cost does
  // not grow with resolution; shadows here are soft anyway.
  const stepT = Math.max(1, ppu * 0.75);
  const dx = Math.cos(az) * stepT, dy = Math.sin(az) * stepT;
  const rise = (Math.tan(elev) / ppu) * stepT; // world units of rise per step
  let maxH = 0;
  for (let i = 0; i < f.height.length; i++) if (f.height[i]! > maxH) maxH = f.height[i]!;
  // Shadows longer than ~40 world units are clipped (rare, and soft anyway).
  const maxSteps = Math.min(Math.ceil(40 / 0.75), Math.ceil(maxH / Math.max(1e-4, rise)) + 2);
  // Marched at half resolution (each result fills a 2×2 block): shadows are
  // soft, and this is the light pass's biggest cost.
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = y * w + x;
      if (f.cov[i]! <= 0 && f.cov[Math.min(w * h - 1, i + w + 1)]! <= 0) continue;
      const h0 = f.height[i]! + 0.05;
      let occl = 0;
      for (let s = 1; s < maxSteps; s++) {
        const sx = (x + dx * s + 0.5) | 0, sy = (y + dy * s + 0.5) | 0;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) break;
        const ray = h0 + rise * s;
        if (ray > maxH) break;
        const d = f.height[sy * w + sx]! - ray;
        if (d > 0) { occl = Math.max(occl, Math.min(1, d / 0.6)); if (occl >= 1) break; }
      }
      const v = 1 - occl * 0.85;
      out[i] = v;
      if (x + 1 < w) out[i + 1] = v;
      if (y + 1 < h) { out[i + w] = v; if (x + 1 < w) out[i + w + 1] = v; }
    }
  }
  return out;
}

const radCache = new WeakMap<Fields, Map<string, Float32Array>>();

/** Linear-light radiance per texel (rgb) for a local sun azimuth (cached:
 *  re-baking a pixel zoom level reuses it). */
function radiance(f: Fields, rig: LightRig, localAz: number, shadows: boolean): Float32Array {
  const norm = ((localAz % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const key = norm.toFixed(5) + (shadows ? "s" : "") + rig.sunElev + rig.exposure;
  let m = radCache.get(f);
  if (!m) { m = new Map(); radCache.set(f, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const out = radianceUncached(f, rig, norm, shadows);
  m.set(key, out);
  return out;
}

function radianceUncached(f: Fields, rig: LightRig, localAz: number, shadows: boolean): Float32Array {
  const { nx, ny, nz, cav } = derived(f);
  const n = f.g.w * f.g.h;
  const out = new Float32Array(n * 3);
  const ce = Math.cos(rig.sunElev);
  const L = [Math.cos(localAz) * ce, Math.sin(localAz) * ce, Math.sin(rig.sunElev)];
  const Hv = [L[0]!, L[1]!, L[2]! + 1];
  const hl = Math.hypot(Hv[0]!, Hv[1]!, Hv[2]!);
  Hv[0]! /= hl; Hv[1]! /= hl; Hv[2]! /= hl;
  const sh = shadows ? shadowMap(f, localAz, rig.sunElev) : null;
  const gloss = new Float32Array(8), specK = new Float32Array(8);
  for (let k = 0; k < 8; k++) { const m = MATP[k] ?? MATP[MAT.METAL]!; gloss[k] = m.gloss; specK[k] = m.spec; }
  const [ar, ag, ab] = rig.ambient, [sr, sg, sb] = rig.sunColor, [rr, rg, rb] = rig.rim;
  for (let i = 0; i < n; i++) {
    if (f.cov[i]! <= 0) continue;
    const mi = f.mat[i]!;
    const ndl = Math.max(0, nx[i]! * L[0]! + ny[i]! * L[1]! + nz[i]! * L[2]!);
    const ndh = Math.max(0, nx[i]! * Hv[0]! + ny[i]! * Hv[1]! + nz[i]! * Hv[2]!);
    const ao = 1 - 0.65 * cav[i]!;
    const s = sh ? sh[i]! : 1;
    const sk = specK[mi]!;
    const spec = sk > 0 && ndh > 0 ? sk * Math.pow(ndh, gloss[mi]!) * s : 0;
    const nzi = 1 - nz[i]!;
    const rim = nzi * nzi * 1.6 * ao;
    const hemi = (0.55 + 0.45 * nz[i]!) * ao;
    const sunT = ndl * s * (0.35 + 0.65 * ao);
    const j = i * 3;
    const a0 = f.albedo[j]!, a1 = f.albedo[j + 1]!, a2 = f.albedo[j + 2]!;
    out[j] = a0 * (ar! * hemi + sr! * sunT) + sr! * spec * 0.6 + rr! * rim * (0.35 + a0) + f.emis[j]!;
    out[j + 1] = a1 * (ag! * hemi + sg! * sunT) + sg! * spec * 0.6 + rg! * rim * (0.35 + a1) + f.emis[j + 1]!;
    out[j + 2] = a2 * (ab! * hemi + sb! * sunT) + sb! * spec * 0.6 + rb! * rim * (0.35 + a2) + f.emis[j + 2]!;
  }
  return out;
}

function tone(x: number): number {
  // ACES fitted (Narkowicz).
  return Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

export interface Frame { w: number; h: number; data: Uint8ClampedArray }

/** Tone map + sRGB encode as a lookup table over linear radiance [0, 8). */
const OUT_LUT_SIZE = 4096, OUT_LUT_MAX = 8;
const OUT_LUT = new Uint8Array(OUT_LUT_SIZE);
for (let i = 0; i < OUT_LUT_SIZE; i++) OUT_LUT[i] = Math.round(linToSrgb(tone(((i + 0.5) / OUT_LUT_SIZE) * OUT_LUT_MAX)) * 255);
const OUT_LUT_K = OUT_LUT_SIZE / OUT_LUT_MAX;
function encode(x: number): number {
  const i = (x * OUT_LUT_K) | 0;
  return OUT_LUT[i < 0 ? 0 : i >= OUT_LUT_SIZE ? OUT_LUT_SIZE - 1 : i]!;
}

/** One fully lit RGBA frame (straight alpha, sRGB) at local sun azimuth. */
export function litFrame(f: Fields, rig: LightRig, localAz: number, shadows = true): Frame {
  const rad = radiance(f, rig, localAz, shadows);
  const n = f.g.w * f.g.h;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const a = f.cov[i]!;
    if (a <= 0) continue;
    const ex = rig.exposure;
    data[i * 4] = encode(rad[i * 3]! * ex);
    data[i * 4 + 1] = encode(rad[i * 3 + 1]! * ex);
    data[i * 4 + 2] = encode(rad[i * 3 + 2]! * ex);
    data[i * 4 + 3] = Math.round(a * 255);
  }
  return { w: f.g.w, h: f.g.h, data };
}

export interface PixelOpts {
  /** Output texels per world unit. */
  pd: number;
  /** Ramp steps per material (3..8). */
  steps: number;
  /** Dither strength between light bands (0..1). */
  dither: number;
  /** Sprite rotation baked into the frame (radians, Pixi sense). */
  rotation: number;
  outline: boolean;
  /** Output side override (square); default fits the rotated hull. */
  size?: number;
}

const rampCache = new Map<string, Array<[number, number, number]>>();
function rampFor(hex: number, steps: number): Array<[number, number, number]> {
  const k = `${hex}:${steps}`;
  let r = rampCache.get(k);
  if (!r) { r = ramp(hex, steps); rampCache.set(k, r); }
  return r;
}

function hexOfLinear(r: number, g: number, b: number): number {
  return (Math.round(linToSrgb(r) * 255) << 16) | (Math.round(linToSrgb(g) * 255) << 8) | Math.round(linToSrgb(b) * 255);
}

/** Pixel-art frame: rotated + lit + palette-snapped + dithered + outlined. */
export function pixelFrame(f: Fields, rig: LightRig, o: PixelOpts): Frame {
  const localAz = rig.sunAz - o.rotation;
  const rad = radiance(f, rig, localAz, true);
  const { w: fw, h: fh, ppu, ox, oy } = f.g;
  const halfDiag = Math.hypot(fw, fh) / 2 / ppu;
  const S = o.size ?? Math.ceil(halfDiag * 2 * o.pd) + 2;
  const data = new Uint8ClampedArray(S * S * 4);
  const solid = new Uint8Array(S * S);
  const cr = Math.cos(o.rotation), sr = Math.sin(o.rotation);
  const SS = 3;
  // Ramps per material. Paint keeps each texel's own albedo hue (composite
  // parts), so its ramp is keyed by the quantised albedo.
  for (let oy2 = 0; oy2 < S; oy2++) {
    for (let ox2 = 0; ox2 < S; ox2++) {
      let cov = 0, er = 0, eg = 0, eb = 0, I = 0;
      let centreMat = 0, centreIdx = -1;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (ox2 + (sx + 0.5) / SS - S / 2) / o.pd, v = (oy2 + (sy + 0.5) / SS - S / 2) / o.pd;
          const lx = u * cr + v * sr, ly = -u * sr + v * cr;
          const tx = Math.floor(lx * ppu + ox), ty = Math.floor(ly * ppu + oy);
          if (tx < 0 || ty < 0 || tx >= fw || ty >= fh) continue;
          const i = ty * fw + tx;
          const a = f.cov[i]!;
          if (a <= 0) continue;
          cov += a;
          const al = Math.max(0.02, (f.albedo[i * 3]! * 0.2126 + f.albedo[i * 3 + 1]! * 0.7152 + f.albedo[i * 3 + 2]! * 0.0722));
          const rl = rad[i * 3]! * 0.2126 + rad[i * 3 + 1]! * 0.7152 + rad[i * 3 + 2]! * 0.0722;
          I += a * (rl / al);
          er += a * f.emis[i * 3]!; eg += a * f.emis[i * 3 + 1]!; eb += a * f.emis[i * 3 + 2]!;
          if (sx === 1 && sy === 1) { centreMat = f.mat[i]!; centreIdx = i; }
        }
      }
      cov /= SS * SS;
      if (cov < 0.5) continue;
      const k = cov * SS * SS;
      I /= k; er /= k; eg /= k; eb /= k;
      if (centreIdx < 0) {
        // Centre sample fell outside: take any covered texel's material.
        const u = (ox2 + 0.5 - S / 2) / o.pd, v = (oy2 + 0.5 - S / 2) / o.pd;
        const lx = u * cr + v * sr, ly = -u * sr + v * cr;
        const tx = Math.min(fw - 1, Math.max(0, Math.round(lx * ppu + ox))), ty = Math.min(fh - 1, Math.max(0, Math.round(ly * ppu + oy)));
        centreIdx = ty * fw + tx;
        centreMat = f.mat[centreIdx]!;
      }
      const p = (oy2 * S + ox2) * 4;
      const el = er * 0.2126 + eg * 0.7152 + eb * 0.0722;
      let rgb: [number, number, number];
      if ((centreMat === MAT.LIGHT || centreMat === MAT.WINDOW || centreMat === MAT.NOZZLE) && el > 0.12) {
        const r2 = rampFor(hexOfLinear(Math.min(1, er), Math.min(1, eg), Math.min(1, eb)), 3);
        rgb = el > 0.5 ? r2[2]! : r2[1]!;
      } else {
        const rp = rampFor(f.key[centreIdx]! || 0x8a93a2, o.steps);
        // Grooves sit a step down their surface's ramp.
        if (centreMat === MAT.TRIM) I *= 0.45;
        const t = 1 - Math.exp(-I * 0.9);
        const th = BAYER4[(oy2 & 3) * 4 + (ox2 & 3)]! - 0.5;
        const idx = Math.max(0, Math.min(o.steps - 1, Math.floor(t * o.steps + th * o.dither)));
        rgb = rp[idx]!;
      }
      data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
      solid[oy2 * S + ox2] = 1;
    }
  }
  if (o.outline) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (solid[y * S + x]) continue;
        const nb = (x > 0 && solid[y * S + x - 1]) || (x < S - 1 && solid[y * S + x + 1]) || (y > 0 && solid[(y - 1) * S + x]) || (y < S - 1 && solid[(y + 1) * S + x]);
        if (!nb) continue;
        const p = (y * S + x) * 4;
        data[p] = 8; data[p + 1] = 9; data[p + 2] = 18; data[p + 3] = 255;
      }
    }
  }
  return { w: S, h: S, data };
}

/** Bytes per frame set, for the memory column. */
export function frameBytes(frames: readonly Frame[]): number {
  let b = 0;
  for (const fr of frames) b += fr.w * fr.h * 4;
  return b;
}
