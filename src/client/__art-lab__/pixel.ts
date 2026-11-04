/**
 * Art lab — the "Lit pixel" look (rejected 2026-11-03 in favour of Machined;
 * kept so the lab can still show the comparison).
 *
 * The hull is rotated AND lit in the bake, then snapped to per-material
 * palette ramps with ordered dither on the light bands only, hard-edged, with
 * a 1 px outline. Drawn unrotated on a snapped grid, so nearest sampling never
 * invents a colour.
 */
import { MAT, type Fields } from '../render/art/fields.js';
import { radiance, type Frame, type LightRig } from '../render/art/shade.js';
import { BAYER4, linToSrgb, ramp } from './palette.js';

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

