/**
 * Effects and environment textures, generated once (plan iridescent-seeking-rainbow v2).
 *
 * Same idea as the Machined forge: the expensive look (soft glows, fireballs,
 * hex shields, nebulae, star fields) is worked out once into plain pixel
 * buffers, then drawn every frame as cheap batched sprites. Everything here is
 * pure and DOM-free, so it runs in a bake worker or the render worker; the
 * caller turns an `Img` into a GPU texture.
 *
 * Conventions:
 *  - `Img.data` is straight (non-premultiplied) RGBA, sRGB.
 *  - Additive textures are white (tinted at draw time) unless noted.
 *  - "Tileable" textures wrap seamlessly (periodic noise / wrapped splats),
 *    so they can be drawn as a `TilingSprite`.
 */

import { exhaustTrailTex, flameTex } from './engineFx.js';

export interface Img { w: number; h: number; data: Uint8ClampedArray }

function img(w: number, h: number): Img {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Write a white pixel with alpha `a` (0..1). */
function putA(o: Img, i: number, a: number): void {
  const p = i * 4;
  o.data[p] = 255; o.data[p + 1] = 255; o.data[p + 2] = 255;
  o.data[p + 3] = Math.round(clamp01(a) * 255);
}

/** Linear-light RGB (0..∞) + alpha → straight sRGB-ish RGBA. Colour is
 *  normalised by its brightest channel so overbright stays hue-correct. */
function putRGBA(o: Img, i: number, r: number, g: number, b: number, a: number): void {
  const p = i * 4;
  const m = Math.max(r, g, b, 1e-6);
  const k = m > 1 ? 1 / m : 1;
  o.data[p] = Math.round(Math.pow(clamp01(r * k), 1 / 2.2) * 255);
  o.data[p + 1] = Math.round(Math.pow(clamp01(g * k), 1 / 2.2) * 255);
  o.data[p + 2] = Math.round(Math.pow(clamp01(b * k), 1 / 2.2) * 255);
  o.data[p + 3] = Math.round(clamp01(a) * 255);
}

// ------------------------------------------------------------------ noise

function lattice(a: number, b: number, seed: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise that repeats every `period` lattice cells (tileable). */
export function pnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const m = (v: number): number => ((v % period) + period) % period;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = lattice(x0, y0, seed), b = lattice(x1, y0, seed);
  const c = lattice(x0, y1, seed), d = lattice(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Tileable fractal noise in ~0..1. `u, v` in 0..1 over the tile. */
export function pfbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let n = 0, amp = 0.5, norm = 0, per = base;
  for (let o = 0; o < octaves; o++) {
    n += amp * pnoise(u * per, v * per, per, seed + o * 131);
    norm += amp; amp *= 0.5; per *= 2;
  }
  return n / norm;
}

/** Deterministic hash to 0..1. */
export function h01(a: number, seed: number): number {
  let h = Math.imul(a ^ seed, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ basic sprites

/** Soft radial glow: a sharp core plus a long soft tail (reads as light). */
export function glowTex(size = 64): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      const a = r >= 1 ? 0 : Math.exp(-r * r * 9) * 0.75 + Math.pow(1 - r, 3) * 0.25;
      putA(o, y * size + x, a * smooth(1, 0.85, r));
    }
  }
  return o;
}

/** Horizontal streak: bright capsule core, soft edges and ends. Anchor at
 *  (0, 0.5) and stretch along x for beams; centre-anchor for bolts. */
export function streakTex(w = 128, h = 32): Img {
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    const v = Math.abs((y + 0.5) / h - 0.5) * 2; // 0 centre .. 1 edge
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const ends = smooth(0, 0.18, u) * smooth(1, 0.82, u);
      const core = Math.exp(-v * v * 22);
      const halo = Math.exp(-v * v * 4) * 0.35;
      putA(o, y * w + x, (core + halo) * ends);
    }
  }
  return o;
}

/** A beam body that tiles along x: a hot core with drifting energy filaments.
 *  Draw as a `TilingSprite` and scroll `tilePosition.x` to make it flow. */
export function beamFlowTex(w = 256, h = 32, seed = 7): Img {
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    const v = ((y + 0.5) / h - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // Two filament bands, each a wandering line across the core.
      const w1 = (pfbm(u, 0.1, 4, 3, seed) - 0.5) * 0.9;
      const w2 = (pfbm(u, 0.6, 6, 3, seed + 9) - 0.5) * 0.9;
      const f1 = Math.exp(-Math.pow((v - w1) * 7, 2));
      const f2 = Math.exp(-Math.pow((v - w2) * 9, 2)) * 0.7;
      const pulse = 0.65 + 0.35 * pfbm(u, 0.3, 8, 2, seed + 3);
      const env = Math.exp(-v * v * 3);
      putA(o, y * w + x, clamp01((f1 + f2) * pulse * env * 0.9 + env * 0.15));
    }
  }
  return o;
}

