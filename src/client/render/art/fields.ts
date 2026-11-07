/**
 * Machined art — surface fields for ships and structures.
 *
 * A "field set" is everything the light pass needs, baked once per kind from
 * data the game already has: the catalogue polygon / composite parts for a
 * ship, the `structureVisuals` draw plan for a structure. Nothing is drawn by
 * hand, so a new kind gets art for free; `HINTS` only nudges the recipe.
 *
 * Local space is Pixi-up (ship nose at -y). Heights are in WORLD units.
 */
import { getShipKind, type ShipKind } from '../../../shared-types/shipKinds.js';
import { buildStructureVisual, PROPOSED_FOOTPRINTS } from '../pixi/structureVisuals.js';
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';
import { boxBlur, distanceInside, gridFor, hashStr, insidePoly, rasterPoly, rng, type Grid, type Poly } from './raster.js';
import { shipScrapGroups } from '../../../core/geometry/shipScrapGroups.js';
import { shipShapeScale } from '../../../core/geometry/shipHullOutline.js';
import { generateAsteroidVertices } from '../../../core/swarm/asteroidShape.js';
import { NAVAL_BARREL_SPAN } from '../../../core/combat/muzzle.js';

export const MAT = {
  NONE: 0,
  METAL: 1,
  PAINT: 2,
  TRIM: 3,
  GLASS: 4,
  NOZZLE: 5,
  LIGHT: 6,
  WINDOW: 7,
  ROCK: 8,
} as const;

export interface Fields {
  g: Grid;
  /** Coverage 0..1. */
  cov: Float32Array;
  /** Height, world units. */
  height: Float32Array;
  /** Material id per texel (MAT). */
  mat: Uint8Array;
  /** Linear-RGB albedo, 3 floats per texel. */
  albedo: Float32Array;
  /** Linear-RGB emission, 3 floats per texel. */
  emis: Float32Array;
  /** sRGB hex of the material's base colour per texel: the pixel look's ramp
   *  key (so grime and panel jitter never split a surface into many ramps). */
  key: Uint32Array;
  /** The paint colour this set was built with (for faction tints / ramps). */
  paint: number;
  /** Nav lights + nozzles in local world units (runtime glow sprites). */
  navLights: Array<{ x: number; y: number; color: number }>;
  nozzles: Array<{ x: number; y: number; r: number; len?: number }>;
}

