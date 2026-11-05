/**
 * Weapon turret R&D (rnd/turrets): baked turret housings, barrels and a
 * muzzle-flash flipbook, plus the pure firing-reaction maths (recoil, heat,
 * flash, which barrel a shot left from).
 *
 * Today every barrel is a flat 2.4 × 20 u rectangle in the ship colour, the
 * one vector-looking part left on a Machined hull, and nothing moves when it
 * fires. These bakes use the hull palette (`PALETTE`) and a fixed top-left
 * light like the hull bakes, so a turret reads as part of the ship.
 *
 * Bakes are COLOURED straight RGBA (sRGB), except the flash, which is white
 * and tinted per weapon. Barrels point up (-y, the ship's nose convention):
 * the tip is row 0, the root the last row. Pure and DOM-free.
 */
import type { Img } from './fxTextures.js';
import { PALETTE } from '../fields.js';

export type TurretFamily = 'bolt' | 'beam' | 'missile' | 'charge';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function img(w: number, h: number): Img {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

const rgb = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/** Write colour `c` scaled by `light`, over what is there, with coverage `a`. */
function put(o: Img, x: number, y: number, c: [number, number, number], light: number, a: number): void {
  if (a <= 0) return;
  const i = (y * o.w + x) * 4;
  const prev = o.data[i + 3]! / 255;
  const na = a + prev * (1 - a);
  for (let k = 0; k < 3; k++) {
    const v = Math.min(255, c[k]! * light);
    o.data[i + k] = Math.round((v * a + o.data[i + k]! * prev * (1 - a)) / Math.max(1e-6, na));
  }
  o.data[i + 3] = Math.round(na * 255);
}

/** Light direction (top-left, toward the viewer), as on the hull bakes. */
const LX = -0.45, LY = -0.55, LZ = 0.7;

/** Housing / turret base, `size` px square: a domed metal ring per family. */
export function turretBaseTex(family: TurretFamily, size = 64): Img {
  const o = img(size, size);
  const metal = rgb(PALETTE.metal), trim = rgb(PALETTE.trim), worn = rgb(PALETTE.metalWorn), glass = rgb(PALETTE.glass);
  const R = size * 0.44;
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / R, dy = (y + 0.5 - c) / R;
      let d = Math.hypot(dx, dy);
      // The rack is a rounded box; the rest are discs.
      if (family === 'missile') d = Math.max(Math.abs(dx) * 0.95, Math.abs(dy) * 1.25);
      const cover = smooth(1.02, 0.96, d);
      if (cover <= 0) continue;
      // Dome normal (flatter on top so the barrel has a seat).
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, d) ** 2)) * 0.8 + 0.2;
      const nx = dx * 0.6, ny = dy * 0.6;
      const ln = Math.hypot(nx, ny, nz);
      const lamb = Math.max(0, (nx * LX + ny * LY + nz * LZ) / ln);
      let light = 0.42 + 0.75 * lamb;
      let col = metal;
      if (d > 0.84) { col = trim; light *= 0.9; } // outer trim ring
      else if (d > 0.78) { col = worn; light *= 0.85 + 0.3 * lamb; } // a bright bevel
      if (family === 'bolt' && d < 0.34) { col = trim; light = 0.6; } // the barrel seat
      if (family === 'beam') {
        // Four cooling fins (dark slots on the diagonals).
        const a = Math.atan2(dy, dx);
        if (d > 0.42 && d < 0.78 && Math.abs(Math.sin(2 * a)) > 0.93) { col = trim; light = 0.55; }
        if (d < 0.36) { col = glass; light = 0.9 + 0.4 * lamb; }
      }
      if (family === 'charge') {
        // Two coil rings.
        if (Math.abs(d - 0.5) < 0.05 || Math.abs(d - 0.66) < 0.04) { col = worn; light = 0.7 + 0.6 * lamb; }
        if (d < 0.3) { col = glass; light = 1.0; }
      }
      if (family === 'missile') {
        // Two launch hatches.
        const hx = Math.abs(Math.abs(dx) - 0.42), hy = Math.abs(dy);
        if (hx < 0.26 && hy < 0.5) { col = trim; light = hx > 0.2 || hy > 0.44 ? 0.9 : 0.5; }
      }
      // Rivets on the ring.
      if (family !== 'missile' && d > 0.86 && d < 0.95) {
        const a = Math.atan2(dy, dx);
        if (Math.abs(Math.sin(a * 4)) < 0.08) { col = worn; light = 1.1; }
      }
      put(o, x, y, col, light, cover);
    }
  }
  return o;
}

/**
 * Barrel, `w × h` px, pointing up: a lit cylinder with a dark collar at the
 * root and a muzzle brake + bore at the tip. Beams get a short wide emitter
 * with a lens; missiles a stubby launch tube; charge lasers a coiled emitter.
 */
