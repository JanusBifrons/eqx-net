/**
 * Depth, scale and speed (plan iridescent-seeking-rainbow v4, R&D round 2).
 *
 * Pure layout maths, shared by the lab and (after sign-off) the game:
 *  - a depth ladder: how far each backdrop band is (how much it pans and
 *    grows when the camera moves or zooms);
 *  - a sector's sky: landmarks (planets, a gas giant, moons, far nebula
 *    patches, galaxies) placed so crossing the sector carries you past
 *    them, all seeded from the sector key;
 *  - nebula regions placed in the sector itself, and the density field that
 *    says how deep inside one the camera is;
 *  - the speed effect levels the user asked to compare (off / small /
 *    medium / large).
 *
 * No allocation in the per-frame helpers (`nebulaDensityAt`, `speedFactor`).
 */
import { h01 } from './fxTextures.js';
import { getShipKind } from '../../../../shared-types/shipKinds.js';

/** A backdrop band: `parallax` = how much it pans per unit of camera motion
 *  (0 fixed, 1 = the world), `zoomPow` = how much it grows when zooming. */
export interface DepthBand { id: string; parallax: number; zoomPow: number }

/**
 * The round-2 ladder, far to near. Round 1 ran 0.012–0.085 (barely moving at
 * boost); these bands spread from 0.01 to 0.4 behind the world, plus two in
 * front of it, so motion and zoom read as depth.
 */
export const DEPTH_LADDER: readonly DepthBand[] = [
  { id: 'farSky', parallax: 0.01, zoomPow: 0.05 },
  { id: 'starsFar', parallax: 0.03, zoomPow: 0.1 },
  { id: 'starsMid', parallax: 0.08, zoomPow: 0.25 },
  { id: 'landmarks', parallax: 0.2, zoomPow: 0.3 },
  { id: 'starsNear', parallax: 0.18, zoomPow: 0.45 },
  { id: 'nearDust', parallax: 0.4, zoomPow: 0.7 },
  { id: 'foreDust', parallax: 1.3, zoomPow: 1.1 },
];

export type LandmarkKind = 'planet' | 'gasGiant' | 'moon' | 'nebulaPatch' | 'galaxy';

export interface Landmark {
  kind: LandmarkKind;
  /** World point where the landmark is centred in view (camera there ⇒ it's
   *  in the middle of the screen). Layer coordinates are this × parallax. */
  wx: number;
  wy: number;
  parallax: number;
  /** On-screen size at zoom 1 (px). */
  size: number;
  tint: number;
  seed: number;
}

/** FNV-1a of a string (a sector key → a seed). */
export function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

const PLANET_TINTS = [0x8a9bb8, 0xb08a6a, 0x7aa088, 0xa07a9a, 0x9aa6b0];
const PATCH_TINTS = [0x7f6aff, 0x5f9cff, 0xff6a9a, 0x6fd6c8];

/**
 * One kind of landmark and how it is scattered. Sizes are fixed on purpose:
 * sector sizes are arbitrary and will grow, so the sky is not laid out for a
 * sector. Instead each kind sits on an endless grid in its OWN layer space
 * (world × parallax), one chance per cell. The density on screen is then the
 * same whatever the sector's size, and a bigger sector simply has more sky to
 * cross.
 */
export interface SkyLayer {
  kind: LandmarkKind;
  parallax: number;
  zoomPow: number;
  /** Cell size in layer space (≈ screen px at zoom 1). */
  cell: number;
  /** Chance a cell holds one. */
  chance: number;
  minSize: number;
  maxSize: number;
}

export const SKY_LAYERS: readonly SkyLayer[] = [
  { kind: 'galaxy', parallax: 0.015, zoomPow: 0.05, cell: 700, chance: 0.35, minSize: 60, maxSize: 110 },
  { kind: 'nebulaPatch', parallax: 0.06, zoomPow: 0.05, cell: 1100, chance: 0.5, minSize: 700, maxSize: 1300 },
  { kind: 'gasGiant', parallax: 0.15, zoomPow: 0.25, cell: 2600, chance: 0.35, minSize: 300, maxSize: 440 },
  { kind: 'planet', parallax: 0.2, zoomPow: 0.3, cell: 1700, chance: 0.4, minSize: 120, maxSize: 230 },
  { kind: 'moon', parallax: 0.26, zoomPow: 0.3, cell: 1300, chance: 0.3, minSize: 45, maxSize: 85 },
];

