/**
 * Engine exhaust R&D (rnd/engine-fx): baked flame + ribbon textures and the
 * pure exhaust maths the lab arms share.
 *
 * Today's exhaust is particle dots shot astern at 200 u/s from one point
 * behind the ship. At cruise / boost (450–950 u/s) the dots land ~16 u apart
 * and the plume reads as a dotted line with nothing hot at the nozzle. The
 * candidates here are continuous instead:
 *  - a FLAME: a baked tapered plume sprite at each Machined nozzle, its
 *    length and colour driven by thrust and boost;
 *  - a RIBBON: a rope through the nozzle's recent positions (sampled in
 *    time, so it lengthens with speed and curves through turns), like the
 *    missile smoke but hot and additive.
 *
 * Textures follow fxTextures conventions: straight RGBA, white, tinted at
 * draw time. Everything is pure and DOM-free.
 */
import type { Img } from './fxTextures.js';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function img(w: number, h: number): Img {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

function putA(o: Img, i: number, a: number): void {
  const k = i * 4;
  o.data[k] = 255; o.data[k + 1] = 255; o.data[k + 2] = 255;
  o.data[k + 3] = Math.round(clamp01(a) * 255);
}

/**
 * A plume along +x: the nozzle mouth at u = 0, the tip at u = 1. It widens
 * a little just past the mouth, then tapers to a point; brightest along the
 * axis near the mouth. `core` > 0 narrows it into the white-hot inner cone.
 * Draw with anchor (0, 0.5), rotated to point astern.
 */
export function flameTex(w = 128, h = 32, core = 0): Img {
  const o = img(w, h);
  const narrow = 1 - 0.55 * clamp01(core);
  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w;
    // Half-width as a fraction of the texture height.
    const bulge = 0.78 + 0.22 * Math.sin(Math.min(1, u * 4) * Math.PI * 0.5);
    const rad = 0.5 * narrow * bulge * Math.pow(1 - u, 0.55);
    const along = Math.pow(1 - u, 1.25 + core) * smooth(0, 0.035, u);
    for (let y = 0; y < h; y++) {
      const v = Math.abs((y + 0.5) / h - 0.5);
      const q = rad > 1e-4 ? v / rad : 9;
      putA(o, y * w + x, along * Math.exp(-q * q * 2.2));
    }
  }
  return o;
}

/** Hot exhaust ribbon along +x: bright at the head (u = 0, the nozzle),
 *  fading to nothing at the tail. Soft across. Stretched over a MeshRope. */
export function exhaustTrailTex(w = 128, h = 16): Img {
  const o = img(w, h);
  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w;
    const along = Math.pow(1 - u, 1.6) * smooth(0, 0.02, u);
    // Tapers: full width at the nozzle, a third at the tail.
    const half = 1 - 0.65 * u;
    for (let y = 0; y < h; y++) {
      const v = (Math.abs((y + 0.5) / h - 0.5) * 2) / half;
      putA(o, y * w + x, along * Math.exp(-v * v * 2.8));
    }
  }
  return o;
}

// ------------------------------------------------------------------ maths

/** Ease `cur` toward `target` with time constant `tauSec` (frame-rate free). */
export function easeTo(cur: number, target: number, dtSec: number, tauSec: number): number {
  if (dtSec <= 0) return cur;
  return target + (cur - target) * Math.exp(-dtSec / tauSec);
}

export interface FlameShape { len: number; wid: number; alpha: number }

/**
 * Flame size for a nozzle of radius `r` (world units). `thrust` and `boost`
 * are eased 0..1 levels; `flick` is −1..1 noise. Idle keeps a small dim
 * pilot flame so a ship never looks dead; boost roughly doubles the length.
 */
export function flameShape(r: number, thrust: number, boost: number, flick: number, out: FlameShape): FlameShape {
  const t = clamp01(thrust), b = clamp01(boost);
  out.len = r * (1.4 + 7 * t + 8 * b) * (1 + 0.08 * flick);
  out.wid = r * (1.7 + 0.5 * t + 0.35 * b) * (1 + 0.04 * flick);
  out.alpha = 0.3 + 0.55 * t + 0.15 * b;
  return out;
}

/** Thrust → boost colour, packed 0xRRGGBB, at boost level `b` (0..1). */
export function exhaustTint(thrustRgb: number, boostRgb: number, b: number): number {
  const k = clamp01(b);
  const ch = (s: number): number => {
    const x = (thrustRgb >> s) & 255, y = (boostRgb >> s) & 255;
    return Math.round(x + (y - x) * k);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Fixed-capacity history of one nozzle's world positions, newest first.
 * Sampled on a fixed time step, so the trail is long at speed, short when
 * slow, and follows the ship's path through turns. No allocation after
 * construction.
 */
export class ExhaustRing {
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private head = 0;
  private n = 0;
  constructor(readonly capacity: number) {
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
  }
  reset(): void { this.n = 0; this.head = 0; }
  push(x: number, y: number): void {
    this.head = (this.head + this.capacity - 1) % this.capacity;
    this.xs[this.head] = x; this.ys[this.head] = y;
    if (this.n < this.capacity) this.n++;
  }
  get length(): number { return this.n; }
  /** k = 0 newest. Past the end it repeats the oldest sample. */
  x(k: number): number { return this.xs[(this.head + Math.min(k, this.n - 1)) % this.capacity]!; }
  y(k: number): number { return this.ys[(this.head + Math.min(k, this.n - 1)) % this.capacity]!; }
}
