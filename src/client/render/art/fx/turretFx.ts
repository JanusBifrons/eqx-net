/**
 * Weapon turret R&D (rnd/turrets): the muzzle-flash flipbook and the pure
 * firing-reaction maths (recoil, heat, flash, which barrel a shot left from).
 * The turret itself is baked through the hull forge (fields.ts
 * forgeTurretGun + stampTurretRing), placed by turretLayout.ts.
 *
 * The flash is white straight RGBA, tinted per weapon, pointing up (-y, the
 * nose convention) from its anchor at the muzzle. Pure and DOM-free.
 */
import type { Img } from './fxTextures.js';

export type TurretFamily = 'bolt' | 'beam' | 'missile' | 'charge';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function img(w: number, h: number): Img {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
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
