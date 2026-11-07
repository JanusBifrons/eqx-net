/**
 * Machined art — whole bakes, as plain data.
 *
 * Pure and DOM-free, so the same code runs on the main thread (fallback) and
 * in the bake workers (`bake.worker.ts`). A bake is a list of RGBA frames plus
 * the few facts the runtime needs (size, density, light and nozzle spots).
 */
import { forgeRock, forgeScrap, forgeShip, forgeStructure, forgeTurretGun, shipExtent, type Fields, type GunFamily } from './fields.js';
import { shipTurrets, structureTurrets } from './turretLayout.js';
import { bakeFxImg, FX_VERSION, isFxId } from './fx/fxTextures.js';
import { litFrame, type Frame, type LightRig } from './shade.js';
import { linToSrgb } from './color.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipTuning } from '../../../shared-types/shipScale/tuning.js';
import { SHIP_SCALE } from '../../../shared-types/shipScale/config.js';

/** Machined ships keep this many sun azimuths and cross-fade between two. */
export const SUN_STEPS = 16;
/** Structures of one kind share at most this many seeded variants. */
export const STRUCT_SEED_VARIANTS = 3;
/** Structure bake density, capped so the longest side stays within
 *  STRUCT_MAX_SIDE: small kinds stay sharp up close, big kinds affordable. */
export const STRUCT_PPU = 2;
export const STRUCT_MAX_SIDE = 1024;

/** Capital hulls (capital-ship R&D round 3 E): a 5.8 km hull baked sharp is
 *  too big for one texture, so its frames are cut into tiles of at most
 *  TILE_MAX_SIDE texels along the hull, each its own texture; and it keeps
 *  only CAPITAL_SUN_STEPS sun angles (a slow-turning hull hardly needs 16). */
export const CAPITAL_SUN_STEPS = 4;
export const TILE_MAX_SIDE = 1024;

export function isCapitalKind(id: string): boolean {
  return getShipKind(id).sizeClass === 'capital';
}

export interface Baked {
  /** Sun-major: with tiles, frame `sun * tiles + tile`. */
  frames: Frame[];
  w: number;
  h: number;
  /** Tiles per sun frame, cut along rows (absent ⇒ 1, untiled). */
  tiles?: number;
  /** Rows per tile (the last may be shorter). */
  tileH?: number;
  density: number;
  nozzles: Fields['nozzles'];
  navLights: Fields['navLights'];
}

export type BakeJob =
  /** `rings` (R&D, rnd/turrets): cut turret rings into the hull at its mounts. */
  | { type: 'ship'; id: string; paint?: number; rings?: boolean }
  /** `rot`: the structure's sprite rotation (radians, quarter turns). The sun
   *  is baked relative to it, so a turned structure is still lit from the
   *  sector's sun rather than having its lighting turn with it. */
  | { type: 'struct'; id: string; seed: number; accent?: number; rot?: number; rings?: boolean }
  /** The turning part of a turret (R&D, rnd/turrets); lit at every sun step like a ship. */
  | { type: 'turret'; id: GunFamily; paint: number; len: number; wid: number; cap: number; ppu: number; naval?: { barrels: number; houseW: number; houseL: number; part?: 'house' | 'barrel' } }
  /** One component of a destroyed ship; tumbles, so baked like a ship. */
  | { type: 'scrap'; id: string; component: number }
  /** An asteroid, by its seeded outline; static, so one frame at its turn. */
  | { type: 'rock'; id: string; entityId: number; radius: number; resource?: string; rot?: number }
  /** An effect or backdrop texture (art/fx/fxTextures.ts, plan iridescent-seeking-rainbow v3). */
  | { type: 'fx'; id: string; variant?: string; seed?: number };

/** Ship-shaped bakes depend on the ship scale (they're cached between
 *  sessions): tag their keys when it isn't 1, so 1× keys are unchanged. */
const SCALE_TAG = SHIP_SCALE === 1 ? '' : `@s${SHIP_SCALE}`;

/** The cache key a job's result is stored under (shared by main and workers). */
export function bakeKey(j: BakeJob): string {
  if (j.type === 'ship') return `m:${j.id}:${j.paint ?? ''}${j.rings ? ':R' : ''}${isCapitalKind(j.id) ? ':T' : ''}${SCALE_TAG}`;
  if (j.type === 'turret') return `g:${j.id}:${j.paint}:${j.len.toFixed(2)}:${j.wid.toFixed(2)}:${j.cap.toFixed(2)}:${j.ppu}${j.naval ? `:n${j.naval.barrels}:${j.naval.houseW.toFixed(2)}:${j.naval.houseL.toFixed(2)}${j.naval.part ? `:${j.naval.part}` : ''}` : ''}`;
  if (j.type === 'scrap') return `s:${j.id}:${j.component}${SCALE_TAG}`;
  if (j.type === 'fx') return `x:${FX_VERSION}:${j.id}:${j.variant ?? ''}:${j.seed ?? ''}`;
  if (j.type === 'rock') return `r:${j.entityId}:${j.radius}:${j.resource ?? ''}:${quarterTurnsFine(j.rot ?? 0)}`;
  const q = quarterTurns(j.rot ?? 0);
  return `m:${j.id}:${j.seed}:${j.accent ?? ''}${q ? `:r${q}` : ''}${j.rings ? ':R' : ''}`;
}

