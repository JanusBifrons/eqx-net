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
import type { EffectQuality } from '@core/contracts/IEffects';

/** How a turret draws. 'rail' is the railgun: a ringed breech and one
 *  split-rail barrel (`railGeom`), not a powder gunhouse. */
export type TurretFamily = 'bolt' | 'beam' | 'missile' | 'charge' | 'rail';

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

/** The family a weapon draws as. The railgun draws as 'rail'; any other
 *  charge weapon (`chargeTicks`) of any mode but missile draws as 'charge'
 *  (the robot's beam, a charging shell gun). */
export function familyFor(weaponId: string, mode: string, charge: boolean): TurretFamily {
  if (mode === 'missile') return 'missile';
  if (weaponId === 'railgun') return 'rail';
  if (charge) return 'charge';
  if (mode === 'hitscan') return 'beam';
  return weaponId === 'pulse-orb' ? 'charge' : 'bolt';
}

/** The railgun's muzzle heft (plan beam-slices §7): its recoil, flash size,
 *  flash time and flash light are this many times a powder gun's of the same
 *  barrel. */
export const RAILGUN_MUZZLE_HEFT = 1.8;

/** How heavy a gun's muzzle reaction is: `RAILGUN_MUZZLE_HEFT` for the
 *  railgun, 1 for every other gun. A gun with heft > 1 kicks and flashes
 *  (the 'rail' family; a 'charge' gun does neither). */
export function muzzleHeft(weaponId: string): number {
  return weaponId === 'railgun' ? RAILGUN_MUZZLE_HEFT : 1;
}

/** The railgun's muzzle flash tint: white-blue and blue-dominant (the white
 *  flash flipbook times this), never the near-white of a hot powder flash. */
export const RAIL_FLASH_TINT = 0x8cb4ff;
/** The light the railgun's flash casts on its hull: a deeper blue, so the
 *  lit deck reads blue rather than washed white. */
export const RAIL_FLASH_LIGHT = 0x6e9cff;

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

/** The railgun slug's burst is this many times its small radius's: a 5 u
 *  slug carrying a 16" shell's damage bursts like a heavy shell (plan
 *  beam-slices §7), not like a 5" one. */
export const RAILGUN_BURST_MUL = 2.4;

/** The burst size (`shellImpactRadius`'s input) for a shell of gun `w` and
 *  collision radius `radius`: the radius, scaled up for the railgun. */