/**
 * Solar-system sectors (Phase 4 step 2): the landmark layers drift this much
 * slower. Sectors are ±200 km there, and at the 1x drift a 170 km warp swept
 * dozens of planets past; at this scale the whole system shows a few bodies
 * that shift a little as you cross it (the system's own planets and moons).
 */
export const SOLAR_SKY_SCALE = 0.04;

const cellHash = (ix: number, iy: number, salt: number): number =>
  (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ salt) >>> 0;

/**
 * The landmark in cell (ix, iy) of `layer` for sector seed `seed` (from
 * `hashKey(sectorKey)`), written into `out`; false if the cell is empty.
 * Deterministic and allocation-free.
 */
export function skyCell(seed: number, layerIndex: number, ix: number, iy: number, out: Landmark, scale = 1): boolean {
  const L = SKY_LAYERS[layerIndex]!;
  const parallax = L.parallax * scale;
  const c = cellHash(ix, iy, seed + layerIndex * 977);
  if (h01(c, 1) >= L.chance) return false;
  // Layer-space position inside the cell (kept off the edges), back to the
  // world point where it is centred in view.
  const lx = (ix + 0.15 + 0.7 * h01(c, 2)) * L.cell;
  const ly = (iy + 0.15 + 0.7 * h01(c, 3)) * L.cell;
  out.kind = L.kind;
  out.parallax = parallax;
  out.wx = lx / parallax;
  out.wy = ly / parallax;
  out.size = L.minSize + (L.maxSize - L.minSize) * h01(c, 4);
  out.seed = c % 997;
  out.tint = L.kind === 'nebulaPatch' ? PATCH_TINTS[c % PATCH_TINTS.length]! : L.kind === 'moon' ? 0x9a9a9a : PLANET_TINTS[c % PLANET_TINTS.length]!;
  return true;
}

/**
 * Visit every landmark of `layer` that could be on a W×H screen for a
 * camera at (cx, cy, zoom). Calls `visit` with a reused scratch landmark
 * (copy what you keep). Allocation-free.
 */
export function visitSkyLayer(seed: number, layerIndex: number, cx: number, cy: number, zoom: number, W: number, H: number,
  scratch: Landmark, visit: (l: Landmark) => void, scale = 1): void {
  const L = SKY_LAYERS[layerIndex]!;
  const parallax = L.parallax * scale;
  const s = Math.pow(Math.max(1e-3, zoom), L.zoomPow);
  // Layer-space view half-size, padded by the biggest landmark.
  const hx = W / 2 / s + L.maxSize, hy = H / 2 / s + L.maxSize;
  const lcx = cx * parallax, lcy = cy * parallax;
  const x0 = Math.floor((lcx - hx) / L.cell), x1 = Math.floor((lcx + hx) / L.cell);
  const y0 = Math.floor((lcy - hy) / L.cell), y1 = Math.floor((lcy + hy) / L.cell);
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      if (skyCell(seed, layerIndex, ix, iy, scratch, scale)) visit(scratch);
    }
  }
}

/** A few landmarks around the sector centre, for stats and tests (allocates). */
export function sectorSky(key: string, extent = 12_000): Landmark[] {
  const seed = hashKey(`sky:${key}`);
  const out: Landmark[] = [];
  for (let li = 0; li < SKY_LAYERS.length; li++) {
    const L = SKY_LAYERS[li]!;
    const n = Math.ceil((extent * L.parallax) / 2 / L.cell);
    for (let iy = -n; iy < n; iy++) {
      for (let ix = -n; ix < n; ix++) {
        const l = { kind: L.kind, wx: 0, wy: 0, parallax: 0, size: 0, tint: 0, seed: 0 } as Landmark;
        if (skyCell(seed, li, ix, iy, l)) out.push(l);
      }
    }
  }
  return out;
}

/** Screen position of a landmark for a camera at (cx, cy), zoom `zoom`,
 *  `zoomPow` growth, on a W×H screen. Writes into `out`. */
export function landmarkScreen(l: Landmark, cx: number, cy: number, zoom: number, zoomPow: number, W: number, H: number,
  out: { x: number; y: number; scale: number }): void {
  const s = Math.pow(Math.max(1e-3, zoom), zoomPow);
  out.scale = s;
  out.x = W / 2 + (l.wx - cx) * l.parallax * s;
  out.y = H / 2 + (l.wy - cy) * l.parallax * s;
}