/** sRGB hex → linear rgb. */
export function lin(hex: number): [number, number, number] {
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

function newFields(g: Grid, paint: number): Fields {
  const n = g.w * g.h;
  return {
    g,
    cov: new Float32Array(n),
    height: new Float32Array(n),
    mat: new Uint8Array(n),
    albedo: new Float32Array(n * 3),
    emis: new Float32Array(n * 3),
    key: new Uint32Array(n),
    paint,
    navLights: [],
    nozzles: [],
  };
}

function setAlbedo(f: Fields, i: number, c: readonly number[], k = 1): void {
  f.albedo[i * 3] = c[0]! * k;
  f.albedo[i * 3 + 1] = c[1]! * k;
  f.albedo[i * 3 + 2] = c[2]! * k;
}

/** Per-kind recipe nudges. Everything else is derived from the geometry. */
type Archetype = 'fighter' | 'freighter' | 'robot';
function archetypeOf(id: string): Archetype {
  if (id.startsWith('robot')) return 'robot';
  if (id === 'trader-hauler' || id === 'cargo-pod') return 'freighter';
  return 'fighter';
}

/** Hull metal, trim and glass base colours (sRGB). One shared material set so
 *  every ship and structure reads as one universe. */
export const PALETTE = {
  metal: 0x737c8b,
  metalWorn: 0xb4bcc8,
  trim: 0x262b34,
  glass: 0x123247,
  nozzle: 0x1b1c22,
  engine: 0xffa24a,
  navPort: 0xff3b3b,
  navStarboard: 0x3bff7a,
};

/** Soften a catalogue colour into a paint: less neon, a touch darker. */
export function paintOf(hex: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const grey = (r + g + b) / 3;
  const s = 0.78, d = 0.86;
  const m = (c: number): number => Math.round(Math.max(0, Math.min(255, (grey + (c - grey) * s) * d)));
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

/** World-space part polygons for a ship kind (same transform as the game). */
export function shipParts(kind: ShipKind): Array<{ pts: Poly; color: number }> {
  const s = kind.shape.scale;
  if (kind.shape.kind === 'polygon') {
    return [{ pts: kind.shape.points.map(([x, y]) => [x * s, y * s] as const), color: kind.shape.color }];
  }
  return kind.shape.parts.map((p) => ({
    pts: p.points.map(([x, y]) => [(x + p.offsetX) * s, (y + p.offsetY) * s] as const),
    color: p.color,
  }));
}

/** Half-extent of a ship's drawn outline (world units): the catalogue `radius`
 *  is the collider and can be far smaller than the drawing. */
export function shipExtent(id: string): number {
  let m = 0;
  for (const p of shipParts(getShipKind(id))) for (const [x, y] of p.pts) m = Math.max(m, Math.abs(x), Math.abs(y));
  return m;
}

export interface ShipForgeOpts {
  /** Texels per world unit. */
  ppu: number;
  /** Override the paint (faction colour). Default: the catalogue colour. */
  paint?: number;
  /** Forge these parts instead of the kind's hull (a scrap component). */
  parts?: Array<{ pts: Poly; color: number }>;
  /** Seed text for the plating (default: the kind id). */
  seedKey?: string;
  /** A dead piece: no canopy, engines or running lights. */
  scrap?: boolean;
  /** Turret rings to cut into the hull (local world units, Pixi-up), R&D. */
  rings?: ReadonlyArray<{ x: number; y: number; r: number }>;
}

/**
 * Build the field set for a ship kind.
 *
 *  - Form: a bevel at the silhouette edge plus a chined ridge along the medial
 *    axis (the distance transform's crest), so the hull reads as a folded,
 *    hard-surface solid under a directional light.
 *  - Plating: grooves on contours of the distance field (they follow the hull's
 *    own shape) plus seeded transverse cuts; mirrored by construction.
 *  - Paint: the outer band is painted (the silhouette carries the colour at
 *    10 px), inner bands alternate paint / bare metal by seed.
 *  - Details: canopy (glass dome) on the forward spine, greebles in mirrored
 *    pairs, nozzles at the stern from `engineGeometry`, red/green nav lights at
 *    the widest points.
 */
export function forgeShip(kindId: string, opts: ShipForgeOpts): Fields {
  const kind = getShipKind(kindId);
  const arch = archetypeOf(kind.id);
  const parts = opts.parts ?? shipParts(kind);
  const g = gridFor(parts.map((p) => p.pts), opts.ppu, 3);
  const basePaint = opts.paint ?? parts[0]!.color;
  const f = newFields(g, paintOf(basePaint));
  const n = g.w * g.h;
  const seedKey = opts.seedKey ?? kind.id;
  const R = rng(hashStr(seedKey));

  // Union coverage + per-part layer index (top-most part wins).
  const layer = new Int8Array(n).fill(-1);
  const partCols: number[] = [];
  parts.forEach((p, idx) => {
    const c = rasterPoly(g, p.pts);
    partCols.push(p.color);
    for (let i = 0; i < n; i++) {
      if (c[i]! > f.cov[i]!) f.cov[i] = c[i]!;
      if (c[i]! > 0.5) layer[i] = idx;
    }
  });
  const dist = distanceInside(f.cov, g.w, g.h);
  // The form (bevel + ridge) reads a smoothed copy: the exact transform is
  // stepped, and the steps show as streaks under a raking light.
  const distS = boxBlur(dist, g.w, g.h, Math.max(1, Math.round(g.ppu * 0.6)));
  let maxD = 0;
  for (let i = 0; i < n; i++) if (dist[i]! > maxD) maxD = dist[i]!;
  const maxDu = maxD / g.ppu;

  const Hmax = Math.min(14, Math.max(1.2, maxDu * 0.55));
  const bw = Math.min(4, Math.max(0.6, maxDu * 0.18));
  // Panel bands: at most ~5 across the hull, however big it is.
  const spacing = Math.max(maxDu / 5, Math.min(14, Math.max(2.2, maxDu * 0.42)));
  const grooveW = Math.max(0.35, 1.2 / g.ppu);

  // Per-part bevel for composites (each part a raised plate).
  const partDist: Float32Array[] = parts.length > 1
    ? parts.map((p) => distanceInside(rasterPoly(g, p.pts, 2), g.w, g.h))
    : [];

  // Transverse cuts (y in world units), avoiding the nose tip.
  let yMin = Infinity, yMax = -Infinity;
  for (const p of parts) for (const [, y] of p.pts) { yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
  const len = yMax - yMin;
  const cuts: number[] = [];
  const nCuts = arch === 'freighter' ? Math.max(4, Math.round(len / 7)) : arch === 'robot' ? 0 : 1 + Math.floor(R() * 3);
  for (let k = 0; k < nCuts; k++) {
    cuts.push(arch === 'freighter' ? yMin + len * ((k + 1) / (nCuts + 1)) : yMin + len * (0.3 + R() * 0.6));
  }
  const paintBands = [true, true, R() < 0.45, true, R() < 0.5];

  const metal = lin(PALETTE.metal);
  const noiseSeed = hashStr(seedKey + ':grime');
  const panelSeed = hashStr(seedKey + ':panels');

  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const du = dist[i]! / g.ppu;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const dus = distS[i]! / g.ppu;
      const t = Math.min(1, dus / bw);
      const bevel = Math.sqrt(1 - (1 - t) * (1 - t));
      const ridge = Math.pow(Math.min(1, dus / Math.max(0.001, maxDu)), 0.85);
      let h = Hmax * (0.35 * bevel + 0.65 * ridge);
      if (arch === 'robot') h = Hmax * (0.45 * bevel + 0.55 * Math.sqrt(ridge)); // domed
      if (partDist.length > 0 && layer[i]! > 0) {
        const pd = partDist[layer[i]!]![i]! / g.ppu;
        h += 0.6 * Math.min(1, pd / bw) * layer[i]! / parts.length * Hmax;
      }

      // Plating: panels are the cells between distance contours and the
      // transverse cuts; each gets its own tone (mirror-symmetric by
      // construction), grooves are the seams between them.
      let mat: number = MAT.PAINT;
      const band = Math.floor(du / spacing);
      let seg = 0;
      for (let ci = 0; ci < cuts.length; ci++) if (wy > cuts[ci]! + (hash01(band * 7 + ci, noiseSeed) - 0.5) * len * 0.12) seg++;
      const inner = du > spacing * 0.6;
      const inGroove = (inner && (du % spacing) < grooveW)
        || (inner && cuts.some((c, ci) => hash01(band * 13 + ci, panelSeed) > 0.35 && Math.abs(wy - c - (hash01(band * 7 + ci, noiseSeed) - 0.5) * len * 0.12) < grooveW * 0.5))
        || (arch === 'robot' && du > bw && Math.abs(Math.atan2(wy, wx) % (Math.PI / 3)) < grooveW / Math.max(1, Math.hypot(wx, wy)));
      if (!paintBands[Math.min(band, paintBands.length - 1)]) mat = MAT.METAL;
      const pv = 0.88 + 0.2 * hash01(band * 31 + seg * 7, panelSeed);
      const nz = valueNoise(wx * 0.35, wy * 0.35, noiseSeed);
      const colHex = parts.length > 1 && layer[i]! >= 0 ? paintOf(partCols[layer[i]!]!) : f.paint;
      const col = lin(colHex);
      const surf = mat === MAT.PAINT ? col : metal;
      f.key[i] = mat === MAT.PAINT ? colHex : PALETTE.metal;
      if (inGroove) {
        setAlbedo(f, i, surf, 0.38);
        mat = MAT.TRIM;
        h -= Math.min(0.3, Hmax * 0.05);
      } else {
        setAlbedo(f, i, surf, pv * (0.95 + 0.08 * nz));
      }
      f.height[i] = h;
      f.mat[i] = mat;
    }
  }

  const put = (cx: number, cy: number, rx: number, ry: number, fn: (i: number, k: number) => void): void => {
    const x0 = Math.floor((cx - rx) * g.ppu + g.ox), x1 = Math.ceil((cx + rx) * g.ppu + g.ox);
    const y0 = Math.floor((cy - ry) * g.ppu + g.oy), y1 = Math.ceil((cy + ry) * g.ppu + g.oy);
    for (let ty = Math.max(0, y0); ty <= Math.min(g.h - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(g.w - 1, x1); tx++) {
        const wx = (tx + 0.5 - g.ox) / g.ppu - cx, wy = (ty + 0.5 - g.oy) / g.ppu - cy;
        const k = (wx * wx) / (rx * rx) + (wy * wy) / (ry * ry);
        const i = ty * g.w + tx;
        if (k <= 1 && f.cov[i]! > 0.5) fn(i, k);
      }
    }
  };
  /** Axis-aligned block; fn gets the bevel 0..1 from the block edge. */
  const putRect = (cx: number, cy: number, hw: number, hh: number, fn: (i: number, bev: number) => void): void => {
    const x0 = Math.floor((cx - hw) * g.ppu + g.ox), x1 = Math.ceil((cx + hw) * g.ppu + g.ox);
    const y0 = Math.floor((cy - hh) * g.ppu + g.oy), y1 = Math.ceil((cy + hh) * g.ppu + g.oy);
    const bwr = Math.max(0.25, Math.min(hw, hh) * 0.5);
    for (let ty = Math.max(0, y0); ty < Math.min(g.h, y1); ty++) {
      for (let tx = Math.max(0, x0); tx < Math.min(g.w, x1); tx++) {
        const wx = (tx + 0.5 - g.ox) / g.ppu - cx, wy = (ty + 0.5 - g.oy) / g.ppu - cy;
        const ed = Math.min(hw - Math.abs(wx), hh - Math.abs(wy));
        const i = ty * g.w + tx;
        if (ed >= 0 && f.cov[i]! > 0.5) fn(i, Math.min(1, ed / bwr));
      }
    }
  };
  const distAt = (x: number, y: number): number => {
    const tx = Math.round(x * g.ppu + g.ox), ty = Math.round(y * g.ppu + g.oy);
    if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) return 0;
    return dist[ty * g.w + tx]! / g.ppu;
  };

  // Greebles: small mirrored blocks aligned to the hull axis, plus a row of
  // vent slits ahead of the stern.
  const nGreeble = arch === 'robot' ? 3 : arch === 'freighter' ? 6 : 2 + Math.floor(R() * 3);
  const metalDark = lin(0x5d6573);
  for (let k = 0; k < nGreeble; k++) {
    for (let tries = 0; tries < 30; tries++) {
      const gx = (R() - 0.5) * (g.w / g.ppu) * 0.7, gy = (R() - 0.5) * (g.h / g.ppu) * 0.8;
      const sz = Math.max(0.45, maxDu * (0.07 + R() * 0.09));
      const hw = sz * (0.5 + R() * 1.1), hh = sz * (0.5 + R() * 1.1);
      if (distAt(gx, gy) < Math.max(hw, hh) * 1.6 || distAt(-gx, gy) < Math.max(hw, hh) * 1.6) continue;
      for (const sx of [gx, -gx]) {
        putRect(sx, gy, hw, hh, (i, bev) => {
          f.height[i] = f.height[i]! + Math.max(0.25, Hmax * 0.09) * bev;
          f.mat[i] = MAT.METAL;
          f.key[i] = PALETTE.metal;
          setAlbedo(f, i, metalDark, bev < 0.3 ? 0.8 : 1);
        });
      }
      break;
    }
  }
  if (arch !== 'robot') {
    const vy0 = yMax - len * 0.32;
    const slitH = Math.max(0.22, 0.7 / g.ppu), slitW = Math.max(0.5, maxDu * 0.16);
    for (let k = 0; k < 3; k++) {
      const vy = vy0 + k * slitH * 2.6;
      const vx = maxDu * 0.45;
      if (distAt(vx, vy) < slitW * 1.4) continue;
      for (const sx of [vx, -vx]) {
        putRect(sx, vy, slitW, slitH * 0.5, (i) => {
          f.mat[i] = MAT.TRIM;
          f.key[i] = PALETTE.metal;
          setAlbedo(f, i, lin(PALETTE.trim));
          f.height[i] = f.height[i]! - 0.2;
        });
      }
    }
  }

  // Canopy on the forward spine (not robots, not scrap).
  if (opts.scrap) {
    // A broken piece has no canopy or core.
  } else if (arch !== 'robot') {
    let bestY = 0, best = -1;
    for (let y = yMin; y < yMin + len * 0.55; y += 0.25) {
      const d = distAt(0, y) * (1 - (y - yMin) / len * 0.6);
      if (d > best) { best = d; bestY = y; }
    }
    const rr = Math.min(arch === 'freighter' ? 5 : 3.5, Math.max(0.8, distAt(0, bestY) * 0.5));
    put(0, bestY, rr * 0.7, rr * 1.25, (i, k) => {
      f.mat[i] = MAT.GLASS;
      f.key[i] = PALETTE.glass;
      setAlbedo(f, i, lin(PALETTE.glass));
      f.height[i] = f.height[i]! + rr * 0.55 * Math.sqrt(Math.max(0, 1 - k));
    });
  } else {
    // A robot's core: a glowing ring.
    const rr = Math.max(1, maxDu * 0.35);
    const e = lin(kind.shape.kind === 'polygon' ? kind.shape.color : 0xff4060);
    put(0, 0, rr, rr, (i, k) => {
      if (k > 0.45 && k < 0.8) {
        f.mat[i] = MAT.LIGHT;
        f.emis[i * 3] = e[0] * 1.6; f.emis[i * 3 + 1] = e[1] * 1.6; f.emis[i * 3 + 2] = e[2] * 1.6;
        setAlbedo(f, i, e, 0.4);
      } else if (k <= 0.45) {
        f.mat[i] = MAT.GLASS;
        setAlbedo(f, i, lin(PALETTE.trim));
        f.height[i] = f.height[i]! + rr * 0.4;
      }
    });
  }

  if (opts.rings) for (const rg of opts.rings) stampTurretRing(f, rg.x, rg.y, rg.r);

  // Nozzles at the stern.
  if (arch !== 'robot' && !opts.scrap) {
    // Stern = the hull outline's rear extent (same rule as render/pixi/engineGeometry.ts).
    let stern = 0;
    for (const p of parts) for (const [, y] of p.pts) if (y > stern) stern = y;
    const prof = { sternOffset: stern > 0 ? stern : kind.radius };
    // A kind that authors `thrusters` (the capitals) gets that many nozzles of
    // that size; the 5 u cap below is a fighter-scale number, and on a 5,760 u
    // battleship it left the exhaust invisible (invariant #18).
    const t = kind.thrusters;
    const nr = t ? t.size / 2 : Math.min(5, Math.max(0.9, kind.radius * 0.16));
    const step = t ? Math.max(0.2, nr * 0.05) : 0.2;
    const halfAt = (y: number): number => {
      let h = 0;
      for (let x = 0; x < g.w / g.ppu / 2; x += step) if (distAt(x, y) > 0) h = x;
      return h;
    };
    // An authored bank of nozzles needs the hull wide enough to hold it side by
    // side; a tapered stern is too narrow at its tip, so step the line forward
    // (at most a quarter of the hull) until the bank fits.
    const want = t && t.count > 1 ? (t.count - 1) * nr * 1.2 + nr : 0;
    let ny = prof.sternOffset - nr * 0.9;
    let half = halfAt(ny);
    for (let k = 0; k < 40 && half < want && ny > prof.sternOffset * 0.5; k++) {
      ny -= nr * 0.5;
      half = halfAt(ny);
    }
    let xs: number[];
    if (t && t.count > 1) {
      // Evenly across the stern, inside the hull, nozzles not overlapping more than they must.
      const span = Math.max(0, Math.min(2 * half - 2 * nr, (t.count - 1) * nr * 2.4));
      xs = Array.from({ length: t.count }, (_, i) => -span / 2 + (span * i) / (t.count - 1));
    } else {
      xs = t ? [0] : half > nr * 3.2 ? [-half * 0.45, half * 0.45] : [0];
    }
    // A full-thrust flame is ~8.4 nozzle radii (engineFx flameShape): right for a
    // fighter, a sliver on a capital. Kinds with authored thrusters stretch it to
    // about an eighth of the hull length so the exhaust still reads zoomed out.
    const plume = t ? Math.max(1, (0.24 * kind.radius) / (8.4 * nr)) : 1;
    const eng = lin(PALETTE.engine);
    for (const nx of xs) {
      f.nozzles.push(plume > 1 ? { x: nx, y: ny + nr * 0.6, r: nr, len: plume } : { x: nx, y: ny + nr * 0.6, r: nr });
      putRect(nx, ny, nr, nr * 0.85, (i, bev) => {
        f.mat[i] = MAT.NOZZLE;
        f.key[i] = PALETTE.nozzle;
        setAlbedo(f, i, lin(bev < 0.35 ? PALETTE.metal : PALETTE.nozzle), bev < 0.35 ? 0.7 : 1);
        f.height[i] = f.height[i]! + (bev < 0.35 ? Hmax * 0.08 : -nr * 0.35);
      });
      put(nx, ny + nr * 0.25, nr * 0.5, nr * 0.45, (i, k) => {
        f.mat[i] = MAT.NOZZLE;
        const e = 1.4 * (1 - k * 0.6);
        f.emis[i * 3] = eng[0] * e; f.emis[i * 3 + 1] = eng[1] * e; f.emis[i * 3 + 2] = eng[2] * e;
      });
    }
  }

  // Nav lights at the widest points: port (x<0) red, starboard green.
  if (opts.scrap) return f; // dead: no running lights
  let wideX = 0, wideY = 0;
  for (let i = 0; i < n; i++) {
    if (f.cov[i]! < 0.5) continue;
    const wx = (i % g.w + 0.5 - g.ox) / g.ppu;
    if (wx > wideX) { wideX = wx; wideY = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu; }
  }
  const inset = Math.max(0.5, 1.5 / g.ppu);
  for (const [sx, col] of [[-1, PALETTE.navPort], [1, PALETTE.navStarboard]] as const) {
    const lx = sx * (wideX - inset);
    f.navLights.push({ x: lx, y: wideY, color: col });
    const e = lin(col);
    put(lx, wideY, Math.max(0.35, 0.8 / g.ppu), Math.max(0.35, 0.8 / g.ppu), (i) => {
      f.mat[i] = MAT.LIGHT;
      f.emis[i * 3] = e[0]; f.emis[i * 3 + 1] = e[1]; f.emis[i * 3 + 2] = e[2];
    });
  }
  return f;
}