export function shellBurstSize(w: string, radius: number): number {
  return w === 'railgun' ? radius * RAILGUN_BURST_MUL : radius;
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


// ------------------------------------------------------------ the railgun

/** Split-rail turret geometry (Pixi-up local, forward = −y, pivot at 0),
 *  from the mount's shared naval geometry (`navalTurret`, #18). The rails
 *  end at the shared muzzle (houseL / 2 + len, #15); the breech is a disc
 *  smaller than a gunhouse, so the barrel shows longer than a naval one. */
export interface RailGeom {
  /** Breech disc radius. */
  breechR: number;
  /** Width of each rail, and of the open slot between them. */
  railW: number;
  slotW: number;
  /** |x| of a rail's outer face. */
  railOuter: number;
  /** y where the rails (and the slot) leave the breech; the muzzle's y. */
  railY0: number;
  muzzleY: number;
  /** Flared shoulder plates: half-width at the breech, and the y where they
   *  taper into the rails' outer faces. */
  shoulderW: number;
  shoulderY1: number;
}

/** Side vents along each rail, as fractions of the rail from breech (0) to
 *  muzzle (1). The bake cuts them and the vent gas leaves them. */
export const RAIL_VENTS: readonly number[] = [0.3, 0.44, 0.58, 0.72];

export function railGeom(houseW: number, houseL: number, len: number, wid: number): RailGeom {
  const breechR = houseW * 0.4;
  const railW = wid * 1.15;
  const slotW = wid * 0.95;
  const muzzleY = -(houseL / 2 + len);
  const railY0 = -breechR * 0.3;
  return {
    breechR, railW, slotW, railOuter: slotW / 2 + railW, railY0, muzzleY,
    shoulderW: houseW * 0.46,
    shoulderY1: railY0 + (muzzleY - railY0) * 0.34,
  };
}

/** The charge in the slot at `level` 0..1 of the charge (`chargeGlowLevel`):
 *  light fills the slot from the breech (`fill` 0) to the muzzle (`fill` 1)
 *  and brightens as it nears full. Writes `out`. Pure. */
export interface RailSlotCharge { fill: number; bright: number }
export function railSlotCharge(level: number, out: RailSlotCharge): RailSlotCharge {
  const l = clamp01(level);
  out.fill = l;
  out.bright = 0.25 + 0.75 * l * l;
  return out;
}

/** How long the rails glow and vent after a shot. */
export const RAIL_VENT_LIFE_S = 2;

/** Rail heat, 0..1, `t` s after a shot: white-hot at once, cooling over
 *  `RAIL_VENT_LIFE_S`. 0 before the shot / after. */
export function railHeatAt(t: number): number {
  if (t < 0 || t >= RAIL_VENT_LIFE_S) return 0;
  const u = 1 - t / RAIL_VENT_LIFE_S;
  return u * u;
}

/** Vent puffs drawn per railgun per effects tier: both sides of every vent
 *  at high, one side at medium, none on the low tiers (firing reactions are
 *  off there). Each is one pre-made sprite (no allocation). */
export function railVentPuffs(quality: EffectQuality): number {
  return quality === 'high' ? RAIL_VENTS.length * 2 : quality === 'medium' ? RAIL_VENTS.length : 0;
}

/** Vent puff `k` (vent `RAIL_VENTS[k >> 1]`, side +1 for even k, −1 odd)
 *  `t` s after a shot: gas blown sideways out of the rail's vent, swelling
 *  and fading, spark-hot (`hot` 1 → 0) for its first moment. Each vent
 *  fires a beat after the one behind it (the heat runs up the rails). Sizes
 *  follow the rail (#18). Writes `out`; alpha 0 = not drawn. */
export interface RailPuff { x: number; y: number; size: number; alpha: number; hot: number }
export function railVentPuff(t: number, k: number, g: RailGeom, out: RailPuff): RailPuff {
  const vent = RAIL_VENTS[(k >> 1) % RAIL_VENTS.length]!;
  const side = k % 2 === 0 ? 1 : -1;
  const life = RAIL_VENT_LIFE_S * 0.85;
  const s = t - vent * 0.12;
  if (s < 0 || s >= life) { out.alpha = 0; out.size = 0; out.x = 0; out.y = 0; out.hot = 0; return out; }
  const p = s / life;
  const ease = 1 - (1 - Math.min(1, s / 0.3)) ** 3;
  const w = g.railW;
  out.x = side * (g.railOuter + w * (0.6 + 3.2 * ease + 1.5 * p));
  out.y = g.railY0 + (g.muzzleY - g.railY0) * vent + w * 1.2 * p;
  out.size = w * (1.6 + 5 * p);
  out.alpha = 0.7 * (1 - p) ** 1.3;
  out.hot = s < 0.25 ? 1 - s / 0.25 : 0;
  return out;
}

// ------------------------------------------------------- the slug's wake

/** How long a piece of a railgun slug's ion wake lasts after the slug passed
 *  it: it thins, spreads and is gone in 0.7 s (a dispersing wisp, not a
 *  lingering line). */
export const SLUG_WAKE_LIFE_S = 0.7;
/** The slug's head is a short white-hot streak as long as its travel over
 *  this many 60 fps frames of game time (motion blur: ~160 u at 6,450 u/s),
 *  so it reads as a fast SLUG; a ~1 km streak read as a laser needle. */
export const SLUG_HEAD_FRAMES = 1.5;
/** ...but never shorter than this many of its own widths (the minimum
 *  on-screen size: the width already has a pixel floor at far zoom). */
export const SLUG_HEAD_MIN_ASPECT = 5;
/** How far the wake trails behind the slug's head, in head lengths (~800 u
 *  at real speed, the last ~0.12 s of flight): a short tail that starts
 *  behind the head. In head lengths so the minimum-size floor, which
 *  lengthens the head at far zoom, lengthens the tail with it. */
export const SLUG_WAKE_TAIL = 5;
/** Fresh out of the barrel the tail grows at this fraction of the slug's
 *  speed, so its back end leaves the muzzle too: a tail pinned to the muzzle
 *  is a line out of the barrel, which reads as a laser. */
export const SLUG_WAKE_GROW = 0.5;

/** The slug head's drawn length (u) at `speed` (u/s), `width` (u) wide. */
export function slugHeadLength(speed: number, width: number): number {
  return Math.max((speed * SLUG_HEAD_FRAMES) / 60, width * SLUG_HEAD_MIN_ASPECT);
}
/** The wake's violet-blue. */
export const SLUG_WAKE_TINT = 0x9a86ff;

/** Wake pieces per slug per effects tier (each a pooled sprite). */
export function slugWakeSegments(quality: EffectQuality): number {
  return quality === 'high' ? 10 : quality === 'medium' ? 6 : quality === 'low' ? 3 : 0;
}

/** A wake piece `age` s after the slug passed it, `along` (0..1) of the
 *  tail behind the slug: its alpha (0 = gone; brightest at the slug, nothing
 *  at the tail's end) and its width as a multiple of the fresh wake's (it
 *  spreads as it fades). */
export function slugWakeAlpha(age: number, along = 0): number {
  if (age < 0 || age >= SLUG_WAKE_LIFE_S || along >= 1) return 0;
  return 0.85 * (1 - age / SLUG_WAKE_LIFE_S) ** 1.5 * (1 - Math.max(0, along)) ** 1.2;
}
export function slugWakeWidth(age: number): number {
  return 1 + 3 * Math.min(1, Math.max(0, age) / SLUG_WAKE_LIFE_S);
}
