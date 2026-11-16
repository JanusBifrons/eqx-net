/**
 * Dense nebula look R&D (Nebulae stream, 2026-11-16; owner: "how do you get
 * it to look and feel like a very dense nebula?"). Behind `?neblook=`.
 *
 * One seeded style drives everything: colours (one dominant hue, a second
 * hue, or a rainbow sweep), how thick the cloud is, how many depth layers,
 * dark dust, glowing star knots inside the cloud and lightning. The three
 * presets are corners of the same parameter space, so "blend them" is a
 * parameter mix, not a new renderer. Pure and DOM-free (runs in a bake
 * worker); textures are straight sRGB RGBA like the rest of `fxTextures`.
 */
import { h01, pfbm, type Img } from './fxTextures.js';

export const NEB_LOOK_PRESETS = ['fog', 'rainbow', 'storm'] as const;
export type NebLookPreset = (typeof NEB_LOOK_PRESETS)[number];

export interface NebulaStyle {
  preset: NebLookPreset;
  seed: number;
  /** Dominant and secondary hue (0..1 round the colour wheel). */
  hueA: number;
  hueB: number;
  /** How far the hue sweeps across the cloud (0 = one colour, 1 = rainbow). */
  rainbow: number;
  /** Colour saturation (0..1). */
  sat: number;
  /** Cloud cover and opacity (0..1). */
  thickness: number;
  /** Turbulence: how folded and stringy the gas is (0..1). */
  turbulence: number;
  /** Cloud layers behind the world (depths), at high quality. */
  layers: number;
  /** Puff slices in front of the world, at high quality. */
  frontSlices: number;
  /** Dark dust lanes (0..1). */
  dust: number;
  /** Glowing star knots inside the cloud (count on screen-ish). */
  knots: number;
  /** Lightning flashes per minute (0 = none). */
  lightning: number;
  /** How much the background stars are hidden (0..1). */
  dim: number;
  /** Full-screen colour grade strength. */
  grade: number;
}