/**
 * A scrap piece: one component of a destroyed ship, from the same recentred
 * sub-shapes the game's collider and `buildScrapGfx` use
 * (`shipScrapGroups(parent)[componentIndex]`, scaled by the parent's scale).
 * Plated like its ship, but with no canopy, engines or lights.
 */
export function forgeScrap(parentKindId: string, componentIndex: number, opts: { ppu: number }): Fields {
  const group = shipScrapGroups(parentKindId)[componentIndex];
  const scale = shipShapeScale(getShipKind(parentKindId));
  const parts = group
    ? group.parts.map((pt) => ({ pts: pt.points.map(([x, y]) => [x * scale, y * scale] as const), color: pt.color }))
    : [{ pts: [[-4, -4], [4, -4], [4, 4], [-4, 4]] as Poly, color: 0x777777 }];
  return forgeShip(parentKindId, { ppu: opts.ppu, parts, seedKey: `${parentKindId}#${componentIndex}`, scrap: true });
}

/** Rock base colours: plain, ice, crystal (the game's asteroid tints). */
export const ROCK_COLORS: Record<string, number> = { rock: 0x7a6248, ice: 0x8fb4c8, crystal: 0x8a6fb0 };

/**
 * An asteroid: the same seeded outline the server builds its collider from
 * (`generateAsteroidVertices`, drawn with y flipped like `buildAsteroidGfx`).
 * A rounded, lumpy body with craters; matte rock, no paint or lights.
 */
