/**
 * GPU-lit ship art (R&D, plan prancy-squishing-donut "GPU-lit ship art").
 *
 * Today each ship is baked 16 times, fully lit, one frame per sun angle
 * (SUN_STEPS). Here a ship keeps the UNLIT inputs of that light pass instead,
 * in one frame of three slices side by side, and the GPU lights it every
 * frame (litShipShader.ts). The maps don't depend on the sun, so one bake
 * serves every sector.
 *
 *   slice A: albedo (sRGB) + coverage
 *   slice B: normal x, normal y (z rebuilt), height (/ maxH), cavity
 *   slice C: emission (sqrt-encoded, / emisMax) + material id
 *
 * Every channel carries data, so the frame must be uploaded WITHOUT alpha
 * premultiplication (a canvas would destroy slices B and C).
 *
 * `shadeLitTexel` is the shader's maths in TypeScript: the reference the GLSL
 * mirrors line for line, and what the parity test checks against the CPU
 * light pass (`shade.ts` `radianceUncached`).
 */
import type { Fields } from './fields.js';
import { derivedMaps, matTables, tone, type Frame, type LightRig } from './shade.js';
import { linToSrgb, srgbToLin } from './color.js';

/** Clear texels between slices, so filtering never reads the next slice. */
export const LIT_GUTTER = 4;

export interface LitMaps {
  /** One frame: three slices of `w` texels, `LIT_GUTTER` apart. */
  frame: Frame;
  /** One slice's size and texels per world unit. */
  w: number; h: number; ppu: number;
  /** Height of the tallest texel (world units): slice B's height scale. */
  maxH: number;
  /** Brightest emission component: slice C's scale. */
  emisMax: number;
}

/** The x offset of slice `k` (0..2) within the frame, texels. */
export function sliceX(w: number, k: number): number { return k * (w + LIT_GUTTER); }

/** Encode a forged ship's light-pass inputs into the three slices. */
export function encodeLitMaps(f: Fields): LitMaps {
  const { w, h, ppu } = f.g;
  const { nx, ny, cav } = derivedMaps(f);
  let maxH = 1e-3, emisMax = 1e-3;
  for (let i = 0; i < w * h; i++) {
    if (f.height[i]! > maxH) maxH = f.height[i]!;
    for (let c = 0; c < 3; c++) if (f.emis[i * 3 + c]! > emisMax) emisMax = f.emis[i * 3 + c]!;
  }
  const W = 3 * w + 2 * LIT_GUTTER;
  const data = new Uint8ClampedArray(W * h * 4);
  const b8 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = (y * W + sliceX(w, 0) + x) * 4, b = (y * W + sliceX(w, 1) + x) * 4, c = (y * W + sliceX(w, 2) + x) * 4;
      data[a] = b8(linToSrgb(f.albedo[i * 3]!)); data[a + 1] = b8(linToSrgb(f.albedo[i * 3 + 1]!)); data[a + 2] = b8(linToSrgb(f.albedo[i * 3 + 2]!));
      data[a + 3] = b8(f.cov[i]!);
      data[b] = b8(nx[i]! * 0.5 + 0.5); data[b + 1] = b8(ny[i]! * 0.5 + 0.5); data[b + 2] = b8(f.height[i]! / maxH); data[b + 3] = b8(cav[i]!);
      data[c] = b8(Math.sqrt(f.emis[i * 3]! / emisMax)); data[c + 1] = b8(Math.sqrt(f.emis[i * 3 + 1]! / emisMax)); data[c + 2] = b8(Math.sqrt(f.emis[i * 3 + 2]! / emisMax));
      data[c + 3] = f.mat[i]! * 16;
    }
  }
  return { frame: { w: W, h, data }, w, h, ppu, maxH, emisMax };
}

/** One slice texel decoded (what the shader reads). */
export interface LitTexel {
  albedo: [number, number, number]; cov: number;
  nx: number; ny: number; nz: number; height: number; cav: number;
  emis: [number, number, number]; mat: number;
}

export function decodeTexel(m: LitMaps, x: number, y: number, out: LitTexel): LitTexel {
  const d = m.frame.data, W = m.frame.w;
  const a = (y * W + sliceX(m.w, 0) + x) * 4, b = (y * W + sliceX(m.w, 1) + x) * 4, c = (y * W + sliceX(m.w, 2) + x) * 4;
  out.albedo[0] = srgbToLin(d[a]! / 255); out.albedo[1] = srgbToLin(d[a + 1]! / 255); out.albedo[2] = srgbToLin(d[a + 2]! / 255);
  out.cov = d[a + 3]! / 255;
  out.nx = (d[b]! / 255) * 2 - 1; out.ny = (d[b + 1]! / 255) * 2 - 1;
  out.nz = Math.sqrt(Math.max(0, 1 - out.nx * out.nx - out.ny * out.ny));
  out.height = (d[b + 2]! / 255) * m.maxH; out.cav = d[b + 3]! / 255;
  for (let k = 0; k < 3; k++) { const e = d[c + k]! / 255; out.emis[k] = e * e * m.emisMax; }
  out.mat = Math.round(d[c + 3]! / 16);
  return out;
}