/** Thin ring (shockwaves, shield rims). */
export function ringTex(size = 128, thickness = 0.07): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      const d = (r - (1 - thickness * 1.6)) / thickness;
      const a = Math.exp(-d * d * 1.6) + Math.exp(-Math.pow((r - 0.9) / 0.12, 2)) * 0.18;
      putA(o, y * size + x, a * smooth(1, 0.97, r));
    }
  }
  return o;
}

/** A spark: a short tapered dash, hot head on the right. Stretch along its velocity. */
export function sparkTex(w = 32, h = 8): Img {
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    const v = Math.abs((y + 0.5) / h - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const taper = Math.pow(u, 1.6) * smooth(1, 0.86, u);
      putA(o, y * w + x, Math.exp(-v * v * 10 / Math.max(0.15, u)) * taper * 1.2);
    }
  }
  return o;
}

/** A soft, lumpy smoke puff (white; tint grey and draw with normal blend). */
export function smokeTex(size = 64, seed = 3): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const n = pfbm(x / size, y / size, 4, 4, seed);
      const a = smooth(1, 0.25, r + (n - 0.5) * 0.55) * (0.55 + 0.6 * n);
      putA(o, y * size + x, a * 0.85);
    }
  }
  return o;
}

/** A trail ribbon texture: full at u=0 (the head), fading to nothing at u=1.
 *  Used on a rope mesh stretched along a ring buffer of past positions. */
export function trailTex(w = 128, h = 16): Img {
  const o = img(w, h);
  for (let y = 0; y < h; y++) {
    const v = Math.abs((y + 0.5) / h - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const along = Math.pow(1 - u, 1.4);
      putA(o, y * w + x, along * Math.exp(-v * v * 3.5) * smooth(0, 0.06, u));
    }
  }
  return o;
}

// ------------------------------------------------------------------ flipbooks

export interface Flipbook { sheet: Img; frames: number; cols: number; cell: number }

/** Colour ramp for fire: t=1 hottest (white) .. 0 (dark ember). Linear RGB. */
function fireRamp(t: number): [number, number, number] {
  const k = clamp01(t);
  if (k > 0.8) { const f = (k - 0.8) / 0.2; return [3.0, 2.6 + 0.4 * f, 1.6 + 1.4 * f]; }
  if (k > 0.55) { const f = (k - 0.55) / 0.25; return [2.4 + 0.6 * f, 1.1 + 1.5 * f, 0.25 + 1.35 * f]; }
  if (k > 0.3) { const f = (k - 0.3) / 0.25; return [1.1 + 1.3 * f, 0.28 + 0.82 * f, 0.05 + 0.2 * f]; }
  const f = k / 0.3; return [0.08 + 1.02 * f, 0.02 + 0.26 * f, 0.02 + 0.03 * f];
}

/**
 * A fireball's life as a flipbook (additive, coloured). Frame 0 is the white
 * flash; it swells, cools through yellow and orange and breaks up into
 * glowing tatters. Tileable noise keyed off the direction makes the edge lumpy
 * and lets holes eat through late in life.
 */
export function fireballFlipbook(frames = 16, cell = 128, seed = 11): Flipbook {
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);
  const sheet = img(cols * cell, rows * cell);
  const c = (cell - 1) / 2;
  for (let f = 0; f < frames; f++) {
    const t = f / (frames - 1);
    const R = 0.3 + 0.62 * (1 - Math.pow(1 - t, 2.2)); // grows fast, settles
    const ox = (f % cols) * cell, oy = Math.floor(f / cols) * cell;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const dx = (x - c) / c, dy = (y - c) / c;
        const r = Math.hypot(dx, dy);
        const u = (dx * 0.5 + 0.5), v = (dy * 0.5 + 0.5);
        // Turbulence drifts outward as the ball grows.
        const n1 = pfbm(u + t * 0.35, v - t * 0.2, 4, 5, seed);
        const n2 = pfbm(u * 1.3 - t * 0.5, v * 1.3 + t * 0.3, 6, 4, seed + 77);
        const edge = R * (0.72 + 0.5 * n1);
        const body = smooth(edge, edge * 0.55, r);
        // Holes eat through as it cools.
        const erode = smooth(t * 0.85 - 0.05, t * 0.85 + 0.18, n2 + (1 - r) * 0.25);
        const heat = clamp01((1 - r / Math.max(0.05, edge)) * 0.65 + n1 * 0.4) * Math.pow(1 - t, 1.1) + (1 - t) * 0.1;
        const flash = Math.exp(-r * r * 6) * Math.pow(1 - t, 6) * 1.4;
        const a = clamp01(body * erode * (0.35 + 0.65 * Math.pow(1 - t, 0.6)) + flash);
        const [cr, cg, cb] = fireRamp((heat + flash * 0.8) * 0.85);
        putRGBA(sheet, (oy + y) * sheet.w + ox + x, cr, cg, cb, a);
      }
    }
  }
  return { sheet, frames, cols, cell };
}