export function forgeRock(entityId: number, radius: number, resource: string | undefined, opts: { ppu: number }): Fields {
  const outline: Poly = generateAsteroidVertices(entityId, radius).map((v) => [v.x, -v.y] as const);
  const g = gridFor([outline], opts.ppu, 2);
  const base = ROCK_COLORS[resource ?? 'rock'] ?? ROCK_COLORS['rock']!;
  const f = newFields(g, base);
  const n = g.w * g.h;
  const cov = rasterPoly(g, outline);
  for (let i = 0; i < n; i++) f.cov[i] = cov[i]!;
  const dist = distanceInside(f.cov, g.w, g.h);
  let maxD = 0;
  for (let i = 0; i < n; i++) if (dist[i]! > maxD) maxD = dist[i]!;
  const maxDu = Math.max(0.5, maxD / g.ppu);
  const seed = hashStr(`rock:${entityId}`);
  const R = rng(seed);
  // A few craters, each a shallow bowl with a raised rim.
  const craters: Array<{ x: number; y: number; r: number }> = [];
  const nCr = 2 + Math.floor(R() * 4);
  for (let k = 0; k < nCr; k++) {
    const a = R() * Math.PI * 2, d = R() * radius * 0.55;
    craters.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: radius * (0.12 + R() * 0.18) });
  }
  const col = lin(base);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const t = Math.min(1, dist[i]! / g.ppu / maxDu);
      // Rounded dome, roughened by two octaves of noise.
      let h = maxDu * 0.6 * Math.sqrt(t * (2 - t));
      const nz = valueNoise(wx * 0.12, wy * 0.12, seed) * 0.6 + valueNoise(wx * 0.35, wy * 0.35, seed + 7) * 0.4;
      h += (nz - 0.5) * maxDu * 0.35 * t;
      let shade = 0.85 + 0.3 * nz;
      for (const c of craters) {
        const dd = Math.hypot(wx - c.x, wy - c.y) / c.r;
        if (dd < 1) { h -= (1 - dd * dd) * c.r * 0.35; shade *= 0.82 + 0.18 * dd; }
        else if (dd < 1.3) h += (1.3 - dd) * c.r * 0.25;
      }
      f.height[i] = h;
      f.mat[i] = MAT.ROCK;
      f.key[i] = base;
      setAlbedo(f, i, col, shade);
    }
  }
  return f;
}