const MAT = matTables();

/** Shadow by marching the stored height toward the sun (as `shade.ts`
 *  `shadowMap`, at full resolution; `steps` caps the march, as the shader). */
export function litShadow(m: LitMaps, x: number, y: number, localAz: number, elev: number, steps: number, t: LitTexel): number {
  const stepT = Math.max(1, m.ppu * 0.75);
  const dx = Math.cos(localAz) * stepT, dy = Math.sin(localAz) * stepT;
  const rise = (Math.tan(elev) / m.ppu) * stepT;
  const maxSteps = Math.min(steps, Math.ceil(40 / 0.75), Math.ceil(m.maxH / Math.max(1e-4, rise)) + 2);
  const h0 = decodeTexel(m, x, y, t).height + 0.05;
  let occl = 0;
  for (let s = 1; s < maxSteps; s++) {
    const sx = (x + dx * s + 0.5) | 0, sy = (y + dy * s + 0.5) | 0;
    if (sx < 0 || sy < 0 || sx >= m.w || sy >= m.h) break;
    const ray = h0 + rise * s;
    if (ray > m.maxH) break;
    const d = decodeTexel(m, sx, sy, t).height - ray;
    if (d > 0) { occl = Math.max(occl, Math.min(1, d / 0.6)); if (occl >= 1) break; }
  }
  return 1 - occl * 0.85;
}

/**
 * The lit colour of one texel (linear light, before tone mapping): the
 * shader's maths. Mirrors `radianceUncached` term for term.
 */
export function shadeLitTexel(t: LitTexel, rig: LightRig, localAz: number, shadow: number, out: [number, number, number]): [number, number, number] {
  const ce = Math.cos(rig.sunElev);
  const L0 = Math.cos(localAz) * ce, L1 = Math.sin(localAz) * ce, L2 = Math.sin(rig.sunElev);
  let H0 = L0, H1 = L1, H2 = L2 + 1;
  const hl = Math.hypot(H0, H1, H2); H0 /= hl; H1 /= hl; H2 /= hl;
  const ndl = Math.max(0, t.nx * L0 + t.ny * L1 + t.nz * L2);
  const ndh = Math.max(0, t.nx * H0 + t.ny * H1 + t.nz * H2);
  const ao = 1 - 0.65 * t.cav;
  const sk = MAT.spec[t.mat] ?? 0;
  const spec = sk > 0 && ndh > 0 ? sk * Math.pow(ndh, MAT.gloss[t.mat] ?? 8) * shadow : 0;
  const nzi = 1 - t.nz;
  const rim = nzi * nzi * 1.6 * ao;
  const hemi = (0.55 + 0.45 * t.nz) * ao;
  const sunT = ndl * shadow * (0.35 + 0.65 * ao);
  for (let k = 0; k < 3; k++) {
    const a = t.albedo[k]!;
    out[k] = a * (rig.ambient[k]! * hemi + rig.sunColor[k]! * sunT) + rig.sunColor[k]! * spec * 0.6 + rig.rim[k]! * rim * (0.35 + a) + t.emis[k]!;
  }
  return out;
}

/** A whole frame lit from the maps on the CPU (the reference picture). */
export function litFrameFromMaps(m: LitMaps, rig: LightRig, localAz: number, shadowSteps: number): Frame {
  const data = new Uint8ClampedArray(m.w * m.h * 4);
  const t: LitTexel = { albedo: [0, 0, 0], cov: 0, nx: 0, ny: 0, nz: 1, height: 0, cav: 0, emis: [0, 0, 0], mat: 0 };
  const s: LitTexel = { albedo: [0, 0, 0], cov: 0, nx: 0, ny: 0, nz: 1, height: 0, cav: 0, emis: [0, 0, 0], mat: 0 };
  const rgb: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      decodeTexel(m, x, y, t);
      if (t.cov <= 0) continue;
      const sh = shadowSteps > 0 ? litShadow(m, x, y, localAz, rig.sunElev, shadowSteps, s) : 1;
      shadeLitTexel(t, rig, localAz, sh, rgb);
      const o = (y * m.w + x) * 4;
      for (let k = 0; k < 3; k++) data[o + k] = Math.round(linToSrgb(tone(rgb[k]! * rig.exposure)) * 255);
      data[o + 3] = Math.round(t.cov * 255);
    }
  }
  return { w: m.w, h: m.h, data };
}

/** Bytes the maps cost against today's 16 lit frames (memory check). */
export function litMapsBytes(m: LitMaps): number { return m.frame.w * m.frame.h * 4; }