// ------------------------------------------------------------------ shields

/** Distance from p (in cell units) to the nearest edge of a pointy-top hex
 *  grid: 0 on an edge, 0.5 at a cell centre. */
export function hexEdgeDist(px: number, py: number): number {
  const sx = 1, sy = Math.sqrt(3);
  const mod = (a: number, m: number): number => a - m * Math.floor(a / m);
  const ax = mod(px, sx) - sx / 2, ay = mod(py, sy) - sy / 2;
  const bx = mod(px - sx / 2, sx) - sx / 2, by = mod(py - sy / 2, sy) - sy / 2;
  const useA = ax * ax + ay * ay < bx * bx + by * by;
  const gx = Math.abs(useA ? ax : bx), gy = Math.abs(useA ? ay : by);
  const d = Math.max(gx * 0.5 + gy * (Math.sqrt(3) / 2), gx);
  return 0.5 - d;
}

/** The whole dome at rest: hex lines strongest at the rim (white). Used for
 *  the shield-break flash and as the shader variant's reference look. */
export function shieldDomeTex(size = 256, cells = 7): Img {
  const o = img(size, size);
  const c = (size - 1) / 2, R = 0.94;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy) / R;
      if (r >= 1) { putA(o, y * size + x, 0); continue; }
      // Sphere-ish lens: cells crowd toward the rim.
      const z = Math.sqrt(1 - r * r);
      const lx = dx / (0.55 + 0.45 * z), ly = dy / (0.55 + 0.45 * z);
      const e = hexEdgeDist(lx * cells, ly * cells);
      const lines = Math.exp(-e * e * 900) * 0.9 + Math.exp(-e * e * 60) * 0.12;
      const fres = Math.pow(1 - z, 2.2);
      const rim = Math.exp(-Math.pow((1 - r) * 22, 2));
      putA(o, y * size + x, clamp01(lines * (0.25 + 0.75 * fres) + fres * 0.22 + rim * 0.7) * smooth(1, 0.985, r));
    }
  }
  return o;
}

/**
 * Shield hit (sprite variant): the dome lights up around a hit on its right
 * edge (+x) and a ripple of lit hex cells runs out from it, fading. Rotate the
 * sprite so +x faces the shot. White; tint per side.
 */
export function shieldHitFlipbook(frames = 12, cell = 192, cells = 7): Flipbook {
  const cols = 4;
  const rows = Math.ceil(frames / cols);
  const sheet = img(cols * cell, rows * cell);
  const c = (cell - 1) / 2, R = 0.94;
  for (let f = 0; f < frames; f++) {
    const t = f / (frames - 1);
    const ox = (f % cols) * cell, oy = Math.floor(f / cols) * cell;
    const front = 0.05 + t * 0.6; // ripple front distance (dome radii)
    const width = 0.1 + t * 0.12;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const dx = (x - c) / c, dy = (y - c) / c;
        const r = Math.hypot(dx, dy) / R;
        if (r >= 1) { putA(sheet, (oy + y) * sheet.w + ox + x, 0); continue; }
        const z = Math.sqrt(1 - r * r);
        const lx = dx / (0.55 + 0.45 * z), ly = dy / (0.55 + 0.45 * z);
        const e = hexEdgeDist(lx * cells, ly * cells);
        const lines = Math.exp(-e * e * 700);
        const fill = Math.exp(-e * e * 25) * 0.25;
        // Distance from the hit point (on the rim at +x), over the surface-ish.
        const d = Math.hypot(dx / R - 1, dy / R) * (0.8 + 0.2 * z);
        const ring = Math.exp(-Math.pow((d - front) / width, 2)) * Math.pow(1 - t, 1.6) * Math.exp(-d * 2.5);
        const spot = Math.exp(-d * d * 30) * Math.pow(1 - t, 2.5) * 2.2;
        const fres = Math.pow(1 - z, 1.6);
        const rimArc = Math.exp(-Math.pow((1 - r) * 16, 2)) * Math.exp(-Math.pow(Math.atan2(dy, dx) / 0.9, 2)) * Math.pow(1 - t, 1.8);
        const a = (lines + fill) * (ring + spot) * (0.45 + 0.55 * fres) + spot * 0.35 + rimArc * 0.9;
        putA(sheet, (oy + y) * sheet.w + ox + x, clamp01(a) * smooth(1, 0.985, r));
      }
    }
  }
  return { sheet, frames, cols, cell };
}