/** Hash of an integer to 0..1. */
export function hash01(a: number, seed: number): number {
  let h = Math.imul(a ^ seed, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** Hashed value noise in 0..1 (smooth, cheap). */
function latticeHash(a: number, b: number, seed: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = latticeHash(xi, yi, seed), b = latticeHash(xi + 1, yi, seed);
  const c = latticeHash(xi, yi + 1, seed), d = latticeHash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export interface StructureForgeOpts {
  /** Texels per world unit, before the size cap. */
  ppu: number;
  /** Cap on the texture's longest side, texels (the resolution drops for big kinds). */
  maxSide?: number;
  seed?: number;
  /** Override the accent paint (owner faction). */
  accent?: number;
  /** Turret rings to cut into the deck (local world units, Pixi-up), R&D. */
  rings?: ReadonlyArray<{ x: number; y: number; r: number }>;
}

const DECK_HEX = 0x1d2433;
function sat(hex: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}
function lum(hex: number): number {
  const [r, g, b] = lin(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Build the field set for a structure from its existing draw plan. Each rect op
 * becomes a raised (or inset) block with a bevelled edge on top of whatever is
 * already there, so the plan's layering turns into real architecture:
 *  - the big first rect is the deck plate;
 *  - saturated colours are painted plating (the owner's accent);
 *  - glass / warm / translucent small rects are lit windows (inset, emissive);
 *  - thin rects are flat markings;
 *  - everything else is a steel block, taller the bigger it is.
 * Light ops become emissive lamps.
 */
export function forgeStructure(kindId: string, opts: StructureForgeOpts): Fields {
  const accent = opts.accent ?? (isStructureKindId(kindId) ? getStructureKind(kindId).color : 0x66ccaa);
  const plan = buildStructureVisual(kindId, { accent, seed: opts.seed ?? 1, omitSpans: true });
  const fp = plan.footprint;
  const box: Poly = [[-fp.w / 2, -fp.h / 2], [fp.w / 2, -fp.h / 2], [fp.w / 2, fp.h / 2], [-fp.w / 2, fp.h / 2]];
  const side = Math.max(fp.w, fp.h) + 4;
  const ppu = opts.maxSide ? Math.min(opts.ppu, opts.maxSide / side) : opts.ppu;
  const g = gridFor([box], ppu, 2);
  const f = newFields(g, paintOf(accent));
  const area = fp.w * fp.h;
  const noiseSeed = hashStr(kindId + ':grime');

  plan.rects.forEach((r, idx) => {
    if (r.w <= 0 || r.h <= 0) return;
    const thin = Math.min(r.w, r.h) <= 4;
    const big = r.w * r.h > area * 0.25;
    const bright = lum(r.color) > 0.35;
    const window = !big && !thin && (r.alpha < 0.92 || (bright && sat(r.color) > 0.25 && r.w * r.h < 900));
    const painted = !window && !thin && sat(r.color) > 0.35;
    let lift: number;
    let mat: number;
    if (idx === 0 || (big && r.color === DECK_HEX)) { lift = 3; mat = MAT.METAL; }
    else if (thin) { lift = 0; mat = MAT.PAINT; }
    else if (window) { lift = -0.8; mat = MAT.WINDOW; }
    else if (painted) { lift = Math.min(10, Math.max(2, Math.min(r.w, r.h) * 0.08)); mat = MAT.PAINT; }
    else { lift = Math.min(34, Math.max(2.5, Math.min(r.w, r.h) * 0.16)); mat = MAT.METAL; }
    // Roof dressing on big steel blocks: plate seams + a couple of vents.
    const dressed = mat === MAT.METAL && r.w * r.h > 1500 && Math.min(r.w, r.h) > 24;
    const seam = 24 + (idx % 3) * 6;
    const rv = rng(hashStr(kindId) + idx * 977);
    const vents = dressed ? Array.from({ length: 1 + Math.floor(rv() * 3) }, () => {
      const vw = 6 + rv() * Math.min(26, r.w * 0.2), vh = 6 + rv() * Math.min(26, r.h * 0.2);
      return { x: r.x + 6 + rv() * Math.max(1, r.w - vw - 12), y: r.y + 6 + rv() * Math.max(1, r.h - vh - 12), w: vw, h: vh };
    }) : [];
    const bwR = Math.max(0.5, Math.min(4, Math.min(r.w, r.h) * 0.18));
    const col = lin(r.color);
    const x0 = Math.max(0, Math.floor(r.x * g.ppu + g.ox)), x1 = Math.min(g.w - 1, Math.ceil((r.x + r.w) * g.ppu + g.ox));
    const y0 = Math.max(0, Math.floor(r.y * g.ppu + g.oy)), y1 = Math.min(g.h - 1, Math.ceil((r.y + r.h) * g.ppu + g.oy));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
        const ed = Math.min(wx - r.x, r.x + r.w - wx, wy - r.y, r.y + r.h - wy);
        if (ed < -0.5 / g.ppu) continue;
        const cov = Math.min(1, Math.max(0, ed * g.ppu + 0.5));
        const i = ty * g.w + tx;
        const t = Math.min(1, Math.max(0, ed / bwR));
        const bev = Math.sqrt(1 - (1 - t) * (1 - t));
        let hh = f.height[i]! + lift * bev;
        let kk = 1;
        if (dressed && ed > bwR) {
          const sx = (wx - r.x) % seam, sy = (wy - r.y) % seam;
          if (sx < 0.9 || sy < 0.9) { hh -= 0.4; kk = 0.62; }
          for (const v of vents) {
            const ve = Math.min(wx - v.x, v.x + v.w - wx, wy - v.y, v.y + v.h - wy);
            if (ve >= 0) { hh += 3 * Math.min(1, ve / 1.5); kk = ((Math.floor((wy - v.y) / 2) & 1) === 0 && ve > 1.5) ? 0.45 : 0.85; }
          }
        }
        f.height[i] = f.height[i]! * (1 - cov) + hh * cov;
        if (cov > 0.5) {
          f.mat[i] = mat;
          f.key[i] = r.color & 0xf0f0f0;
          const k = kk;
          f.albedo[i * 3] = col[0] * k; f.albedo[i * 3 + 1] = col[1] * k; f.albedo[i * 3 + 2] = col[2] * k;
          if (mat === MAT.WINDOW) {
            const e = r.alpha * 0.9;
            f.emis[i * 3] = col[0] * e; f.emis[i * 3 + 1] = col[1] * e; f.emis[i * 3 + 2] = col[2] * e;
          }
        }
        f.cov[i] = Math.max(f.cov[i]!, cov * Math.max(r.alpha, idx === 0 ? 1 : 0));
      }
    }
  });
  // Grime: one low-frequency noise pass over everything but windows.
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0 || f.mat[i] === MAT.WINDOW) continue;
      const nz = valueNoise(((tx + 0.5 - g.ox) / g.ppu) * 0.08, ((ty + 0.5 - g.oy) / g.ppu) * 0.08, noiseSeed);
      const k = 0.88 + 0.22 * nz;
      f.albedo[i * 3]! *= k; f.albedo[i * 3 + 1]! *= k; f.albedo[i * 3 + 2]! *= k;
    }
  }
  // Lamps.
  for (const l of plan.lights) {
    const e = lin(l.color);
    const rr = l.r * 0.7;
    for (let ty = Math.max(0, Math.floor((l.y - rr) * g.ppu + g.oy)); ty <= Math.min(g.h - 1, Math.ceil((l.y + rr) * g.ppu + g.oy)); ty++) {
      for (let tx = Math.max(0, Math.floor((l.x - rr) * g.ppu + g.ox)); tx <= Math.min(g.w - 1, Math.ceil((l.x + rr) * g.ppu + g.ox)); tx++) {
        const wx = (tx + 0.5 - g.ox) / g.ppu - l.x, wy = (ty + 0.5 - g.oy) / g.ppu - l.y;
        const k = Math.hypot(wx, wy) / rr;
        if (k > 1) continue;
        const i = ty * g.w + tx;
        f.mat[i] = MAT.LIGHT;
        const a = 1.4 * (1 - k * k);
        f.emis[i * 3] = e[0] * a; f.emis[i * 3 + 1] = e[1] * a; f.emis[i * 3 + 2] = e[2] * a;
      }
    }
    f.navLights.push({ x: l.x, y: l.y, color: l.color });
  }
  if (opts.rings) for (const rg of opts.rings) stampTurretRing(f, rg.x, rg.y, rg.r);
  return f;
}

/** Cavity term (0 = open, 1 = deep groove) from local height vs its blur. */
export function cavity(f: Fields, radiusU: number): Float32Array {
  const r = Math.max(1, Math.round(radiusU * f.g.ppu));
  const blur = boxBlur(f.height, f.g.w, f.g.h, r);
  const out = new Float32Array(f.height.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(1, (blur[i]! - f.height[i]!) / Math.max(0.5, radiusU * 0.6)));
  return out;
}

export { insidePoly, PROPOSED_FOOTPRINTS };

// ------------------------------------------------------------------ turrets (R&D)

/**
 * Cut a turret ring into a hull or deck at (cx, cy), radius r (world units):
 * a recessed dark seat the gun sits in, a raised worn collar, a groove, and a
 * lip that blends back into the plating. Lit and shadowed with the hull, so
 * the turret reads as built in rather than stuck on top.
 */
export function stampTurretRing(f: Fields, cx: number, cy: number, r: number): void {
  const g = f.g;
  const ctx = Math.round(cx * g.ppu + g.ox), cty = Math.round(cy * g.ppu + g.oy);
  const ci = Math.max(0, Math.min(g.h - 1, cty)) * g.w + Math.max(0, Math.min(g.w - 1, ctx));
  const base = f.height[ci] ?? 0;
  const R = r * 1.15;
  const x0 = Math.floor((cx - R) * g.ppu + g.ox), x1 = Math.ceil((cx + R) * g.ppu + g.ox);
  const y0 = Math.floor((cy - R) * g.ppu + g.oy), y1 = Math.ceil((cy + R) * g.ppu + g.oy);
  const trim = lin(PALETTE.trim), collar = lin(0x8a93a1);
  for (let ty = Math.max(0, y0); ty <= Math.min(g.h - 1, y1); ty++) {
    for (let tx = Math.max(0, x0); tx <= Math.min(g.w - 1, x1); tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! < 0.5) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu - cx, wy = (ty + 0.5 - g.oy) / g.ppu - cy;
      const k = Math.hypot(wx, wy) / r;
      if (k > 1.15) continue;
      if (k < 0.62) {
        f.height[i] = base - r * 0.12;
        f.mat[i] = MAT.TRIM; f.key[i] = PALETTE.trim; setAlbedo(f, i, trim, 0.85);
      } else if (k < 0.82) {
        const t = 1 - Math.abs((k - 0.72) / 0.1);
        f.height[i] = base + r * 0.22 * Math.sqrt(Math.max(0, t));
        f.mat[i] = MAT.METAL; f.key[i] = PALETTE.metal; setAlbedo(f, i, collar, 0.95);
      } else if (k < 0.9) {
        f.height[i] = base - r * 0.05;
        f.mat[i] = MAT.TRIM; f.key[i] = PALETTE.trim; setAlbedo(f, i, trim, 0.7);
      } else {
        // Lip: a soft rise that fades into the existing plating.
        f.height[i] = f.height[i]! + r * 0.08 * (1 - Math.abs(k - 1) / 0.15);
      }
    }
  }
}

