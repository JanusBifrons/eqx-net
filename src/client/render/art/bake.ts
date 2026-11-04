/**
 * Machined art — whole bakes, as plain data.
 *
 * Pure and DOM-free, so the same code runs on the main thread (fallback) and
 * in the bake workers (`bake.worker.ts`). A bake is a list of RGBA frames plus
 * the few facts the runtime needs (size, density, light and nozzle spots).
 */
import { forgeShip, forgeStructure, shipExtent, type Fields } from './fields.js';
import { litFrame, type Frame, type LightRig } from './shade.js';
import { linToSrgb } from './color.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';

/** Machined ships keep this many sun azimuths and cross-fade between two. */
export const SUN_STEPS = 16;
/** Structures of one kind share at most this many seeded variants. */
export const STRUCT_SEED_VARIANTS = 3;
/** Structure bake density, capped so the longest side stays within
 *  STRUCT_MAX_SIDE: small kinds stay sharp up close, big kinds affordable. */
export const STRUCT_PPU = 2;
export const STRUCT_MAX_SIDE = 1024;

export interface Baked {
  frames: Frame[];
  w: number;
  h: number;
  density: number;
  nozzles: Fields['nozzles'];
  navLights: Fields['navLights'];
}

export type BakeJob =
  | { type: 'ship'; id: string; paint?: number }
  | { type: 'struct'; id: string; seed: number; accent?: number };

/** The cache key a job's result is stored under (shared by main and workers). */
export function bakeKey(j: BakeJob): string {
  return j.type === 'ship' ? `m:${j.id}:${j.paint ?? ''}` : `m:${j.id}:${j.seed}:${j.accent ?? ''}`;
}

/** Map any placement seed onto one of the shared variants. */
export function seedVariant(seed: number): number {
  return 1 + (((seed % STRUCT_SEED_VARIANTS) + STRUCT_SEED_VARIANTS) % STRUCT_SEED_VARIANTS);
}

/** Ship frames are capped at this many texels a side (capital ships). */
export const SHIP_MAX_SIDE = 512;

export function shipPpu(id: string): number {
  return Math.min(getShipKind(id).radius >= 25 ? 3 : 4, SHIP_MAX_SIDE / (shipExtent(id) * 2 + 6));
}

/** Unlit albedo at HALF resolution (2×2 average): it only feeds the soft
 *  explosion-light overlay, so a quarter of the memory is plenty. */
export function albedoHalf(f: Fields): Frame {
  const W = f.g.w, H = f.g.h, w = Math.ceil(W / 2), h = Math.ceil(H / 2);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(W - 1, x * 2 + dx), sy = Math.min(H - 1, y * 2 + dy);
          const i = sy * W + sx, c = f.cov[i]!;
          a += c; r += c * f.albedo[i * 3]!; g += c * f.albedo[i * 3 + 1]!; b += c * f.albedo[i * 3 + 2]!;
        }
      }
      if (a <= 0) continue;
      const o = (y * w + x) * 4;
      data[o] = Math.round(linToSrgb((r / a) * 1.4) * 255);
      data[o + 1] = Math.round(linToSrgb((g / a) * 1.4) * 255);
      data[o + 2] = Math.round(linToSrgb((b / a) * 1.4) * 255);
      data[o + 3] = Math.round((a / 4) * 255);
    }
  }
  return { w, h, data };
}

export function runBake(j: BakeJob, rig: LightRig): Baked {
  if (j.type === 'ship') {
    const f = forgeShip(j.id, { ppu: shipPpu(j.id), paint: j.paint });
    const frames: Frame[] = [];
    for (let k = 0; k < SUN_STEPS; k++) frames.push(litFrame(f, rig, (k / SUN_STEPS) * Math.PI * 2));
    return { frames, w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: f.nozzles, navLights: f.navLights };
  }
  const f = forgeStructure(j.id, { ppu: STRUCT_PPU, maxSide: STRUCT_MAX_SIDE, seed: j.seed, accent: j.accent });
  return {
    frames: [litFrame(f, rig, rig.sunAz), albedoHalf(f)],
    w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: f.nozzles, navLights: f.navLights,
  };
}