/**
 * A beam resting on a shield (the held contact): a bright spot where it lands
 * on the right edge (+x), the hex cells around it lit and fading with
 * distance, and the rim glowing on that side. Steady, unlike the hit
 * flipbook; the caller shimmers it. White; rotate so +x faces the beam.
 */
export function shieldContactTex(size = 192, cells = 7): Img {
  const o = img(size, size);
  const c = (size - 1) / 2, R = 0.94;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy) / R;
      if (r >= 1) { putA(o, y * size + x, 0); continue; }
      const z = Math.sqrt(1 - r * r);
      const lx = dx / (0.55 + 0.45 * z), ly = dy / (0.55 + 0.45 * z);
      const e = hexEdgeDist(lx * cells, ly * cells);
      const lines = Math.exp(-e * e * 700);
      const fill = Math.exp(-e * e * 25) * 0.3;
      const d = Math.hypot(dx / R - 1, dy / R) * (0.8 + 0.2 * z);
      const patch = Math.exp(-d * d * 14);
      const spot = Math.exp(-d * d * 140) * 2.2 + Math.exp(-d * d * 30) * 0.7;
      const rimArc = Math.exp(-Math.pow((1 - r) * 14, 2)) * Math.exp(-Math.pow(Math.atan2(dy, dx) / 0.8, 2));
      const a = (lines * 1.3 + fill) * patch * (0.55 + 0.45 * Math.pow(1 - z, 1.4)) + spot + rimArc * 0.8;
      putA(o, y * size + x, clamp01(a) * smooth(1, 0.985, r));
    }
  }
  return o;
}

// ------------------------------------------------------------------ shield fences

/**
 * A shield fence at rest (the wall between two emitters), drawn from short
 * segments, each one period of this strip. Like a ship shield it is nearly
 * invisible until hit: a thin bright energy line with a soft haze, and
 * brighter pulses travelling along it. Each flipbook frame shifts the pulses
 * by 1/frames of a period, so playing the frames makes the energy flow and the
 * loop is seamless. The hex pattern only appears where something hits it
 * (fenceRipple / fenceContact). White; tint per owner.
 */
export function fenceStripFlipbook(frames = 8, w = 128, h = 48): Flipbook {
  const cols = 2;
  const rows = Math.ceil(frames / cols);
  const sheet = img(cols * w, rows * h);
  for (let f = 0; f < frames; f++) {
    const ph = f / frames;
    const ox = (f % cols) * w, oy = Math.floor(f / cols) * h;
    for (let y = 0; y < h; y++) {
      const v = ((y + 0.5) / h - 0.5) * 2; // -1..1 across
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const pulse = 0.55 + 0.45 * smooth(0.45, 0.75, pfbm(u - ph, 0.5, 2, 2, 17));
        const wob = (pfbm(u - ph * 0.5, 0.2, 3, 2, 29) - 0.5) * 0.12;
        const core = Math.exp(-Math.pow((v - wob) / 0.07, 2)) * pulse;
        const haze = Math.exp(-Math.pow(v / 0.5, 2)) * (0.16 + 0.14 * pulse);
        putA(sheet, (oy + y) * sheet.w + ox + x, clamp01(core + haze) * smooth(1, 0.8, Math.abs(v)));
      }
    }
  }
  return { sheet, frames, cols, cell: w };
}

/** A hit on a fence: a ripple of lit cells running both ways from the
 *  centre, fading (white). Placed at the hit point, along the wall. */
export function fenceRippleFlipbook(frames = 8, w = 128, h = 48): Flipbook {
  const cols = 2;
  const rows = Math.ceil(frames / cols);
  const sheet = img(cols * w, rows * h);
  const aspect = w / h;
  for (let f = 0; f < frames; f++) {
    const t = f / (frames - 1);
    const ox = (f % cols) * w, oy = Math.floor(f / cols) * h;
    for (let y = 0; y < h; y++) {
      const v = ((y + 0.5) / h - 0.5) * 2;
      const av = Math.abs(v);
      for (let x = 0; x < w; x++) {
        const u = ((x + 0.5) / w - 0.5) * 2 * aspect; // in band half-heights
        const d = Math.hypot(u, v * 0.8);
        const e = hexEdgeDist((x / w) * 3 * 2, (v + 1) * 1.3);
        const lines = Math.exp(-e * e * 400);
        const front = 0.3 + t * aspect * 0.9;
        const ring = Math.exp(-Math.pow((d - front) / (0.35 + t * 0.5), 2)) * Math.pow(1 - t, 1.5);
        const spot = Math.exp(-d * d * 1.2) * Math.pow(1 - t, 2.4) * 1.3;
        const edge = smooth(1, 0.8, av);
        putA(sheet, (oy + y) * sheet.w + ox + x, clamp01(((lines * 0.8 + 0.2) * ring + spot) * edge));
      }
    }
  }
  return { sheet, frames, cols, cell: w };
}

