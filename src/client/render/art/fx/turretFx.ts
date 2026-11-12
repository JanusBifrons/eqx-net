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
  if (t < 0 || t > 0.6) return 0; // at rest (and settled)
  if (t < 0.025) return t / 0.025;
  const s = t - 0.025;
  return Math.exp(-s / 0.07) * Math.cos(s * 9);
}

/** Muzzle flash frame for `t` seconds after a shot (`-1` = done). */
/** An ordinary gun's muzzle flash sprite lasts this long. */
export const MUZZLE_FLASH_LIFE_S = 0.07;
export function flashFrameAt(t: number, frames: number, lifeS = MUZZLE_FLASH_LIFE_S): number {
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

/** Capital naval guns (review round 2026-11-07, "bigger effects"): a long
 *  directed flash out of each barrel, propellant smoke blown forward along it
 *  (`muzzleSmokePuff`), and a burst where the shell lands. Sizes follow the
 *  gun, never a fixed number (invariant #18). */
export const NAVAL_FLASH_LIFE_S = 0.22;

/** How long a muzzle flash's light outlives the flash sprite (GPU-lit art):
 *  the sprite is 1–2 frames, too brief for its light to read (showcase
 *  review 2026-11-09). */
export const MUZZLE_LIGHT_TAIL_S = 0.1;
/** Muzzle-flash light, 0..1, `t` s after a shot: full while the flash sprite
 *  shows (`lifeS`), then an ease-out over `tailS`. 0 before the shot / after. */
export function muzzleLightAt(t: number, lifeS: number, tailS = MUZZLE_LIGHT_TAIL_S): number {
  if (t < 0) return 0;
  if (t < lifeS) return 1;
  const u = (t - lifeS) / tailS;
  if (u >= 1) return 0;
  return (1 - u) * (1 - u);
}

export interface MuzzleLight { intensity: number; reach: number; z: number }
/** The light of a naval salvo for a gun of barrel width `barrelW` (world u),
 *  into `out`: reach and height in proportion to the gun, brightness by its
 *  square root, so a 5" mount lights its own patch of deck and a 16" turret
 *  the whole foredeck. (Width / 2 capped at 6 gave a battleship's 5" the
 *  same light as its 16"; review 2026-11-09.) Sizes follow the gun (#18). */
export function navalMuzzleLight(barrelW: number, out: MuzzleLight): MuzzleLight {
  const k = Math.min(6, Math.max(1, barrelW / 5.8));
  out.intensity = 8.4 * Math.sqrt(k / 6);
  out.reach = 110 * k;
  out.z = 6 * k;
  return out;
}
/** Impact burst radius for a shell of collision radius `shellRadius`. */
export function shellImpactRadius(shellRadius: number): number {
  return Math.max(30, shellRadius * 35);
}

/** Smoke puffs per barrel after a naval shot, and how long they last. */
export const MUZZLE_SMOKE_PUFFS = 8;
export const MUZZLE_SMOKE_LIFE_S = 1.6;
export interface SmokePuff { d: number; size: number; alpha: number; lat: number; rot: number }
/**
 * Puff `k` (0 = nearest the muzzle) of a barrel's propellant smoke, `t`
 * seconds after the shot: blown FORWARD along the barrel (`d`, distance past
 * the muzzle, grows), swelling and fading. A directed cone, not a round blast
 * (review 2026-11-07: "a directed propellent type one"). Sizes follow the
 * barrel width (invariant #18). Writes `out`; alpha 0 = not drawn.
 */
export function muzzleSmokePuff(t: number, k: number, barrelWid: number, out: SmokePuff): SmokePuff {
  if (t < 0 || t >= MUZZLE_SMOKE_LIFE_S) { out.alpha = 0; out.d = 0; out.size = 0; out.lat = 0; out.rot = 0; return out; }
  const p = t / MUZZLE_SMOKE_LIFE_S;
  const ease = 1 - (1 - Math.min(1, t / 0.35)) ** 3; // fast push out, then drift
  out.d = barrelWid * (1 + 1.5 * k) * (0.5 + 1.5 * ease) + barrelWid * 2 * p;
  out.size = barrelWid * (3 + 1.6 * k + 6 * p);
  out.alpha = 0.55 * (1 - p) ** 1.4 * (1 - 0.07 * k);
  // A plume, not a row of tiles: alternate a little to each side as it
  // spreads, and turn each puff differently.
  out.lat = (k % 2 === 0 ? 1 : -1) * barrelWid * 0.35 * (0.3 + p) * (1 + k * 0.15);
  out.rot = k * 1.37 + p * 0.6;
  return out;
}

