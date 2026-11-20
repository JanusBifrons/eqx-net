/**
 * The paint primitives behind `buildStructureVisual` (`structureVisuals.ts`):
 * the shared palette, rect helpers (`box`, `slab`, `hazard`), gate posts and
 * shield spans, and the coastal-defence gun emplacements. Pure and
 * deterministic: each pushes rect / light ops into the caller's lists.
 */
import { mixColor } from './structureStyleKit.js';

/** A filled rectangle (pixi space). */
export interface RectOp { x: number; y: number; w: number; h: number; color: number; alpha: number }
/** A light point (pixi space). */
export interface LightOp { x: number; y: number; r: number; color: number }

/** A gate shield span between two posts: bright when closed, a faint ghost
 *  line when open. Horizontal span from x0..x1 at y, thickness t. */
export function shieldSpan(out: RectOp[], lights: LightOp[], x0: number, x1: number, y: number, t: number, open: boolean, accent: number, live: boolean): void {
  if (open || !live) {
    // Open: two short stubs at the posts + a faint dashed guide.
    for (let x = x0; x < x1; x += 28) out.push({ x, y: y - 1, w: 12, h: 2, color: accent, alpha: 0.35 });
    return;
  }
  out.push({ x: x0, y: y - t / 2, w: x1 - x0, h: t, color: accent, alpha: 0.28 });
  out.push({ x: x0, y: y - t / 6, w: x1 - x0, h: Math.max(2, t / 3), color: mixColor(accent, 0xffffff, 0.5), alpha: 0.85 });
  lights.push({ x: (x0 + x1) / 2, y, r: 8, color: accent });
}

/** A gate post (the shield emitter block at either end of a gate). */
export function gatePost(out: RectOp[], x: number, y: number, size: number, accent: number): void {
  slab(out, x - size / 2, y - size / 2, size, size, STEEL_DARK, 6);
  box(out, x - size / 2 + 12, y - size / 2 + 12, size - 24, size - 24, STEEL);
  box(out, x - 8, y - 8, 16, 16, mixColor(accent, 0xffffff, 0.3));
}

export const STEEL = 0x6b7a8f;
export const STEEL_DARK = 0x3c4656;
export const STEEL_LIGHT = 0x9aa8bb;
export const DECK = 0x1d2433;
export const GLASS = 0x7cf7ff;
export const WARM = 0xffd27a;
export const RED = 0xff4d5e;
// Coastal defences — poured concrete and earth for the gun batteries.
const CONCRETE = 0x8b877c;
const CONCRETE_DARK = 0x57544c;
const EARTH = 0x3a3a2c;

/**
 * A gun battery's emplacement (plan coastal-defences). In local space the gun
 * rests facing -y (the top edge, game +y), so the embrasure / open arc is at
 * the top. The gunhouse and barrels are the mount visuals drawn on top
 * (naval turret art, the same as a ship's guns).
 *  - 'pad':  an all-round barbette — a concrete apron with the ring cut in.
 *  - 'tub':  a sandbagged AA tub with ready-use lockers.
 *  - 'casemate': a thick concrete bunker; the roof steps back, and a dark
 *    embrasure is cut across the front (its width ≈ the arc of fire).
 *  - 'rail': a siege gun's carriage on two lengths of track.
 */
