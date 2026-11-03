/**
 * Art lab forge — surface fields for ships and structures.
 *
 * A "field set" is everything the light pass needs, baked once per kind from
 * data the game already has: the catalogue polygon / composite parts for a
 * ship, the `structureVisuals` draw plan for a structure. Nothing is drawn by
 * hand, so a new kind gets art for free; `HINTS` only nudges the recipe.
 *
 * Local space is Pixi-up (ship nose at -y). Heights are in WORLD units.
 */
import { getShipKind, type ShipKind } from '../../../shared-types/shipKinds.js';
import { buildStructureVisual, PROPOSED_FOOTPRINTS } from '../../render/pixi/structureVisuals.js';
import { getStructureKind, isStructureKindId } from '../../../shared-types/structureKinds.js';
import { boxBlur, distanceInside, gridFor, hashStr, insidePoly, rasterPoly, rng, type Grid, type Poly } from './raster.js';

export const MAT = {
  NONE: 0,
  METAL: 1,
  PAINT: 2,
  TRIM: 3,
  GLASS: 4,
  NOZZLE: 5,
  LIGHT: 6,
  WINDOW: 7,
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
  nozzles: Array<{ x: number; y: number; r: number }>;
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

export interface ShipForgeOpts {
  /** Texels per world unit. */
  ppu: number;
  /** Override the paint (faction colour). Default: the catalogue colour. */
  paint?: number;
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
  const parts = shipParts(kind);
  const g = gridFor(parts.map((p) => p.pts), opts.ppu, 3);
  const basePaint = opts.paint ?? parts[0]!.color;
  const f = newFields(g, paintOf(basePaint));
  const n = g.w * g.h;
  const R = rng(hashStr(kind.id));

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
  const spacing = Math.min(14, Math.max(2.2, maxDu * 0.42));
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
  const noiseSeed = hashStr(kind.id + ':grime');
  const panelSeed = hashStr(kind.id + ':panels');

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

  // Canopy on the forward spine (not robots).
  if (arch !== 'robot') {
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

  // Nozzles at the stern.
  if (arch !== 'robot') {
    // Stern = the hull outline's rear extent (same rule as render/pixi/engineGeometry.ts).
    let stern = 0;
    for (const p of parts) for (const [, y] of p.pts) if (y > stern) stern = y;
    const prof = { sternOffset: stern > 0 ? stern : kind.radius };
    const nr = Math.min(5, Math.max(0.9, kind.radius * 0.16));
    const ny = prof.sternOffset - nr * 0.9;
    // Half-width of the hull at the nozzle line.
    let half = 0;
    for (let x = 0; x < g.w / g.ppu / 2; x += 0.2) if (distAt(x, ny) > 0) half = x;
    const xs = half > nr * 3.2 ? [-half * 0.45, half * 0.45] : [0];
    const eng = lin(PALETTE.engine);
    for (const nx of xs) {
      f.nozzles.push({ x: nx, y: ny + nr * 0.6, r: nr });
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