/** A beam resting on a fence: a steady bright patch where it lands, the
 *  cells around it lit, the rails brightened nearby (white). */
export function fenceContactTex(w = 128, h = 48): Img {
  const o = img(w, h);
  const aspect = w / h;
  for (let y = 0; y < h; y++) {
    const v = ((y + 0.5) / h - 0.5) * 2;
    const av = Math.abs(v);
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w - 0.5) * 2 * aspect;
      const d = Math.hypot(u, v * 0.8);
      const e = hexEdgeDist((x / w) * 3 * 2, (v + 1) * 1.3);
      const lines = Math.exp(-e * e * 400);
      const patch = Math.exp(-d * d * 0.22);
      const spot = Math.exp(-d * d * 3) * 1.4;
      const rails = Math.exp(-Math.pow((av - 0.8) / 0.08, 2)) * Math.exp(-u * u * 0.3) * 0.7;
      putA(o, y * w + x, clamp01((lines * 0.9 + 0.15) * patch + spot + rails) * smooth(1, 0.85, av));
    }
  }
  return o;
}

// ------------------------------------------------------------------ sky

/** Star colour by temperature class (linear RGB, roughly blackbody). */
const STAR_COLORS: Array<[number, number, number]> = [
  [0.62, 0.72, 1.0], // blue-white
  [0.82, 0.88, 1.0], // white
  [1.0, 0.95, 0.86], // yellow-white
  [1.0, 0.8, 0.56], // orange
  [1.0, 0.62, 0.44], // red-orange
];
function starColor(u: number): [number, number, number] {
  // Most stars are white-ish; a few blue, a few orange.
  const i = u < 0.12 ? 0 : u < 0.55 ? 1 : u < 0.82 ? 2 : u < 0.95 ? 3 : 4;
  return STAR_COLORS[i]!;
}

/**
 * A tileable square of stars. Each star is a tiny point-spread blob (sharp
 * core, faint halo) with a colour temperature; brightness follows a steep
 * power law, so a few stars stand out among many faint ones. Additive.
 */
export function starTileTex(size: number, count: number, seed: number, sharp = 1): Img {
  const acc = new Float32Array(size * size * 3);
  for (let i = 0; i < count; i++) {
    const sx = h01(i, seed) * size, sy = h01(i, seed + 1) * size;
    const b = Math.pow(h01(i, seed + 2), 5) * 0.9 + 0.12;
    const col = starColor(h01(i, seed + 3));
    const sig = (0.42 + b * 0.45) / sharp;
    const rad = Math.ceil(sig * 3 + b * 3);
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        const px = Math.floor(sx) + ox, py = Math.floor(sy) + oy;
        const dx = px + 0.5 - sx, dy = py + 0.5 - sy;
        const d2 = dx * dx + dy * dy;
        const v = b * (Math.exp(-d2 / (2 * sig * sig)) + 0.025 * b * Math.exp(-d2 / (2 * (sig * 3) ** 2)));
        if (v < 0.002) continue;
        const wx = ((px % size) + size) % size, wy = ((py % size) + size) % size;
        const k = (wy * size + wx) * 3;
        acc[k] = acc[k]! + v * col[0]; acc[k + 1] = acc[k + 1]! + v * col[1]; acc[k + 2] = acc[k + 2]! + v * col[2];
      }
    }
  }
  const o = img(size, size);
  for (let i = 0; i < size * size; i++) {
    const r = acc[i * 3]!, g = acc[i * 3 + 1]!, bl = acc[i * 3 + 2]!;
    const a = Math.max(r, g, bl);
    putRGBA(o, i, r / Math.max(a, 1e-6), g / Math.max(a, 1e-6), bl / Math.max(a, 1e-6), Math.min(1, a));
  }
  return o;
}

/** A bright star with four diffraction spikes and a soft halo (white). */
export function spikeStarTex(size = 64): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const core = Math.exp(-r * r * 220);
      const halo = Math.exp(-r * 7) * 0.35;
      const spikes = (Math.exp(-dy * dy * 9000) + Math.exp(-dx * dx * 9000)) * Math.pow(Math.max(0, 1 - r), 3) * 0.9;
      const diag = (Math.exp(-Math.pow(dx - dy, 2) * 6000) + Math.exp(-Math.pow(dx + dy, 2) * 6000)) * Math.pow(Math.max(0, 1 - r * 1.6), 3) * 0.18;
      putA(o, y * size + x, clamp01(core + halo + spikes + diag) * smooth(1, 0.9, r));
    }
  }
  return o;
}