export interface NebulaRegion { x: number; y: number; r: number; variant: 'emission' | 'reflection' | 'dark'; seed: number }

/** Nebula volumes inside a sector (world space): you can fly into these. */
export function nebulaRegions(key: string, extent = 10_000): NebulaRegion[] {
  const s = hashKey(`neb:${key}`);
  const n = 1 + Math.floor(h01(0, s) * 3);
  const out: NebulaRegion[] = [];
  const variants = ['emission', 'reflection', 'dark'] as const;
  for (let i = 0; i < n; i++) {
    out.push({
      x: (h01(i + 1, s) - 0.5) * extent * 0.8,
      y: (h01(i + 1, s + 7) - 0.5) * extent * 0.8,
      r: 1200 + 1200 * h01(i + 1, s + 3),
      variant: variants[Math.floor(h01(i + 1, s + 5) * 3)]!,
      seed: i + 1,
    });
  }
  return out;
}

/** How deep inside a nebula volume a point is: 0 outside, 1 at the core.
 *  Soft edge over the outer 45 % of the radius. Allocation-free. */
export function nebulaDensityAt(x: number, y: number, regions: readonly NebulaRegion[]): number {
  let d = 0;
  for (let i = 0; i < regions.length; i++) {
    const g = regions[i]!;
    const r = Math.hypot(x - g.x, y - g.y) / g.r;
    if (r >= 1) continue;
    const k = Math.min(1, (1 - r) / 0.45);
    const v = k * k * (3 - 2 * k);
    if (v > d) d = v;
  }
  return d;
}

export type SpeedFxLevel = 'off' | 'small' | 'medium' | 'large';

export interface SpeedFxParams {
  /** Extra mote length per unit of speed factor (×mote size). */
  stretch: number;
  /** Fraction the camera zooms out at full speed. */
  zoomOut: number;
  /** How much brighter motes get when streaking. */
  streakGain: number;
}

export const SPEED_FX: Readonly<Record<SpeedFxLevel, SpeedFxParams>> = {
  off: { stretch: 0, zoomOut: 0, streakGain: 0 },
  small: { stretch: 3, zoomOut: 0.05, streakGain: 0.15 },
  medium: { stretch: 7, zoomOut: 0.12, streakGain: 0.35 },
  large: { stretch: 14, zoomOut: 0.2, streakGain: 0.6 },
};

/** What counts as full speed for the speed effects: the pilot's own ship's
 *  top speed (the default kind's when spectating). It follows ship size
 *  (invariant 18): against a fixed 750 (the 1× fighter) the slower 2× ships
 *  (530–672 u/s) only reached 70–90% of the effect at full boost. */
export function speedFxFullSpeed(kindId: string | null | undefined): number {
  return getShipKind(kindId ?? null).maxSpeed;
}

/** 0 at rest .. 1 at full boost speed (`max`, world units / s). */
export function speedFactor(speed: number, max = 750): number {
  const k = speed / max;
  return k <= 0 ? 0 : k >= 1 ? 1 : k;
}

/** Eased camera motion for the speed effects (C3). */
export interface SpeedFxState {
  /** Eased camera velocity (world units / s). */
  vx: number;
  vy: number;
  /** Eased speed factor, 0..1. */
  sf: number;
  px: number;
  py: number;
  t: number;
  primed: boolean;
}

/** Easing time constant: the effects settle in about 0.6 s. */
export const SPEED_FX_EASE_MS = 300;
/** Faster than this (world units / s) is a jump (respawn, glide, sector
 *  change), not flight: it doesn't count. */
export const SPEED_FX_JUMP = 6000;
/** A frame gap longer than this (a hitch, a hidden tab) just re-primes. */
export const SPEED_FX_MAX_GAP_MS = 250;

export function newSpeedFxState(): SpeedFxState {
  return { vx: 0, vy: 0, sf: 0, px: 0, py: 0, t: 0, primed: false };
}

/**
 * Advance the eased speed from the camera centre at `nowMs`. The speed is the
 * camera's own motion, so it follows the ship and also a fast spectator pan.
 * Allocation-free.
 */