export function gunBattery(
  out: RectOp[], style: 'pad' | 'tub' | 'casemate' | 'rail', x0: number, y0: number, W: number, H: number,
  ringR: number, embrasure: number, accent: number, seed: number,
): void {
  if (style === 'rail') {
    // Ballast bed, sleepers and two rails along the length.
    box(out, x0 + W * 0.15, y0, W * 0.7, H, EARTH, 0.9);
    for (let y = y0 + 10; y < y0 + H - 10; y += 34) box(out, x0 + W * 0.1, y, W * 0.8, 12, 0x4a3b2a);
    for (const rx of [-W * 0.22, W * 0.22]) box(out, rx - 4, y0, 8, H, STEEL_LIGHT);
    // The carriage: bogies at each end, the cradle in the middle.
    slab(out, x0 + W * 0.12, y0 + H * 0.06, W * 0.76, H * 0.18, STEEL_DARK, 6);
    slab(out, x0 + W * 0.12, y0 + H * 0.76, W * 0.76, H * 0.18, STEEL_DARK, 6);
    slab(out, x0 + W * 0.05, y0 + H * 0.28, W * 0.9, H * 0.44, mixColor(STEEL, accent, 0.4), 10);
    box(out, -ringR, -ringR, ringR * 2, ringR * 2, mixColor(accent, STEEL_DARK, 0.5));
    return;
  }
  if (style === 'tub') {
    // Sandbag ring: a chamfered square of bags around the mount.
    const bag = 18;
    for (let x = x0; x < x0 + W - bag / 2; x += bag) {
      box(out, x + 1, y0, bag - 2, bag, (hash(seed, x) & 1) ? 0x8a7a55 : 0x9a8a62);
      box(out, x + 1, y0 + H - bag, bag - 2, bag, (hash(seed, x + 7) & 1) ? 0x8a7a55 : 0x9a8a62);
    }
    for (let y = y0 + bag; y < y0 + H - bag - bag / 2; y += bag) {
      box(out, x0, y + 1, bag, bag - 2, (hash(seed, y) & 1) ? 0x8a7a55 : 0x9a8a62);
      box(out, x0 + W - bag, y + 1, bag, bag - 2, (hash(seed, y + 7) & 1) ? 0x8a7a55 : 0x9a8a62);
    }
    box(out, x0 + bag, y0 + bag, W - 2 * bag, H - 2 * bag, CONCRETE_DARK);
    // Ready-use ammunition lockers in the corners.
    for (const [lx, ly] of [[x0 + bag + 4, y0 + bag + 4], [x0 + W - bag - 22, y0 + H - bag - 16]] as const) box(out, lx, ly, 18, 12, 0x4d5a3a);
    box(out, -ringR, -ringR, ringR * 2, ringR * 2, mixColor(accent, CONCRETE_DARK, 0.5));
    return;
  }
  // Concrete apron, lightly weathered.
  slab(out, x0, y0, W, H, CONCRETE_DARK, 10);
  box(out, x0 + 10, y0 + 10, W - 20, H - 20, CONCRETE);
  for (let k = 0; k < 6; k++) {
    // Weathering streaks, kept inside the apron (render == collider).
    const h = hash(seed, k);
    const sw = 30 + (h % 40);
    box(out, x0 + 14 + (h % Math.max(1, W - 28 - sw)), y0 + 14 + ((h >>> 8) % Math.max(1, H - 34)), sw, 6, CONCRETE_DARK, 0.35);
  }
  if (style === 'casemate') {
    // Stepped roof (thick overhead cover), set back from the front.
    slab(out, x0 + W * 0.08, y0 + H * 0.3, W * 0.84, H * 0.62, mixColor(CONCRETE, 0xffffff, 0.08), 8);
    slab(out, x0 + W * 0.18, y0 + H * 0.45, W * 0.64, H * 0.4, mixColor(CONCRETE, 0xffffff, 0.14), 6);
    // Embrasure: the dark firing slot across the front face.
    box(out, -embrasure / 2, y0, embrasure, H * 0.3, 0x15171a);
    box(out, -embrasure / 2, y0 + H * 0.3 - 4, embrasure, 4, CONCRETE_DARK);
    // Camouflage netting patches on the roof.
    for (let k = 0; k < 4; k++) {
      const h = hash(seed + 3, k);
      box(out, x0 + W * 0.15 + (h % Math.max(1, Math.floor(W * 0.6))), y0 + H * 0.5 + ((h >>> 9) % Math.max(1, Math.floor(H * 0.35))), 40, 24, 0x4a5236, 0.45);
    }
  }
  // The barbette ring the gun turns on.
  box(out, -ringR - 6, -ringR - 6, ringR * 2 + 12, ringR * 2 + 12, CONCRETE_DARK);
  box(out, -ringR, -ringR, ringR * 2, ringR * 2, mixColor(accent, STEEL_DARK, 0.55));
}

export function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function box(out: RectOp[], x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
  out.push({ x, y, w, h, color, alpha });
}

/** Body with a darker rim and a lighter top face (the base-piece look). */
export function slab(out: RectOp[], x: number, y: number, w: number, h: number, base: number, rim = 6): void {
  box(out, x, y, w, h, mixColor(base, 0x000000, 0.35));
  box(out, x + rim, y + rim, w - 2 * rim, h - 2 * rim, base);
  box(out, x + rim, y + rim, w - 2 * rim, Math.max(2, Math.floor(rim / 2)), mixColor(base, 0xffffff, 0.18));
}

export function hazard(out: RectOp[], x: number, y: number, w: number, h: number): void {
  const t = 6;
  for (let s = 0; s < w; s += 24) {
    box(out, x + s, y, Math.min(12, w - s), t, 0xe8c547, 0.85);
    box(out, x + s, y + h - t, Math.min(12, w - s), t, 0xe8c547, 0.85);
  }
}