export function turretBarrelTex(family: TurretFamily, w = 16, h = 64): Img {
  const o = img(w, h);
  const metal = rgb(PALETTE.metal), trim = rgb(PALETTE.trim), worn = rgb(PALETTE.metalWorn), glass = rgb(PALETTE.glass);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h; // 0 tip .. 1 root
    // Half-width as a fraction of w, per family profile.
    let half = 0.3;
    if (family === 'bolt') half = v < 0.12 ? 0.46 : v > 0.86 ? 0.4 : 0.3;
    else if (family === 'beam') half = v < 0.18 ? 0.36 : 0.46;
    else if (family === 'charge') half = v < 0.14 ? 0.3 : 0.44;
    else half = 0.48;
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w - 0.5) / half; // -1..1 across
      const cover = smooth(1.08, 0.92, Math.abs(u));
      if (cover <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, u * u)));
      const lamb = Math.max(0, u * LX + nz * LZ);
      let light = 0.35 + 0.85 * lamb + 0.35 * Math.pow(Math.max(0, 1 - Math.abs(u + 0.35) * 3), 3); // spec streak
      let col = metal;
      if (family === 'bolt') {
        if (v < 0.12) col = worn; // muzzle brake
        if (v < 0.12 && Math.abs(v - 0.06) < 0.015) { col = trim; light = 0.5; } // brake slot
        if (v > 0.86) col = trim; // collar
        if (v < 0.035 && Math.abs(u) < 0.5) { col = trim; light = 0.25; } // bore
      } else if (family === 'beam') {
        if (v < 0.18) { col = glass; light = 0.8 + 0.6 * nz; } // lens
        if (Math.abs(v - 0.45) < 0.04 || Math.abs(v - 0.62) < 0.04) { col = trim; light = 0.55; } // fins
      } else if (family === 'charge') {
        if (v < 0.14) { col = glass; light = 1.0; }
        if (v > 0.2 && Math.sin(v * 60) > 0.55) { col = worn; light *= 1.1; } // coils
      } else {
        col = trim; light = 0.55 + 0.4 * lamb; // launch tube
        if (v < 0.1) { col = rgb(0x0b0c10); light = 1; } // the open end
      }
      put(o, x, y, col, light, cover);
    }
  }
  return o;
}

/**
 * Muzzle flash flipbook: `frames` cells of `cell` px in a row, white,
 * pointing up from the bottom-centre (anchor (0.5, 1) at the muzzle).
 * A hot core, a forward cone and side petals, shrinking frame by frame.
 */
export function muzzleFlashFlipbook(frames = 4, cell = 64): { sheet: Img; frames: number; cols: number; cell: number } {
  const sheet = img(cell * frames, cell);
  for (let f = 0; f < frames; f++) {
    const k = 1 - f / frames; // 1 → small
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const px = (x + 0.5) / cell - 0.5; // -0.5..0.5
        const py = 1 - (y + 0.5) / cell; // 0 at the muzzle (bottom) .. 1 at the top
        const core = Math.exp(-(px * px + (py - 0.05) * (py - 0.05)) / (0.012 * k + 0.002));
        const coneW = 0.05 + 0.1 * py;
        const cone = py < 0.9 * k ? Math.exp(-(px * px) / (coneW * coneW * 0.5)) * (1 - py / (0.9 * k)) : 0;
        const pet = Math.exp(-(((Math.abs(px) - 0.18 * k) ** 2) / 0.003 + ((py - 0.1) ** 2) / 0.004)) * 0.6;
        const a = clamp01((core + cone * 0.9 + pet) * (0.5 + 0.5 * k));
        const i = (y * sheet.w + f * cell + x) * 4;
        sheet.data[i] = 255; sheet.data[i + 1] = 255; sheet.data[i + 2] = 255;
        sheet.data[i + 3] = Math.round(a * 255);
      }
    }
  }
  return { sheet, frames, cols: frames, cell };
}

// ------------------------------------------------------------------ maths

/** Barrel recoil, 0..1 of the kick, `t` seconds after a shot: snaps back in
 *  25 ms, then springs home over ~0.2 s with a small overshoot. */
export function recoilAt(t: number): number {
  if (t < 0) return 0;
  if (t < 0.025) return t / 0.025;
  const s = t - 0.025;
  return Math.exp(-s / 0.07) * Math.cos(s * 9);
}

/** Muzzle flash frame for `t` seconds after a shot (`-1` = done). */
export function flashFrameAt(t: number, frames: number, lifeS = 0.07): number {
  if (t < 0 || t >= lifeS) return -1;
  return Math.min(frames - 1, Math.floor((t / lifeS) * frames));
}

/** Barrel heat: +`perShot` each shot, cooling with time constant `tauS`, capped at 1. */
export function heatAfter(heat: number, dtSec: number, shots: number, perShot = 0.3, tauS = 0.5): number {
  return Math.min(1, heat * Math.exp(-dtSec / tauS) + shots * perShot);
}

/** Index of the muzzle nearest (x, y) among the first `n` (xs, ys), or -1 when
 *  none is within `maxDist`. How a new bolt is matched to the barrel it left. */
export function nearestMuzzle(x: number, y: number, xs: ArrayLike<number>, ys: ArrayLike<number>, n: number, maxDist: number): number {
  let best = -1, bd = maxDist * maxDist;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - x, dy = ys[i]! - y, d = dx * dx + dy * dy;
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}

/** The family a weapon draws as. */
export function familyFor(weaponId: string, mode: string, charge: boolean): TurretFamily {
  if (mode === 'missile') return 'missile';
  if (mode === 'hitscan') return charge ? 'charge' : 'beam';
  return weaponId === 'pulse-orb' ? 'charge' : 'bolt';
}