export type GunFamily = 'bolt' | 'beam' | 'missile' | 'charge';

export interface TurretGunSpec {
  family: GunFamily;
  /** Hull paint (the cap is painted to match its ship or structure). */
  paint: number;
  /** Barrel length from the pivot to the tip, width, cap radius (world units). */
  len: number;
  wid: number;
  cap: number;
  ppu: number;
  /** Capital naval turret (capital-ship R&D): a faceted gunhouse centred on
   *  the pivot, `barrels` parallel barrels of `len` from its front face. */
  naval?: { barrels: number; houseW: number; houseL: number };
}

/**
 * A WW2-style naval turret seen from above (capital-ship R&D): a gunhouse
 * with an angled armoured face, flat sides and a rounded rear, roof plates,
 * rangefinder ears on the big ones, and N parallel barrels with blast-bag
 * collars at the face. Forward is −y, like `forgeTurretGun`.
 */
function forgeNavalTurret(spec: TurretGunSpec): Fields {
  const nv = spec.naval!;
  const W = nv.houseW, L = nv.houseL, hw = W / 2, hl = L / 2, bw = spec.wid / 2, len = spec.len;
  const face = hl * 0.42; // depth of the angled front faces
  const housePoly: Poly = [
    [-hw * 0.62, -hl], [hw * 0.62, -hl], [hw, -hl + face], [hw, hl * 0.7],
    [hw * 0.82, hl], [-hw * 0.82, hl], [-hw, hl * 0.7], [-hw, -hl + face],
  ];
  const n = Math.max(1, nv.barrels);
  const pitch = n > 1 ? (W * NAVAL_BARREL_SPAN) / (n - 1) : 0;
  const xs: number[] = [];
  for (let k = 0; k < n; k++) xs.push((k - (n - 1) / 2) * pitch);
  const barrelPolys: Poly[] = xs.map((x): Poly => [[x - bw, -hl - len], [x + bw, -hl - len], [x + bw, -hl + 0.5], [x - bw, -hl + 0.5]]);
  const polys = [housePoly, ...barrelPolys];
  const g = gridFor(polys, spec.ppu, 1.5);
  const f = newFields(g, paintOf(spec.paint));
  for (const poly of polys) { const c = rasterPoly(g, poly); for (let i = 0; i < c.length; i++) if (c[i]! > f.cov[i]!) f.cov[i] = c[i]!; }
  const paint = lin(f.paint), metal = lin(PALETTE.metal), worn = lin(PALETTE.metalWorn), trim = lin(PALETTE.trim), bore = lin(0x0b0c10);
  const Hh = Math.max(1.2, W * 0.18);
  const seed = hashStr('naval:' + n + ':' + Math.round(W));
  const big = W > 12;
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const nz = valueNoise(wx * 0.5, wy * 0.5, seed);
      let h = -1, mat: number = MAT.NONE, col = metal, kk = 1, key = PALETTE.metal;
      // Gunhouse: flat armoured roof, slight chamfer to the edges.
      const inHouse = wy >= -hl && wy <= hl && Math.abs(wx) <= hw;
      if (inHouse) {
        const edge = Math.min(hw - Math.abs(wx), wy + hl, hl - wy);
        h = Hh * (0.82 + 0.18 * Math.min(1, edge / Math.max(0.5, W * 0.06)));
        mat = MAT.PAINT; col = paint; key = f.paint; kk = 0.9 + 0.1 * nz;
        // Roof plate seams: one lengthwise pair and a cross seam.
        if (Math.abs(Math.abs(wx) - hw * 0.4) < Math.max(0.15, 0.5 / spec.ppu) || Math.abs(wy - hl * 0.1) < Math.max(0.15, 0.5 / spec.ppu)) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= Hh * 0.05; }
        // Rangefinder ears at the rear corners (big turrets only).
        if (big && wy > hl * 0.35 && wy < hl * 0.85 && Math.abs(wx) > hw * 0.72) { mat = MAT.METAL; col = worn; key = PALETTE.metal; h = Hh * 1.12; }
        // Hatch near the rear centre.
        if (Math.hypot(wx, wy - hl * 0.55) < W * 0.07) { mat = MAT.METAL; col = worn; key = PALETTE.metal; h = Hh * 0.98; }
      }
      // Barrels, over the house where they enter it.
      for (const x of xs) {
        const u = (wx - x) / bw;
        if (Math.abs(u) > 1 || wy > -hl + 0.5 || wy < -hl - len) continue;
        const v = (-hl - wy) / len; // 0 at the face .. 1 at the muzzle
        const cyl = Math.sqrt(Math.max(0, 1 - u * u));
        const bh = Hh * 0.7 + bw * cyl;
        if (bh > h) {
          h = bh; mat = MAT.METAL; col = metal; key = PALETTE.metal; kk = 0.95 + 0.08 * nz;
          if (v < 0.07) { col = worn; h += bw * 0.3; } // blast bag collar
          if (v > 0.97 && Math.abs(u) < 0.55) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h -= bw * 0.6; }
        }
      }
      if (h < 0) continue;
      f.height[i] = h; f.mat[i] = mat; f.key[i] = key;
      setAlbedo(f, i, col, kk);
    }
  }
  return f;
}