const frac = (v: number): number => v - Math.floor(v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The style for `preset` and `seed`: the preset sets the ranges, the seed
 *  picks within them (colours above all). Deterministic. */
export function nebulaStyle(preset: NebLookPreset, seed: number): NebulaStyle {
  const r = (k: number): number => h01(seed * 7919 + k, 0x6e6562);
  switch (preset) {
    case 'fog': {
      // One dominant colour, thick, many layers: you're IN it.
      const hueA = r(1);
      return {
        preset, seed, hueA, hueB: frac(hueA + 0.06 + 0.08 * r(2)), rainbow: 0.04, sat: lerp(0.55, 0.8, r(3)),
        thickness: lerp(0.8, 0.95, r(4)), turbulence: 0.35, layers: 6, frontSlices: 3,
        dust: 0.45, knots: 5, lightning: 0, dim: 0.85, grade: 0.11,
      };
    }
    case 'rainbow': {
      // The whole wheel across the cloud, bright filaments, sparkle.
      return {
        preset, seed, hueA: r(1), hueB: frac(r(1) + 0.5), rainbow: lerp(0.8, 1, r(2)), sat: lerp(0.75, 0.95, r(3)),
        thickness: lerp(0.6, 0.75, r(4)), turbulence: 0.6, layers: 5, frontSlices: 2,
        dust: 0.12, knots: 14, lightning: 0, dim: 0.6, grade: 0.05,
      };
    }
    case 'storm': {
      // Hot emission (red/magenta/orange) against cold blue, dark pillars, lightning.
      const hueA = frac(0.94 + 0.12 * r(1));
      return {
        preset, seed, hueA, hueB: lerp(0.55, 0.66, r(2)), rainbow: 0.12, sat: lerp(0.7, 0.9, r(3)),
        thickness: lerp(0.7, 0.85, r(4)), turbulence: 0.85, layers: 5, frontSlices: 3,
        dust: 0.9, knots: 8, lightning: lerp(8, 14, r(5)), dim: 0.75, grade: 0.08,
      };
    }
  }
}

/** `?neblook=fog|rainbow|storm[&nebseed=N]` → "preset:seed", or undefined. */
export function resolveNebLook(search: string): string | undefined {
  const m = /[?&]neblook=(fog|rainbow|storm)\b/.exec(search);
  if (!m) return undefined;
  const s = /[?&]nebseed=(\d{1,6})\b/.exec(search);
  return `${m[1]}:${s ? Number(s[1]) : 1}`;
}

/** "preset:seed" → style, or null when not a valid look. */
export function parseNebLook(v: string | undefined): NebulaStyle | null {
  if (!v) return null;
  const [p, s] = v.split(':');
  if (!(NEB_LOOK_PRESETS as readonly string[]).includes(p ?? '')) return null;
  return nebulaStyle(p as NebLookPreset, Number(s) || 1);
}

/** Linear-light RGB of hue `h`, saturation `s`, value `v`. */
export function hsvLinear(h: number, s: number, v: number, out: [number, number, number]): [number, number, number] {
  const k = (n: number): number => {
    const x = (n + h * 6) % 6;
    return v * (1 - s * Math.max(0, Math.min(1, Math.min(x, 4 - x))));
  };
  // sRGB-ish → linear so the bake's gamma lands on the intended colour.
  out[0] = Math.pow(k(5), 2.2); out[1] = Math.pow(k(3), 2.2); out[2] = Math.pow(k(1), 2.2);
  return out;
}

/** Tint (0xRRGGBB) of hue `h` at saturation `s`, full value (for sprites). */
export function hueTint(h: number, s: number): number {
  const k = (n: number): number => {
    const x = (n + frac(h) * 6) % 6;
    return 1 - s * Math.max(0, Math.min(1, Math.min(x, 4 - x)));
  };
  return (Math.round(k(5) * 255) << 16) | (Math.round(k(3) * 255) << 8) | Math.round(k(1) * 255);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function put(o: Img, i: number, rgb: [number, number, number], a: number): void {
  const p = i * 4;
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
  const k = m > 1 ? 1 / m : 1;
  o.data[p] = Math.round(Math.pow(clamp01(rgb[0] * k), 1 / 2.2) * 255);
  o.data[p + 1] = Math.round(Math.pow(clamp01(rgb[1] * k), 1 / 2.2) * 255);
  o.data[p + 2] = Math.round(Math.pow(clamp01(rgb[2] * k), 1 / 2.2) * 255);
  o.data[p + 3] = Math.round(clamp01(a) * 255);
}

/** Colour and alpha of the gas at tile coords (u, v): shared by the layer
 *  tiles and the front puffs so every depth reads as the same cloud. */
function gasAt(st: NebulaStyle, u: number, v: number, base: number, seed: number, out: [number, number, number]): number {
  const warp = 0.3 + 0.35 * st.turbulence;
  const qx = pfbm(u, v, base, 4, seed), qy = pfbm(u, v, base, 4, seed + 17);
  const wu = u + (qx - 0.5) * warp, wv = v + (qy - 0.5) * warp;
  const d = pfbm(wu, wv, base + 1, 6, seed + 40);
  // Ridged noise = bright filaments along folds (stronger with turbulence).
  const ridge = 1 - Math.abs(2 * pfbm(wu * 2, wv * 2, (base + 1) * 2, 4, seed + 60) - 1);
  const fil = Math.pow(ridge, 3) * st.turbulence;
  const t0 = 0.56 - 0.26 * st.thickness;
  const m = smooth(t0, t0 + 0.32, d);
  const hot = smooth(0.62, 0.95, d * 0.65 + fil * 0.55) * m;
  // Hue: dominant -> secondary by a slow field, plus the rainbow sweep.
  const mixT = smooth(0.3, 0.7, pfbm(u, v, 2, 3, seed + 90));
  const sweep = pfbm(u, v, 1, 3, seed + 120) * 2.4;
  const hue = frac(lerp(st.hueA, st.hueA + (frac(st.hueB - st.hueA + 0.5) - 0.5), mixT) + st.rainbow * sweep);
  // Hot cores whiten and brighten (gas lit from inside).
  hsvLinear(hue, st.sat * (1 - 0.55 * hot), 0.5 + 0.5 * m + 0.8 * hot, out);
  return clamp01(m * (0.4 + 0.45 * st.thickness) + hot * 0.45 + fil * m * 0.3);
}

/** One tileable cloud layer (depth `layer` of the style's layers). */
export function nebulaLayerTex(st: NebulaStyle, layer: number, size = 512): Img {
  const o: Img = { w: size, h: size, data: new Uint8ClampedArray(size * size * 4) };
  const rgb: [number, number, number] = [0, 0, 0];
  const seed = st.seed * 101 + layer * 977;
  const base = 2 + (layer % 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = gasAt(st, x / size, y / size, base, seed, rgb);
      put(o, y * size + x, rgb, a);
    }
  }
  return o;
}

/** A soft cloud puff (not tileable) for the slices in front of the world. */
export function nebulaPuffTex(st: NebulaStyle, i: number, size = 256): Img {
  const o: Img = { w: size, h: size, data: new Uint8ClampedArray(size * size * 4) };
  const rgb: [number, number, number] = [0, 0, 0];
  const c = (size - 1) / 2;
  const seed = st.seed * 131 + i * 389 + 5000;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      const a = gasAt(st, x / size, y / size, 2, seed, rgb) * smooth(1, 0.35, r);
      put(o, y * size + x, rgb, a);
    }
  }
  return o;
}

/** Dark dust lanes (tileable, normal blend): near-black, faintly tinted by
 *  the dominant hue, stringy where the style is turbulent. */
export function nebulaDustTex(st: NebulaStyle, size = 512): Img {
  const o: Img = { w: size, h: size, data: new Uint8ClampedArray(size * size * 4) };
  const rgb: [number, number, number] = [0, 0, 0];
  hsvLinear(st.hueA, 0.6, 0.07, rgb);
  const seed = st.seed * 53 + 7000;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const qx = pfbm(u, v, 2, 4, seed), qy = pfbm(u, v, 2, 4, seed + 9);
      const wu = u + (qx - 0.5) * (0.4 + 0.4 * st.turbulence), wv = v + (qy - 0.5) * (0.4 + 0.4 * st.turbulence);
      const d = pfbm(wu, wv, 3, 6, seed + 20);
      const lane = smooth(0.5, 0.7, d) * (0.65 + 0.45 * pfbm(wu * 3, wv * 3, 9, 3, seed + 30));
      put(o, y * size + x, rgb, lane * 0.95);
    }
  }
  return o;
}

/** Bake entry for the fx job: variant "preset:seed.L<n>" | ".P<n>" | ".D". */
export function bakeNebLook(variant: string | undefined): Img {
  const [look, part] = (variant ?? 'fog:1.L0').split('.');
  const st = parseNebLook(look) ?? nebulaStyle('fog', 1);
  const n = Number((part ?? 'L0').slice(1)) || 0;
  if (part?.startsWith('P')) return nebulaPuffTex(st, n);
  if (part === 'D') return nebulaDustTex(st);
  return nebulaLayerTex(st, n);
}