/** A faint, tilted distant galaxy smudge: warm bulge, bluish arms. */
export function galaxyTex(size = 64, seed = 5): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  const tilt = h01(1, seed) * Math.PI, ca = Math.cos(tilt), sa = Math.sin(tilt);
  const flat = 0.35 + 0.4 * h01(2, seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const u = dx * ca + dy * sa, v = (-dx * sa + dy * ca) / flat;
      const r = Math.hypot(u, v);
      const th = Math.atan2(v, u);
      const arms = 0.6 + 0.4 * Math.cos(2 * th - r * 9);
      const disk = Math.exp(-r * 5) * arms;
      const bulge = Math.exp(-r * r * 60);
      const a = clamp01(disk * 0.7 + bulge);
      putRGBA(o, y * size + x, 0.7 + 0.3 * bulge, 0.72 + 0.2 * bulge, 1.0 - 0.3 * bulge, a * smooth(1, 0.8, Math.hypot(dx, dy)));
    }
  }
  return o;
}

export type NebulaKind = 'emission' | 'reflection' | 'dark';

/**
 * A tileable nebula cloud. Domain-warped fractal noise gives the wispy,
 * folded look; it's baked small (it's soft anyway) and drawn big.
 *  - emission: hydrogen red/pink with violet edges (additive);
 *  - reflection: blue dust lit by nearby stars (additive);
 *  - dark: brown-black dust lanes (normal blend, dims what's behind).
 */
export function nebulaTex(kind: NebulaKind, size = 512, seed = 21): Img {
  const o = img(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const qx = pfbm(u, v, 3, 4, seed);
      const qy = pfbm(u, v, 3, 4, seed + 17);
      // Warp by an integer number of tiles' worth of noise stays seamless
      // because pfbm is periodic in u, v.
      const wu = u + (qx - 0.5) * 0.45, wv = v + (qy - 0.5) * 0.45;
      const d = pfbm(wu, wv, 4, 6, seed + 40);
      const fil = pfbm(wu * 2, wv * 2, 8, 4, seed + 60);
      const i = y * size + x;
      if (kind === 'dark') {
        const m = smooth(0.48, 0.72, d) * (0.6 + 0.5 * fil);
        // Truly dark once converted to sRGB (0.05 linear would show as grey-brown).
        putRGBA(o, i, 0.006, 0.004, 0.003, clamp01(m * 0.9));
        continue;
      }
      const m = smooth(0.42, 0.85, d);
      const hot = smooth(0.62, 0.95, d * 0.7 + fil * 0.45) * m;
      let r: number, g: number, b: number;
      if (kind === 'emission') {
        r = 1.0 + 0.6 * hot; g = 0.16 + 0.45 * hot + 0.12 * qx; b = 0.3 + 0.45 * (1 - qx) + 0.25 * hot;
      } else {
        r = 0.25 + 0.5 * hot; g = 0.45 + 0.45 * hot + 0.15 * qy; b = 1.0;
      }
      putRGBA(o, i, r, g, b, clamp01(m * 0.75 + hot * 0.5));
    }
  }
  return o;
}

/** A small gas wisp (not tileable): a nebula blob with a soft round edge.
 *  White-ish; tint per resource. */
export function wispTex(size = 128, seed = 33): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const qx = pfbm(u, v, 2, 3, seed), qy = pfbm(u, v, 2, 3, seed + 5);
      const d = pfbm(u + (qx - 0.5) * 0.5, v + (qy - 0.5) * 0.5, 4, 5, seed + 9);
      const r = Math.hypot(x - c, y - c) / c;
      putA(o, y * size + x, smooth(0.4, 0.8, d) * smooth(1, 0.45, r) * 0.9);
    }
  }
  return o;
}

/** The sector's sun: blinding core, wide halo, faint anamorphic streak (white-gold). */
export function sunTex(size = 256): Img {
  const o = img(size, size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const core = smooth(0.09, 0.06, r);
      const halo = 0.022 / (r * r + 0.022) * 0.9;
      const streak = Math.exp(-dy * dy * 1600) * Math.exp(-Math.abs(dx) * 2.2) * 0.35;
      const a = clamp01(core + halo + streak) * smooth(1, 0.7, r);
      const warm = clamp01(r * 3);
      putRGBA(o, y * size + x, 1.0, 0.92 - 0.12 * warm, 0.8 - 0.3 * warm, a);
    }
  }
  return o;
}

/**
 * A distant planet, lit from `sunAz` (Pixi space, radians, direction TO the
 * sun). Banded gas-giant albedo, soft terminator, a thin lit atmosphere rim.
 * Normal blend.
 */