/**
 * The turning part of a turret, through the same fields as a hull: a painted
 * domed cap with a groove and a hub, and a bare-metal barrel pointing forward
 * (-y) with ring seams; per family a muzzle brake and bore (bolt), a lens
 * (beam), coils (charge) or a two-tube rack (missile). Light it with
 * litFrame at every sun step, like a ship, and pick the frame by the gun's
 * own world rotation.
 */
export function forgeTurretGun(spec: TurretGunSpec): Fields {
  if (spec.naval) return forgeNavalTurret(spec);
  const { family, len, wid, cap, ppu } = spec;
  const hw = wid / 2;
  const rack = family === 'missile';
  const capPts: Array<readonly [number, number]> = [];
  for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; capPts.push([Math.cos(a) * cap, Math.sin(a) * cap]); }
  const capPoly: Poly = capPts;
  const rackPoly: Poly = [[-cap, -cap * 0.75], [cap, -cap * 0.75], [cap, cap * 0.75], [-cap, cap * 0.75]];
  const brake = family === 'bolt' ? hw * 1.45 : family === 'beam' ? hw * 1.25 : hw;
  const tipFrac = family === 'bolt' ? 0.86 : family === 'beam' ? 0.8 : 1;
  const bodyPoly: Poly = [[-hw, -len * tipFrac], [hw, -len * tipFrac], [hw, 0], [-hw, 0]];
  const tipPoly: Poly = [[-brake, -len], [brake, -len], [brake, -len * tipFrac], [-brake, -len * tipFrac]];
  const polys = rack ? [rackPoly] : tipFrac < 1 ? [capPoly, bodyPoly, tipPoly] : [capPoly, bodyPoly];
  const g = gridFor(polys, ppu, 1.5);
  const f = newFields(g, paintOf(spec.paint));
  // Anti-aliased coverage from the same rasteriser as the hulls.
  for (const poly of polys) { const c = rasterPoly(g, poly); for (let i = 0; i < c.length; i++) if (c[i]! > f.cov[i]!) f.cov[i] = c[i]!; }
  const paint = lin(f.paint), metal = lin(PALETTE.metal), worn = lin(PALETTE.metalWorn), trim = lin(PALETTE.trim), glass = lin(PALETTE.glass);
  const bore = lin(0x0b0c10);
  const capH = cap * 0.55;
  const seed = hashStr('turret:' + family);
  const seam = len / Math.max(1, Math.round(len / Math.max(0.5, wid * 1.6)));
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const nz = valueNoise(wx * 0.6, wy * 0.6, seed);
      let h = -1, mat: number = MAT.NONE, col = metal, kk = 1, key = PALETTE.metal;
      // Cap (a disc, or the rack's box).
      const inCap = rack ? Math.abs(wx) <= cap && Math.abs(wy) <= cap * 0.75 : Math.hypot(wx, wy) <= cap;
      if (inCap) {
        const k = rack ? Math.max(Math.abs(wx) / cap, Math.abs(wy) / (cap * 0.75)) : Math.hypot(wx, wy) / cap;
        h = capH * (rack ? 0.8 + 0.2 * Math.sqrt(Math.max(0, 1 - k * k)) : Math.sqrt(Math.max(0, 1 - k * k)) * 0.7 + 0.3);
        mat = MAT.PAINT; col = paint; key = f.paint; kk = 0.92 + 0.1 * nz;
        if (!rack && Math.abs(k - 0.74) < 0.06) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= capH * 0.08; }
        if (!rack && k < 0.3) { mat = MAT.METAL; col = worn; key = PALETTE.metal; h += capH * 0.1; }
        if (rack) {
          // Two launch tubes: dark round mouths in metal sleeves.
          for (const sx of [-cap * 0.48, cap * 0.48]) {
            const d = Math.hypot(wx - sx, wy + cap * 0.1) / (cap * 0.36);
            if (d < 1) {
              const mouth = d < 0.62;
              mat = mouth ? MAT.NOZZLE : MAT.METAL; col = mouth ? bore : worn; key = mouth ? PALETTE.nozzle : PALETTE.metal;
              h = capH * (mouth ? 0.4 : 1.05);
            }
          }
        }
      }
      // Barrel (over the cap where they overlap).
      if (!rack && wy <= 0 && wy >= -len) {
        const v = -wy / len; // 0 pivot .. 1 tip
        const half = v > tipFrac ? brake : hw;
        const u = wx / half;
        if (Math.abs(u) <= 1) {
          const cyl = Math.sqrt(Math.max(0, 1 - u * u));
          const bh = capH * 0.75 + half * cyl;
          if (bh > h) {
            h = bh; mat = MAT.METAL; col = metal; key = PALETTE.metal; kk = 0.95 + 0.08 * nz;
            if (v < 0.86 && Math.abs(((len * v) % seam) - seam * 0.5) < Math.max(0.18, 0.6 / ppu)) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= 0.08 * half; }
            if (family === 'bolt' && v > 0.86) {
              col = worn;
              if (v > 0.965 && Math.abs(u) < 0.55) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h -= half * 0.6; }
            }
            if (family === 'beam' && v > 0.8) { mat = MAT.GLASS; col = glass; key = PALETTE.glass; }
            if (family === 'charge' && v > 0.25 && Math.sin(v * len * 3.2) > 0.45) col = worn;
            if (family === 'charge' && v > 0.9) { mat = MAT.GLASS; col = glass; key = PALETTE.glass; }
          }
        }
      }
      if (h < 0 || f.cov[i]! <= 0) continue;
      f.height[i] = h; f.mat[i] = mat; f.key[i] = key;
      setAlbedo(f, i, col, kk);
    }
  }
  return f;
}