export function stepSpeedFx(st: SpeedFxState, cx: number, cy: number, nowMs: number, max = 750): void {
  const dt = nowMs - st.t;
  if (!st.primed || dt > SPEED_FX_MAX_GAP_MS || dt < 0) {
    st.px = cx; st.py = cy; st.t = nowMs; st.primed = true;
    return;
  }
  if (dt === 0) return;
  let vx = ((cx - st.px) * 1000) / dt;
  let vy = ((cy - st.py) * 1000) / dt;
  st.px = cx; st.py = cy; st.t = nowMs;
  if (vx * vx + vy * vy > SPEED_FX_JUMP * SPEED_FX_JUMP) { vx = st.vx; vy = st.vy; }
  const k = 1 - Math.exp(-dt / SPEED_FX_EASE_MS);
  st.vx += (vx - st.vx) * k;
  st.vy += (vy - st.vy) * k;
  st.sf += (speedFactor(Math.sqrt(vx * vx + vy * vy), max) - st.sf) * k;
}

/** The camera zoom factor for speed factor `sf` at `level` (1 = none). */
export function speedZoomFor(level: SpeedFxLevel, sf: number): number {
  return 1 - SPEED_FX[level].zoomOut * sf;
}

// ------------------------------------------------------------------ nebula volumes (endless)

/**
 * Nebula volumes you can fly into, on an endless world-space grid (one chance
 * per cell, seeded from the sector key). Like the landmarks, nothing depends
 * on a sector's size: bigger sectors simply hold more of them.
 */
export const NEBULA_CELL = 9000;
const NEBULA_CHANCE = 0.4;
const NEBULA_VARIANTS = ['emission', 'reflection', 'dark'] as const;
/** Largest region radius (world units); used to bound the cells to check. */
export const NEBULA_MAX_R = 2800;

/** The region in cell (ix, iy) for nebula seed `seed` (`hashKey('neb:'+key)`),
 *  into `out`; false if the cell is empty. Deterministic, allocation-free. */
export function nebulaCell(seed: number, ix: number, iy: number, out: NebulaRegion): boolean {
  const c = (Math.imul(ix, 83492791) ^ Math.imul(iy, 2971215073) ^ seed) >>> 0;
  if (h01(c, 11) >= NEBULA_CHANCE) return false;
  out.x = (ix + 0.25 + 0.5 * h01(c, 12)) * NEBULA_CELL;
  out.y = (iy + 0.25 + 0.5 * h01(c, 13)) * NEBULA_CELL;
  out.r = 1400 + (NEBULA_MAX_R - 1400) * h01(c, 14);
  out.variant = NEBULA_VARIANTS[c % 3]!;
  out.seed = c % 997;
  return true;
}

/** Visit every region whose edge comes within `reach` of (x, y). */
export function visitNebulae(seed: number, x: number, y: number, reach: number, scratch: NebulaRegion,
  visit: (g: NebulaRegion) => void): void {
  const R = reach + NEBULA_MAX_R;
  const x0 = Math.floor((x - R) / NEBULA_CELL), x1 = Math.floor((x + R) / NEBULA_CELL);
  const y0 = Math.floor((y - R) / NEBULA_CELL), y1 = Math.floor((y + R) / NEBULA_CELL);
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      if (!nebulaCell(seed, ix, iy, scratch)) continue;
      if (Math.hypot(x - scratch.x, y - scratch.y) - scratch.r <= reach) visit(scratch);
    }
  }
}

/** How deep inside a nebula (x, y) is for nebula seed `seed`: 0 outside, 1
 *  at a core. Checks only the nearby cells; allocation-free. */
export function nebulaDensityAtSeed(seed: number, x: number, y: number, scratch: NebulaRegion): number {
  let d = 0;
  const ix0 = Math.floor(x / NEBULA_CELL), iy0 = Math.floor(y / NEBULA_CELL);
  for (let iy = iy0 - 1; iy <= iy0 + 1; iy++) {
    for (let ix = ix0 - 1; ix <= ix0 + 1; ix++) {
      if (!nebulaCell(seed, ix, iy, scratch)) continue;
      const r = Math.hypot(x - scratch.x, y - scratch.y) / scratch.r;
      if (r >= 1) continue;
      const k = Math.min(1, (1 - r) / 0.45);
      const v = k * k * (3 - 2 * k);
      if (v > d) d = v;
    }
  }
  return d;
}