export function planetTex(size: number, sunAz: number, seed = 8, tint: [number, number, number] = [0.55, 0.62, 0.78]): Img {
  const o = img(size, size);
  const c = (size - 1) / 2, R = 0.86;
  const lx = Math.cos(sunAz) * 0.95, ly = Math.sin(sunAz) * 0.95, lz = 0.3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c / R, dy = (y - c) / c / R;
      const r = Math.hypot(dx, dy);
      const i = y * size + x;
      if (r > 1.12) { putRGBA(o, i, 0, 0, 0, 0); continue; }
      const nd = (dx * lx + dy * ly) / Math.max(r, 1e-6);
      const atm = Math.exp(-Math.pow((r - 1) / 0.04, 2)) * clamp01(nd * 1.4 + 0.1);
      if (r >= 1) {
        // Atmosphere: a thin glow on the sun side only.
        putRGBA(o, i, 0.5, 0.75, 1.0, atm * 0.8);
        continue;
      }
      const nz = Math.sqrt(1 - r * r);
      const lam = clamp01(dx * lx + dy * ly + nz * lz);
      const bands = pfbm(0.5, dy * 0.5 + 0.5 + (pfbm(dx * 0.5 + 0.5, dy * 0.5 + 0.5, 3, 3, seed) - 0.5) * 0.08, 6, 4, seed + 3);
      const alb = 0.35 + 0.5 * bands;
      const term = smooth(0.02, 0.4, lam);
      const fres = Math.pow(1 - nz, 3) * clamp01(dx * lx + dy * ly + 0.3);
      putRGBA(o, i, tint[0] * alb * term + fres * 0.3 + atm * 0.4, tint[1] * alb * term + fres * 0.45 + atm * 0.6, tint[2] * alb * term + fres * 0.7 + atm * 0.8, 1);
    }
  }
  return o;
}

/** A sparse tile of near-camera dust motes (white, additive, very faint).
 *  Drawn in FRONT of the world with parallax above 1, so it streams past. */
export function dustTileTex(size = 512, count = 26, seed = 51): Img {
  const o = img(size, size);
  const acc = new Float32Array(size * size);
  for (let i = 0; i < count; i++) {
    const sx = h01(i, seed) * size, sy = h01(i, seed + 1) * size;
    const s = 0.8 + h01(i, seed + 2) * 1.6;
    const b = 0.25 + 0.75 * h01(i, seed + 3);
    const rad = Math.ceil(s * 3);
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        const px = Math.floor(sx) + ox, py = Math.floor(sy) + oy;
        const d2 = (px + 0.5 - sx) ** 2 + (py + 0.5 - sy) ** 2;
        const v = b * Math.exp(-d2 / (2 * s * s));
        const wx = ((px % size) + size) % size, wy = ((py % size) + size) % size;
        acc[wy * size + wx] = acc[wy * size + wx]! + v;
      }
    }
  }
  for (let i = 0; i < size * size; i++) putA(o, i, Math.min(1, acc[i]!));
  return o;
}

/** Bytes a set of textures will take on the GPU (RGBA8, + 1/3 for mipmaps
 *  when `mip`). */
export function imgGpuBytes(imgs: readonly Img[], mip = false): number {
  let b = 0;
  for (const i of imgs) b += i.w * i.h * 4;
  return mip ? Math.round(b * 4 / 3) : b;
}

// ------------------------------------------------------------------ registry

/**
 * Bump when any generator above changes its output: baked effect textures are
 * cached on players' devices under this version (the `fx` bake job's key).
 * Locked by the hash test in `fxTextures.lock.test.ts`.
 */
export const FX_VERSION = 'fx2';

/** Landmark planet tints (linear RGB): blue-grey, ochre, green, mauve, ice. */
const LANDMARK_TINTS: Array<[number, number, number]> = [[0.54, 0.61, 0.72], [0.69, 0.54, 0.42], [0.48, 0.63, 0.53], [0.63, 0.48, 0.6], [0.6, 0.65, 0.69]];

export type FxId =
  | 'glow' | 'streak' | 'beamFlow' | 'ring' | 'spark' | 'smoke' | 'trail'
  | 'shieldDome' | 'shieldContact' | 'shieldHit' | 'fireball'
  | 'spikeStar' | 'galaxy' | 'sun' | 'wisp' | 'dust'
  | 'starsFar' | 'starsMid' | 'starsNear' | 'planet' | 'nebula'
  | 'fenceStrip' | 'fenceRipple' | 'fenceContact'
  | 'flame' | 'flameCore' | 'exhaustTrail';

export interface FxSpec {
  /** Wraps (drawn as a TilingSprite): gets its own texture, not an atlas slot. */
  tile: boolean;
  /** Mipmapped (star tiles shrink a lot when zoomed out). */
  mip?: boolean;
  /** A flipbook sheet: frame count, columns and cell size. */
  flip?: { frames: number; cols: number; cell: number };
}