/** Asteroid turns snapped to 1/16 of a circle (they sit at any angle). */
export function quarterTurnsFine(rot: number): number {
  const q = Math.round(rot / (Math.PI / 8)) % 16;
  return q < 0 ? q + 16 : q;
}

/** A rotation snapped to whole quarter turns, 0..3. */
export function quarterTurns(rot: number): number {
  const q = Math.round(rot / (Math.PI / 2)) % 4;
  return q < 0 ? q + 4 : q;
}

/** Map any placement seed onto one of the shared variants. */
export function seedVariant(seed: number): number {
  return 1 + (((seed % STRUCT_SEED_VARIANTS) + STRUCT_SEED_VARIANTS) % STRUCT_SEED_VARIANTS);
}

/** Ship frames are capped at this many texels a side (capital ships). */
export const SHIP_MAX_SIDE = 512;

/** Scrap keeps the old single-texture budget (it tumbles; 16 suns, untiled). */
export function scrapPpu(id: string): number {
  const t = shipTuning(getShipKind(id));
  return Math.min(t.bakePpu, Math.min(t.bakeMaxSide, TILE_MAX_SIDE) / (shipExtent(id) * 2 + 6));
}

/** Cut a frame into row bands of at most `tileH` rows (copies). */
export function splitRows(f: Frame, tileH: number, out: Frame[]): void {
  for (let y0 = 0; y0 < f.h; y0 += tileH) {
    const y1 = Math.min(f.h, y0 + tileH);
    out.push({ w: f.w, h: y1 - y0, data: f.data.slice(y0 * f.w * 4, y1 * f.w * 4) });
  }
}

export function shipPpu(id: string): number {
  // Density by the UNSCALED hull, within the class's side budget (tuning), so
  // a 2× ship is as sharp per unit as today's and a capital has its own cap.
  const t = shipTuning(getShipKind(id));
  return Math.min(t.bakePpu, t.bakeMaxSide / (shipExtent(id) * 2 + 6));
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

/** Asteroids are numerous and unique: a coarser bake, capped at 256 texels. */
export const ROCK_MAX_SIDE = 256;

export function runBake(j: BakeJob, rig: LightRig): Baked {
  if (j.type === 'fx') {
    if (!isFxId(j.id)) throw new Error(`unknown fx texture ${j.id}`);
    const img = bakeFxImg(j.id, j.variant, j.seed, rig.sunAz);
    return { frames: [img], w: img.w, h: img.h, density: 1, nozzles: [], navLights: [] };
  }
  if (j.type === 'rock') {
    const ppu = Math.min(1.5, ROCK_MAX_SIDE / (j.radius * 2.6 + 4));
    const f = forgeRock(j.entityId, j.radius, j.resource, { ppu });
    const turn = quarterTurnsFine(j.rot ?? 0) * (Math.PI / 8);
    return { frames: [litFrame(f, rig, rig.sunAz - turn), albedoHalf(f)], w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: [], navLights: [] };
  }
  if (j.type === 'turret') {
    const f = forgeTurretGun({ family: j.id, paint: j.paint, len: j.len, wid: j.wid, cap: j.cap, ppu: j.ppu, ...(j.naval ? { naval: j.naval } : {}) });
    const frames: Frame[] = [];
    for (let k = 0; k < SUN_STEPS; k++) frames.push(litFrame(f, rig, (k / SUN_STEPS) * Math.PI * 2));
    return { frames, w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: [], navLights: [] };
  }
  if (j.type === 'ship' || j.type === 'scrap') {
    const rings = j.type === 'ship' && j.rings ? shipTurrets(j.id).map((t) => ({ x: t.px, y: t.py, r: t.ring })) : undefined;
    const f = j.type === 'ship'
      ? forgeShip(j.id, { ppu: shipPpu(j.id), paint: j.paint, rings })
      : forgeScrap(j.id, j.component, { ppu: scrapPpu(j.id) });
    const frames: Frame[] = [];
    const tiled = j.type === 'ship' && isCapitalKind(j.id) && f.g.h > TILE_MAX_SIDE;
    const steps = j.type === 'ship' && isCapitalKind(j.id) ? CAPITAL_SUN_STEPS : SUN_STEPS;
    for (let k = 0; k < steps; k++) {
      const lit = litFrame(f, rig, (k / steps) * Math.PI * 2);
      if (tiled) splitRows(lit, TILE_MAX_SIDE, frames); else frames.push(lit);
    }
    const tiles = tiled ? Math.ceil(f.g.h / TILE_MAX_SIDE) : 1;
    return { frames, w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: f.nozzles, navLights: f.navLights, ...(tiles > 1 ? { tiles, tileH: TILE_MAX_SIDE } : {}) };
  }
  const rings = j.rings ? structureTurrets(j.id).map((t) => ({ x: t.px, y: t.py, r: t.ring })) : undefined;
  const f = forgeStructure(j.id, { ppu: STRUCT_PPU, maxSide: STRUCT_MAX_SIDE, seed: j.seed, accent: j.accent, rings });
  return {
    frames: [litFrame(f, rig, rig.sunAz - quarterTurns(j.rot ?? 0) * (Math.PI / 2)), albedoHalf(f)],
    w: f.g.w, h: f.g.h, density: f.g.ppu, nozzles: f.nozzles, navLights: f.navLights,
  };
}
