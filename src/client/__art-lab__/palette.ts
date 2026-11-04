/**
 * Art lab — OKLab colour maths and pixel-art palette ramps.
 *
 * Pixel-art ramps follow the usual hand-painting rule: shadows shift toward
 * blue-violet, highlights toward warm yellow, chroma peaks in the mid-tones.
 * Built in OKLCh so the steps are perceptually even.
 */

export type RGB = [number, number, number];

import { linToSrgb, srgbToLin } from '../render/art/color.js';

export { linToSrgb, srgbToLin };

export function linToOklab([r, g, b]: RGB): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export function oklabToLin([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function hexToLin(hex: number): RGB {
  return [srgbToLin(((hex >> 16) & 255) / 255), srgbToLin(((hex >> 8) & 255) / 255), srgbToLin((hex & 255) / 255)];
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * An `n`-step ramp (dark → light) around `hex`, as sRGB bytes [r,g,b] per step.
 * `lo`/`hi` bound the lightness (OKLab L).
 */
export function ramp(hex: number, n: number, lo = 0.16, hi = 0.93): Array<[number, number, number]> {
  const [L0, a0, b0] = linToOklab(hexToLin(hex));
  const C0 = Math.max(0.012, Math.hypot(a0, b0));
  const h0 = Math.atan2(b0, a0);
  const cool = (265 / 180) * Math.PI, warm = (95 / 180) * Math.PI;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    // Keep the base colour near the 60 % step so the identity colour survives.
    const L = t < 0.6 ? lo + (L0 - lo) * (t / 0.6) : L0 + (hi - L0) * ((t - 0.6) / 0.4);
    const C = C0 * (0.55 + 0.6 * Math.sin(Math.PI * Math.min(1, t * 1.1)));
    let h = lerpAngle(h0, cool, 0.38 * Math.pow(1 - t, 1.5));
    h = lerpAngle(h, warm, 0.22 * t * t);
    const lab: RGB = [Math.max(0, Math.min(1, L)), C * Math.cos(h), C * Math.sin(h)];
    const [r, g, b] = oklabToLin(lab);
    out.push([Math.round(linToSrgb(r) * 255), Math.round(linToSrgb(g) * 255), Math.round(linToSrgb(b) * 255)]);
  }
  return out;
}

/** 4×4 Bayer matrix, 0..1 thresholds. */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