export const FX_SPECS: Readonly<Record<FxId, FxSpec>> = {
  glow: { tile: false }, streak: { tile: false }, beamFlow: { tile: true }, ring: { tile: false },
  spark: { tile: false }, smoke: { tile: false }, trail: { tile: false },
  shieldDome: { tile: false }, shieldContact: { tile: false },
  shieldHit: { tile: false, flip: { frames: 12, cols: 4, cell: 192 } },
  fireball: { tile: false, flip: { frames: 16, cols: 4, cell: 128 } },
  spikeStar: { tile: false }, galaxy: { tile: false }, sun: { tile: false }, wisp: { tile: false },
  dust: { tile: true }, starsFar: { tile: true, mip: true }, starsMid: { tile: true, mip: true },
  starsNear: { tile: true, mip: true }, planet: { tile: false }, nebula: { tile: true },
  fenceStrip: { tile: false, flip: { frames: 8, cols: 2, cell: 128 } },
  fenceRipple: { tile: false, flip: { frames: 8, cols: 2, cell: 128 } },
  fenceContact: { tile: false },
  flame: { tile: false }, flameCore: { tile: false }, exhaustTrail: { tile: false },
};

export function isFxId(id: string): id is FxId {
  return Object.prototype.hasOwnProperty.call(FX_SPECS, id);
}

/**
 * Generate one effect texture. `variant` picks the nebula type; `seed` varies
 * per-sector textures (nebula, planet); `sunAz` lights the planet.
 */
export function bakeFxImg(id: FxId, variant: string | undefined, seed: number | undefined, sunAz: number): Img {
  switch (id) {
    case 'glow': return glowTex(64);
    case 'streak': return streakTex(128, 32);
    case 'beamFlow': return beamFlowTex(256, 32);
    case 'ring': return ringTex(128);
    case 'spark': return sparkTex(32, 8);
    case 'smoke': return smokeTex(64);
    case 'trail': return trailTex(128, 16);
    case 'shieldDome': return shieldDomeTex(256);
    case 'shieldContact': return shieldContactTex(192);
    case 'shieldHit': return shieldHitFlipbook(12, 192).sheet;
    case 'fireball': return fireballFlipbook(16, 128).sheet;
    case 'spikeStar': return spikeStarTex(64);
    case 'galaxy': return galaxyTex(64, seed ?? 5);
    case 'sun': return sunTex(256);
    case 'wisp': return wispTex(128, seed ?? 33);
    case 'dust': return dustTileTex(512);
    case 'starsFar': return starTileTex(512, 950, 11, 1.3);
    case 'starsMid': return starTileTex(512, 260, 23, 1.0);
    case 'starsNear': return starTileTex(512, 70, 37, 0.85);
    case 'planet': {
      // Landmarks (round 2): a gas giant, a rocky planet or a grey moon; the
      // seed picks the tint. No variant = the original backdrop planet.
      if (variant === 'gas') return planetTex(384, sunAz, seed ?? 8, LANDMARK_TINTS[(seed ?? 0) % LANDMARK_TINTS.length]!);
      if (variant === 'rock') return planetTex(256, sunAz, seed ?? 8, LANDMARK_TINTS[((seed ?? 0) + 2) % LANDMARK_TINTS.length]!);
      if (variant === 'moon') return planetTex(192, sunAz, seed ?? 8, [0.6, 0.6, 0.62]);
      return planetTex(256, sunAz, seed ?? 8);
    }
    case 'fenceStrip': return fenceStripFlipbook(8, 128, 48).sheet;
    case 'fenceRipple': return fenceRippleFlipbook(8, 128, 48).sheet;
    case 'fenceContact': return fenceContactTex(128, 48);
    case 'flame': return flameTex(128, 32, 0);
    case 'flameCore': return flameTex(128, 32, 1);
    case 'exhaustTrail': return exhaustTrailTex(128, 16);
    case 'nebula': {
      const k: NebulaKind = variant === 'reflection' || variant === 'dark' ? variant : 'emission';
      return nebulaTex(k, 512, seed ?? 21);
    }
  }
}

/** Effects every sector uses: baked during the galaxy-map warm-up. The
 *  per-sector ones (nebula, planet) bake when the sector is known. */
export const FX_WARM: readonly FxId[] = [
  'glow', 'streak', 'beamFlow', 'ring', 'spark', 'smoke', 'trail', 'shieldContact', 'shieldHit', 'fireball',
  'shieldDome', 'spikeStar', 'sun', 'starsFar', 'starsMid', 'starsNear', 'dust', 'galaxy', 'wisp',
  'fenceStrip', 'fenceRipple', 'fenceContact',
];
