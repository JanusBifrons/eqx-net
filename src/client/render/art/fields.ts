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
import { planBowFeatures, type BowFeature } from './bowDetail.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { largestClearCircle, sigilChevron, sigilCoverage, sigilDesign } from './sigil.js';

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
  /** Owner-faction enamel on a liveried hull (written only via `paintLivery`). */
  LIVERY: 9,
} as const;

/** Which spot treatment a livery uses. 'b2' / 'b3': treatment 'b''s spots
 *  with a shade experiment (`LIVERY_SHADES`). 'b4': B3's sub-cap shade and
 *  B2's capital paint on a new layout (`forgeShip`, "Treatment 'b4'"). */
export type LiveryTreatment = 'a' | 'b' | 'c' | 'b2' | 'b3' | 'b4';
/** A ship livery: grey hull, the owner's colours only in chosen spots. */
export interface Livery {
  treatment: LiveryTreatment;
  /** Team colour, sRGB hex. */
  team: number;
  /** Sigil seed (per faction): picks the emblem `sigilDesign` draws in
   *  treatment 'c' (in the team colour). */
  sigil: number;
}

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
  /** Hull vent slits drawn (centre + half extents, local world units; ships). */
  vents?: Array<{ x: number; y: number; hw: number; hh: number }>;
  /** Capital bow fittings stamped into the hull (bowDetail.ts; ships). */
  bow?: BowFeature[];
  /** The livery this set was forged with (ships; absent = catalogue paint). */
  livery?: Livery;
  /** Treatment 'c' emblems stamped (centre + radius, local world units). */
  sigils?: Array<{ x: number; y: number; r: number; kind: 'sigil' | 'chevron' }>;
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

/** Pull a colour toward its channel mean by `s`, then darken by `d`. */
function muted(hex: number, s: number, d: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const grey = (r + g + b) / 3;
  const m = (c: number): number => Math.round(Math.max(0, Math.min(255, (grey + (c - grey) * s) * d)));
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

/** Soften a catalogue colour into a paint: less neon, a touch darker. */
export function paintOf(hex: number): number {
  return muted(hex, 0.78, 0.86);
}

/** A livery's team colour as enamel: only lightly muted, still strong. */
export function liveryPaint(hex: number): number {
  return muted(hex, 0.92, 0.95);
}

/** Livery grey: HSL lightness core band (the capitals' hull and deck greys). */
const LIV_L_LO = 0.38, LIV_L_HI = 0.55;
/** Soft shoulders outside the band: darker / lighter parts approach
 *  LO - 0.35 / HI + 0.14 asymptotically, so order is kept and the capitals'
 *  dark stacks and pale upper decks barely move. */
const LIV_L_SOFT_LO = 0.35, LIV_L_SOFT_HI = 0.14;
/** Saturation: kept up to the knee, soft-capped toward the ceiling (the
 *  capitals' bluish hull grey, s 0.17, lands ~0.13); loud colours (s >= 0.6)
 *  settle at 0.10, a trace of their hue. */
const LIV_S_KNEE = 0.1, LIV_S_CEIL = 0.14, LIV_S_LOUD = 0.1;

/**
 * Catalogue colour -> livery hull grey. Hue is kept as a trace (saturation
 * soft-capped ~0.10); HSL lightness is identity inside the capitals' hull band
 * (0.38-0.55) with soft, monotone shoulders outside it, so a dark part stays
 * darker than a light one. The capitals' catalogue greys move by at most ~2.7
 * CIE76 dE (fields.livery.test.ts); a neon sub-cap colour becomes a grey with
 * a hint of its hue at about its own lightness.
 */
export function liveryGrey(hex: number, shiftL = 0, maxS = 1): number {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const dl = mx - mn;
  let h = 0, s = 0;
  if (dl > 0) {
    s = l > 0.5 ? dl / (2 - mx - mn) : dl / (mx + mn);
    h = (mx === r ? (g - b) / dl + (g < b ? 6 : 0) : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4) / 6;
  }
  let s2 = s <= LIV_S_KNEE ? s : LIV_S_KNEE + (LIV_S_CEIL - LIV_S_KNEE) * Math.tanh((s - LIV_S_KNEE) / (LIV_S_CEIL - LIV_S_KNEE));
  const loud = Math.min(1, Math.max(0, (s - 0.25) / 0.35));
  s2 -= (s2 - LIV_S_LOUD) * loud * loud * (3 - 2 * loud);
  if (s2 > maxS) s2 = maxS;
  let l2 = l < LIV_L_LO ? LIV_L_LO - LIV_L_SOFT_LO * Math.tanh((LIV_L_LO - l) / LIV_L_SOFT_LO)
    : l > LIV_L_HI ? LIV_L_HI + LIV_L_SOFT_HI * Math.tanh((l - LIV_L_HI) / LIV_L_SOFT_HI)
      : l;
  if (shiftL !== 0) l2 = Math.max(0.04, Math.min(0.96, l2 + shiftL));
  const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2, p = 2 * l2 - q;
  const ch = (t: number): number => {
    t = ((t % 1) + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return (ch(h + 1 / 3) << 16) | (ch(h) << 8) | ch(h - 1 / 3);
}

/**
 * Shade experiments on treatment 'b' (owner, 2026-11-15: capital paint "looks
 * additive", sub-cap hull too bright and team colour too dull). Sub-caps: the
 * hull grey drops `hullDl` in HSL lightness, its hue trace capped at `hullS`
 * saturation (a neutral grey), and the team paint is `muted(team,
 * teamS, teamD)`. Capitals: the team paint is a naval tone at about the hull's
 * own value (`muted(team, capS, capD)`), the bow/stern fade is a weathered
 * gradient, and every livery texel is mottled and sun-faded, with chips of
 * bare metal (`weatherLivery`). Running lights stay the bright team colour.
 */
export interface LiveryShade { hullDl: number; hullS: number; teamS: number; teamD: number; capS: number; capD: number }
export const LIVERY_SHADES: Readonly<Record<'b2' | 'b3' | 'b4', LiveryShade>> = {
  b2: { hullDl: -0.12, hullS: 0.04, teamS: 1.15, teamD: 1.0, capS: 0.72, capD: 0.74 },
  b3: { hullDl: -0.2, hullS: 0.03, teamS: 1.3, teamD: 1.0, capS: 0.62, capD: 0.6 },
  b4: { hullDl: -0.2, hullS: 0.03, teamS: 1.0, teamD: 0.88, capS: 0.5, capD: 0.74 },
};
/** The shade experiment a livery uses, or undefined (plain treatment). */
export function liveryShade(l: Livery | undefined): LiveryShade | undefined {
  return l && (l.treatment === 'b2' || l.treatment === 'b3' || l.treatment === 'b4') ? LIVERY_SHADES[l.treatment] : undefined;
}
/** A liveried hull's grey for this kind (a shade experiment darkens sub-caps). */
export function liveryHullGrey(hex: number, l: Livery | undefined, kindId: string): number {
  const sh = liveryShade(l);
  const sub = sh !== undefined && sizeClassOf(getShipKind(kindId)) !== 'capital';
  return sub ? liveryGrey(hex, sh.hullDl, sh.hullS) : liveryGrey(hex);
}
/** The team paint a livery lays on this size class. */
function liveryTeamPaint(l: Livery, capital: boolean): number {
  const sh = liveryShade(l);
  if (!sh) return liveryPaint(l.team);
  return capital ? muted(l.team, sh.capS, sh.capD) : muted(l.team, sh.teamS, sh.teamD);
}

/** Paint one texel in a livery's team enamel (for the spot treatments). */
export function paintLivery(f: Fields, i: number, team: number, k = 1): void {
  paintEnamel(f, i, liveryPaint(team), k);
}

/** Paint one texel in a livery enamel of this exact colour (a faded step). */
function paintEnamel(f: Fields, i: number, c: number, k: number): void {
  f.mat[i] = MAT.LIVERY;
  f.key[i] = c;
  setAlbedo(f, i, lin(c), k);
}

/** sRGB mix of two colours, t = 0 -> a, 1 -> b. */
function mixHex(a: number, b: number, t: number): number {
  const m = (s: number): number => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** Treatment 'b' fade: team colour stepped to grey in 3 discrete steps
 *  (1, 2/3, 1/3 of the team colour) over bow fraction [t0, t1); -1 past it. */
function fadeStep(team: number, grey: number, tb: number, t0: number, t1: number): number {
  if (tb >= t1) return -1;
  const s = tb < t0 ? 0 : Math.min(2, Math.floor(((tb - t0) / (t1 - t0)) * 3));
  return s === 0 ? team : mixHex(team, grey, s / 3);
}

/** World-space part polygons for a ship kind (same transform as the game). */
export function shipParts(kind: ShipKind): Array<{ pts: Poly; color: number; role?: string }> {
  const s = kind.shape.scale;
  if (kind.shape.kind === 'polygon') {
    return [{ pts: kind.shape.points.map(([x, y]) => [x * s, y * s] as const), color: kind.shape.color }];
  }
  return kind.shape.parts.map((p) => ({
    pts: p.points.map(([x, y]) => [(x + p.offsetX) * s, (y + p.offsetY) * s] as const),
    color: p.color,
    ...(p.role !== undefined ? { role: p.role } : {}),
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
  /** Override the paint (faction colour). Default: the catalogue colour.
   *  Ignored when `livery` is set. */
  paint?: number;
  /** Livery: every part colour becomes its `liveryGrey`; the team colour is
   *  kept for spot treatments (and a robot's core ring). Overrides `paint`. */
  livery?: Livery;
  /** Forge these parts instead of the kind's hull (a scrap component). */
  parts?: Array<{ pts: Poly; color: number }>;
  /** Seed text for the plating (default: the kind id). */
  seedKey?: string;
  /** A dead piece: no canopy, engines or running lights. */
  scrap?: boolean;
  /** Turret rings to cut into the hull (local world units, Pixi-up), R&D. */
  rings?: ReadonlyArray<{ x: number; y: number; r: number }>;
  /** Where the kind's turret bases sit and how far they reach (pivot +
   *  reach, local world units): livery 'b4' keeps paint off what a turret
   *  hides. From `turretLayout.shipTurrets` (bake.ts). */
  turretCover?: ReadonlyArray<{ x: number; y: number; reach: number }>;
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
  const livery = opts.livery;
  const basePaint = livery ? liveryHullGrey(parts[0]!.color, livery, kindId) : opts.paint ?? parts[0]!.color;
  const f = newFields(g, paintOf(basePaint));
  if (livery) f.livery = livery;
  const n = g.w * g.h;
  const seedKey = opts.seedKey ?? kind.id;
  const R = rng(hashStr(seedKey));

  // Union coverage + per-part layer index (top-most part wins).
  const layer = new Int8Array(n).fill(-1);
  const partCols: number[] = [];
  parts.forEach((p, idx) => {
    const c = rasterPoly(g, p.pts);
    partCols.push(livery ? liveryHullGrey(p.color, livery, kindId) : p.color);
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

  // Livery treatment 'a' (rim / edge band): the team colour runs along the
  // outer edge, everything inside stays grey. Frigates and cruisers add a thin
  // pinstripe inside the rim; capitals carry a narrower rim on the hull part
  // only (deck and superstructure stay grey). Never under 2 texels wide.
  // `dist` counts whole texels to the nearest outside centre (a full edge
  // texel is 1), so < 2.5 texels keeps two full texels plus the AA edge.
  const minLiv = 2.5 / g.ppu;
  const sizeCls = sizeClassOf(kind);
  const rimA = livery?.treatment === 'a';
  const rimW0 = Math.max(minLiv, Math.min(0.22 * maxDu, bw * 1.1));
  const rimW = sizeCls === 'capital' ? Math.max(minLiv, Math.min(rimW0, 0.05 * maxDu)) : rimW0;
  const pin = sizeCls === 'frigate' || sizeCls === 'cruiser';
  const pinLo = 1.6 * rimW, pinHi = pinLo + Math.max(0.3 * rimW, minLiv);
  const hullRole = parts.findIndex((p) => (p as { role?: string }).role === 'hull');
  const hullLayer = hullRole >= 0 ? hullRole : 0;
  const onHullLayer = (i: number): boolean => parts.length <= 1 || layer[i] === hullLayer || layer[i] === -1;

  // Livery treatment 'b' (nose, tips and fade): the team colour on the
  // extremities, like a squadron's painted noses and wingtips. Sub-caps paint
  // the nose cone (bow fraction < NOSE_B) and the wingtips (the outer
  // 1 - TIP_B of each wide row); frigates and cruisers also fade their outer
  // two paint bands to grey behind the nose in 3 discrete steps (the key
  // drives the pixel-look ramps, so only 3 keys); capitals fade the bow and,
  // mirrored, the stern of the hull layer only (the same 3 keys, so both ends
  // match; the nozzles are stamped over the stern). Robots get only the tips. Plus a tail beacon (sub-caps)
  // or team running lights (capitals), stamped after the nozzles.
  const shade = liveryShade(livery);
  const treatB = livery?.treatment === 'b' || shade !== undefined;
  const teamHex = livery ? liveryTeamPaint(livery, sizeCls === 'capital') : 0;
  /** Lamps glow in the plain team colour whatever the paint's shade. */
  const lampHex = livery ? liveryPaint(livery.team) : 0;
  const fadeSeed = hashStr(seedKey + ':fade');
  const CAP_FADE_B = 0.35, NOSE_B = 0.22, TIP_B = 0.72, WIDE_ROW_B = 0.6, WING_OVER_MEDIAN = 1.2, ROBOT_TIP_B = 0.86;
  const halfRow = new Float32Array(treatB ? g.h : 0);
  let maxHalf = 0, maxRad = 0, wingRow = 0;
  if (treatB) {
    for (let i = 0; i < n; i++) {
      if (f.cov[i]! <= 0.5) continue;
      const ty = Math.floor(i / g.w);
      const wx = Math.abs((i % g.w + 0.5 - g.ox) / g.ppu), wy = (ty + 0.5 - g.oy) / g.ppu;
      if (wx > halfRow[ty]!) halfRow[ty] = wx;
      maxHalf = Math.max(maxHalf, wx);
      maxRad = Math.max(maxRad, Math.hypot(wx, wy));
    }
    // A wing is a row clearly wider than the hull's typical (median) row: a
    // slab-sided frigate has none, and a rim down its flank is treatment 'a'.
    const rows = Array.from(halfRow).filter((h) => h > 0).sort((a, b) => a - b);
    wingRow = Math.max(WIDE_ROW_B * maxHalf, WING_OVER_MEDIAN * (rows[rows.length >> 1] ?? 0));
  }

  // Treatment 'b4' (owner, 2026-11-15: "capitals are key... sections of the
  // hull which are more distinct... important it's weathered"; small ships
  // must keep visible colour when turrets are fitted).
  //  - Capitals: solid painted sections across hull AND deck at the bow
  //    (bow fraction < CAP_BOW4) and stern (> 1 - CAP_STERN4), broken
  //    mirror-symmetric edges, weathered (weatherLivery 'patch'), and TINTED:
  //    each texel takes the hull's own tone there (band, panel, metal) at
  //    B4_VALUE of it, so the paint shades like the hull. Superstructure
  //    stays grey. No edge outline, no stripe (it showed between the guns).
  //  - Sub-caps: B's spots, but none under a turret's reach (it only showed
  //    as a lopsided sliver); a hull whose visible spots are under
  //    TAIL_NEED4 of its area wears worn tail flashes on its rear corners
  //    INSTEAD of those spots.
  const b4 = livery?.treatment === 'b4';
  const CAP_BOW4 = 0.2, CAP_STERN4 = 0.085, EDGE_JIT4 = 0.018, TAIL_T4 = 0.66, TAIL_NEED4 = 0.05, B4_VALUE = 0.78;
  const paintLum = (() => { const p = lin(f.paint); return Math.max(1e-4, 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]); })();
  const cover = b4 ? opts.turretCover ?? [] : [];
  const underTurret = (wx: number, wy: number): boolean => {
    for (const c of cover) { const dx = wx - c.x, dy = wy - c.y; if (dx * dx + dy * dy < c.reach * c.reach) return true; }
    return false;
  };
  const roleOf = (i: number): string | undefined => (parts[layer[i]!] as { role?: string } | undefined)?.role;
  const edgeSeed = hashStr(seedKey + ':b4edge');
  let tailFlash = false;
  const tailW = Math.max(minLiv * 1.5, 0.24 * maxDu);
  /** A wingtip texel: in a wing row, outside TIP_B of the half-span and of
   *  that row's half-width (never a band under 2 texels). Robots: only their
   *  outermost corners, port and starboard. */
  const tipAt = (wx: number, wy: number, ty: number): boolean => {
    const hr = halfRow[ty]!;
    const ax = Math.abs(wx);
    if (arch === 'robot') return ax >= Math.min(TIP_B * maxHalf, maxHalf - minLiv) && Math.hypot(wx, wy) > Math.min(ROBOT_TIP_B * maxRad, maxRad - minLiv);
    if (hr < wingRow) return false;
    // Outside TIP_B of the hull's whole half-span (true tips, not a rim down
    // the side) and of this row's own half-width.
    const span = Math.min(TIP_B * maxHalf, maxHalf - minLiv);
    if (ax < span || hr - span < minLiv) return false; // no 1-texel sliver where a tip starts
    return ax >= hr - Math.max((1 - TIP_B) * hr, minLiv);
  };

  if (b4 && sizeCls !== 'capital' && arch !== 'robot') {
    // Visible share of B's spots once the turrets are fitted.
    let vis = 0, hull = 0;
    for (let i = 0; i < n; i++) {
      if (f.cov[i]! <= 0.5) continue;
      hull++;
      const ty = Math.floor(i / g.w);
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const tb = (wy - yMin) / len, du = dist[i]! / g.ppu;
      const spot = tb < NOSE_B || tipAt(wx, wy, ty) || (pin && du < 2 * spacing && tb < 0.4);
      if (spot && !underTurret(wx, wy)) vis++;
    }
    tailFlash = vis < TAIL_NEED4 * hull;
  }

  /** The livery colour of this texel, or -1 for none (grey). */
  const liveryHexAt = (du: number, i: number, wx: number, wy: number, ty: number): number => {
    if (rimA) {
      if (sizeCls === 'capital') return du < rimW && onHullLayer(i) ? teamHex : -1;
      return du < rimW || (pin && du >= pinLo && du < pinHi && pinHi < maxDu * 0.8) ? teamHex : -1;
    }
    if (!treatB) return -1;
    const tb = (wy - yMin) / len;
    if (b4 && sizeCls === 'capital') {
      const role = roleOf(i);
      if (role !== undefined && role !== 'hull' && role !== 'deck') return -1;
      // A grey barbette ring round each turret base. (Deck sigils keep B's
      // places: the owner wants two on every capital, and deck markings under
      // the guns are what real warships carry.)
      if (underTurret(wx, wy)) return -1;
      const jit = EDGE_JIT4 * (valueNoise((Math.abs(wx) / len) * 40, (wy / len) * 40, edgeSeed) - 0.5) * 2; // mirror-symmetric
      if (tb < CAP_BOW4 + jit || tb > 1 - CAP_STERN4 + jit) return teamHex;
      return -1;
    }
    if (b4 && arch !== 'robot') {
      if (underTurret(wx, wy)) return -1;
      // A broken, worn edge on the flash (mirror-symmetric).
      if (tailFlash && tb > TAIL_T4 && du < tailW * (0.75 + 0.5 * valueNoise(Math.abs(wx) * 0.9, wy * 0.9, edgeSeed))) return teamHex;
      // A hull that needs flashes shows them alone: what is left of its
      // turret-hidden spots would only peek out as slivers.
      if (tailFlash) return -1;
    }
    if (sizeCls === 'capital') {
      if (!onHullLayer(i)) return -1;
      if (shade) {
        // A weathered gradient: full at the ends, thinning in uneven patches
        // toward grey, the far edge broken up rather than a straight line.
        const p = Math.max(1 - tb / CAP_FADE_B, 1 - (1 - tb) / CAP_FADE_B);
        if (p <= 0) return -1;
        const q = p + 0.45 * (valueNoise((wx / len) * 14, (wy / len) * 14, fadeSeed) - 0.5);
        if (q < 0.15) return -1;
        return mixHex(teamHex, f.paint, Math.min(0.85, Math.pow(1 - Math.min(1, q), 1.6)));
      }
      const bow = fadeStep(teamHex, f.paint, tb, 0, CAP_FADE_B);
      return bow >= 0 ? bow : fadeStep(teamHex, f.paint, 1 - tb, 0, CAP_FADE_B);
    }
    if (arch !== 'robot' && tb < NOSE_B) return teamHex;
    if (tipAt(wx, wy, ty)) return teamHex;
    if (pin && du < 2 * spacing) return fadeStep(teamHex, f.paint, tb, 0.15, 0.4);
    return -1;
  };

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
      const livHex = livery && !inGroove ? liveryHexAt(du, i, wx, wy, ty) : -1;
      if (inGroove) {
        setAlbedo(f, i, surf, 0.38);
        mat = MAT.TRIM;
        h -= Math.min(0.3, Hmax * 0.05);
      } else if (livHex >= 0) {
        // 'b4': tinted, so the paint carries the hull's tone here.
        const tone = b4 ? B4_VALUE * Math.min(1.15, Math.max(0.6, (0.2126 * surf[0]! + 0.7152 * surf[1]! + 0.0722 * surf[2]!) / paintLum)) : 1;
        paintEnamel(f, i, livHex, pv * (0.95 + 0.08 * nz) * tone);
        mat = MAT.LIVERY;
      } else {
        setAlbedo(f, i, surf, pv * (0.95 + 0.08 * nz));
      }
      f.height[i] = h;
      f.mat[i] = mat;
    }
  }

  // Livery treatment 'c' (grey, small accents + faction sigil): a team ring
  // round the canopy, team collars on the nozzles, and the faction's emblem
  // on the largest clear flat area (the deck, fore and aft, on capitals),
  // or a dorsal chevron where no area is big enough. A capital carries its
  // two deck emblems under every treatment. The plated height field is kept:
  // any texel a later fitting changes is no place for an emblem.
  const treatC = livery?.treatment === 'c' && !opts.scrap;
  const sigilsOn = treatC || (!!livery && !opts.scrap && sizeCls === 'capital');
  const hBase = sigilsOn ? f.height.slice() : undefined;

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
      // Never against a turret ring: on a capital a slit is one texel thick
      // and ~110 u long, and running out of a ring it reads as a rod behind
      // the gun (showcase review #376, the battleship's AA tubs).
      if (opts.rings && slitHitsRing(opts.rings, vx, vy, slitW, slitH * 0.5)) continue;
      for (const sx of [vx, -vx]) {
        (f.vents ??= []).push({ x: sx, y: vy, hw: slitW, hh: slitH * 0.5 });
        putRect(sx, vy, slitW, slitH * 0.5, (i) => {
          f.mat[i] = MAT.TRIM;
          f.key[i] = PALETTE.metal;
          setAlbedo(f, i, lin(PALETTE.trim));
          f.height[i] = f.height[i]! - 0.2;
        });
      }
    }
  }

  // Capital bows: anchor gear, breakwater, deck fittings, seams and a forward
  // director, planned from the hull and its turrets (bowDetail.ts). Stamped
  // before the turret rings, which cut cleanly through anything they meet.
  if (!opts.parts && !opts.scrap && kind.sizeClass === 'capital') {
    const plan = planBowFeatures(kind.id, parts);
    if (plan.features.length > 0) {
      f.bow = plan.features;
      stampBowFeatures(f, plan.features, plan.beam);
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
    if (treatC && livery) {
      // A thin team ring round the canopy: ellipse scale 1 .. 1.35, never
      // under ~2 texels across.
      const s = Math.max(1.35, 1 + 2.2 / (rr * 0.7 * g.ppu));
      put(0, bestY, rr * 0.7 * s, rr * 1.25 * s, (i, k) => {
        const m = f.mat[i];
        if (k * s * s <= 1 || m === MAT.GLASS || m === MAT.LIGHT || m === MAT.NOZZLE) return;
        paintLivery(f, i, livery.team);
      });
    }
  } else {
    // A robot's core: a glowing ring.
    const rr = Math.max(1, maxDu * 0.35);
    const e = lin(livery ? liveryPaint(livery.team) : kind.shape.kind === 'polygon' ? kind.shape.color : 0xff4060);
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

  // Nozzles at the stern. `sternLine`: the front edge of the nozzle bank (the
  // tail beacon sits ahead of it).
  let sternLine = yMax;
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
    sternLine = ny - nr * 0.85;
    // Treatment 'c': the nozzle's bevel ring is a team collar, widened to
    // about 2 texels where the bevel is thinner (putRect's bevel width).
    const collarBev = treatC ? Math.max(0.35, Math.min(0.6, 2.2 / (g.ppu * Math.max(0.25, nr * 0.85 * 0.5)))) : 0;
    for (const nx of xs) {
      f.nozzles.push(plume > 1 ? { x: nx, y: ny + nr * 0.6, r: nr, len: plume } : { x: nx, y: ny + nr * 0.6, r: nr });
      putRect(nx, ny, nr, nr * 0.85, (i, bev) => {
        if (livery && bev < collarBev) {
          paintLivery(f, i, livery.team, 0.85);
          f.height[i] = f.height[i]! + Hmax * 0.08;
          return;
        }
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

  if (sigilsOn && livery && hBase) {
    const deck = sizeCls === 'capital' ? parts.findIndex((p) => (p as { role?: string }).role === 'deck') : -1;
    stampSigils(f, livery, hBase, deck >= 0 ? (i) => layer[i] === deck : null, yMin, len, teamHex);
  }
  if (shade) weatherLivery(f, dist, hashStr(seedKey + ':wear'), sizeCls === 'capital', b4);

  // Nav lights at the widest points: port (x<0) red, starboard green.
  if (opts.scrap) return f; // dead: no running lights
  let wideX = 0, wideY = 0;
  for (let i = 0; i < n; i++) {
    if (f.cov[i]! < 0.5) continue;
    const wx = (i % g.w + 0.5 - g.ox) / g.ppu;
    if (wx > wideX) { wideX = wx; wideY = (Math.floor(i / g.w) + 0.5 - g.oy) / g.ppu; }
  }
  const inset = Math.max(0.5, 1.5 / g.ppu);
  const lampR = Math.max(0.35, 0.8 / g.ppu);
  const lamp = (lx: number, ly: number, col: number): void => {
    f.navLights.push({ x: lx, y: ly, color: col });
    const e = lin(col);
    put(lx, ly, lampR, lampR, (i) => {
      f.mat[i] = MAT.LIGHT;
      f.emis[i * 3] = e[0]; f.emis[i * 3 + 1] = e[1]; f.emis[i * 3 + 2] = e[2];
    });
  };
  for (const [sx, col] of [[-1, PALETTE.navPort], [1, PALETTE.navStarboard]] as const) lamp(sx * (wideX - inset), wideY, col);

  if (treatB && livery) {
    if (sizeCls !== 'capital') {
      // Tail beacon: on the centreline, just ahead of the nozzles (a robot:
      // just inside its rear edge), where the hull is deep enough to hold it.
      const step = 0.5 / g.ppu;
      for (let by = sternLine - lampR * 2; by > yMin + len * 0.5; by -= step) {
        if (distAt(0, by) >= lampR * 2) { lamp(0, by, lampHex); break; }
      }
    } else {
      // Running lights: up to 4 a side along the hull edge, clear of the
      // red/green nav lights.
      for (let k = 0; k < 4; k++) {
        const ly = yMin + len * (0.18 + k * 0.2);
        const ty = Math.floor(ly * g.ppu + g.oy);
        if (ty < 0 || ty >= g.h || Math.abs(ly - wideY) < len * 0.06) continue;
        const lx = halfRow[ty]! - inset;
        if (lx <= inset || distAt(lx, ly) <= 0) continue;
        lamp(-lx, ly, lampHex);
        lamp(lx, ly, lampHex);
      }
    }
  }
  return f;
}

/**
 * Shade experiments: weather every livery texel so the paint belongs to the
 * hull. Mottled (~30-texel patches) and sun-faded toward the hull grey; on
 * capitals, chips of bare metal (~3-texel noise, more near the hull edge).
 * Sub-caps get a light mottle only, so their team colour stays strong.
 */
function weatherLivery(f: Fields, dist: Float32Array, seed: number, heavy: boolean, patch = false): void {
  const g = f.g, n = g.w * g.h;
  const grey = lin(f.paint), metal = lin(PALETTE.metal);
  const s = heavy ? 1 : 0.35;
  for (let i = 0; i < n; i++) {
    if (f.mat[i] !== MAT.LIVERY) continue;
    const ty = (i / g.w) | 0;
    // 'b4' (patch) weathers mirror-symmetric, like every other livery mark.
    const tx = patch ? Math.abs(i % g.w + 0.5 - g.ox) : i % g.w;
    const n1 = valueNoise(tx * 0.033, ty * 0.033, seed);
    const n2 = valueNoise(tx * 0.35, ty * 0.35, seed + 1);
    const mott = 1 + s * 0.3 * (n1 - 0.5);
    const fade = s * (0.1 + 0.2 * n1);
    for (let c = 0; c < 3; c++) {
      const a = f.albedo[i * 3 + c]! * mott;
      f.albedo[i * 3 + c] = a + (grey[c]! - a) * fade;
    }
    if (patch) {
      // 'b4', every size (so small ships match the capitals): thin grime
      // streaks running fore-aft, and chips CLUSTERED in wear zones, of dark
      // primer (the hull grey at about half value; matte, so no sparkle).
      // Sub-cap hulls are a few hundred texels, so their wear zones and
      // streaks are finer (~4x) to land on the small flashes at all.
      const w = 1, zf = heavy ? 1 : 4, z0 = heavy ? 0.6 : 0.5;
      const streak = valueNoise(tx * 0.15 * Math.min(2, zf), ty * 0.01 * zf, seed + 2);
      const dk = 1 - w * 0.38 * (1 - Math.pow(streak, 1.4));
      for (let c = 0; c < 3; c++) f.albedo[i * 3 + c] = f.albedo[i * 3 + c]! * dk;
      const zone = valueNoise(tx * 0.025 * zf, ty * 0.025 * zf, seed + 5);
      const fleck = valueNoise(tx * 0.3 * Math.min(2, zf), ty * 0.3 * Math.min(2, zf), seed + 4);
      if (zone > z0 && fleck > 0.74 - (zone - z0) * 0.9) {
        f.mat[i] = MAT.PAINT;
        f.key[i] = f.paint;
        setAlbedo(f, i, grey, 0.5 + 0.12 * n1);
      }
      continue;
    }
    if (!heavy) continue;
    const wear = 0.18 * Math.max(0, 1 - dist[i]! / 3);
    if (n2 + wear > 0.8) {
      f.mat[i] = MAT.METAL;
      f.key[i] = PALETTE.metal;
      setAlbedo(f, i, metal, 0.78 + 0.25 * n1);
    }
  }
}

/** Smallest clear circle (radius, texels) that takes an emblem; below it a
 *  hull gets the dorsal chevron. */
const SIGIL_MIN_R = 6;
/** Emblem radius as a fraction of its clear circle, and its cap as a fraction
 *  of the hull's half-beam at that row (a capital's deck is huge). */
const SIGIL_FILL = 0.8, SIGIL_MAX_BEAM = 0.6;
/** An off-centre circle loses to the centreline's best unless the centreline
 *  falls below this fraction of it (an emblem belongs on the centreline). */
const SIGIL_CENTRE_PREF = 0.8;
/** A sub-cap emblem must span at least this fraction of the hull's half-length,
 *  or it is a speck at the zoom the hull is seen at: the chevron instead. */
const SIGIL_MIN_HULL = 0.15;
/** Chevron fallback: bow-fraction band, half-span as a fraction of the row's
 *  half-width, the minimum stroke (texels), the share of it that must land on
 *  clear plating, and how far the band widens when no row in it is clear. */
const CHEV_T0 = 0.35, CHEV_T1 = 0.55, CHEV_SPAN = 0.7, CHEV_MIN_STROKE = 2, CHEV_CLEAR = 0.97, CHEV_WIDEN = 0.2, CHEV_GAP = 2;
/** Then smaller chevrons, as fractions of the full one. */
const CHEV_SHRINK = [0.75, 0.55] as const;

/**
 * Treatment 'c' (and every capital livery): stamp the faction emblem (`sigil.ts`) in the team colour on
 * the largest clear flat area of the hull: texels still at their plated
 * height (no canopy, greeble, vent, bow fitting, nozzle or turret ring) of
 * paint, bare metal or seam, mirror-symmetric, on capitals the deck layer
 * only, once fore and once aft of the superstructure. A centred emblem is
 * preferred; an off-centre one is stamped as a mirrored pair. Flat paint (no
 * height): coverage >= 0.5 is livery enamel, the antialiased edge a blend.
 * No clear circle of SIGIL_MIN_R texels (a sub-cap: or an emblem under
 * SIGIL_MIN_HULL of its half-length): a dorsal chevron instead.
 */
function stampSigils(
  f: Fields,
  livery: Livery,
  hBase: Float32Array,
  onDeck: ((i: number) => boolean) | null,
  yMin: number,
  len: number,
  teamPaint = liveryPaint(livery.team),
): void {
  const g = f.g, n = g.w * g.h;
  const clear = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = f.mat[i];
    if (f.cov[i]! <= 0.5 || f.height[i] !== hBase[i]) continue;
    if (m !== MAT.PAINT && m !== MAT.METAL && m !== MAT.TRIM) continue;
    if (onDeck && !onDeck(i)) continue;
    clear[i] = 1;
  }
  // Mirror-symmetric: a texel is clear only if its mirror image is too.
  const ok = new Float32Array(n);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      ok[i] = clear[i]! && clear[ty * g.w + (g.w - 1 - tx)]! ? 1 : 0;
    }
  }
  const dist = distanceInside(ok, g.w, g.h);
  const tbOf = (ty: number): number => ((ty + 0.5 - g.oy) / g.ppu - yMin) / len;
  /** Hull half-width of a texel row (texels from the centreline). */
  const halfRow = (ty: number): number => {
    let h = 0;
    for (let tx = 0; tx < g.w; tx++) if (f.cov[ty * g.w + tx]! > 0.5) h = Math.max(h, Math.abs(tx + 0.5 - g.ox));
    return h;
  };
  const team = lin(teamPaint);
  const paintAt = (i: number, a: number): void => {
    if (!ok[i] || a <= 0.02) return;
    if (a >= 0.5) { paintEnamel(f, i, teamPaint, 1); return; }
    for (let c = 0; c < 3; c++) f.albedo[i * 3 + c] = f.albedo[i * 3 + c]! * (1 - a) + team[c]! * a;
  };
  /** Stamp a mark of radius R (texels) centred at texel coords (cx, cy). */
  const stamp = (cx: number, cy: number, R: number, cover: (u: number, v: number, px: number) => number): void => {
    for (let ty = Math.max(0, Math.floor(cy - R)); ty <= Math.min(g.h - 1, Math.ceil(cy + R)); ty++) {
      for (let tx = Math.max(0, Math.floor(cx - R)); tx <= Math.min(g.w - 1, Math.ceil(cx + R)); tx++) {
        paintAt(ty * g.w + tx, cover((tx + 0.5 - cx) / R, -(ty + 0.5 - cy) / R, 1 / R));
      }
    }
  };
  const design = sigilDesign(livery.sigil);
  const emblem = (u: number, v: number, px: number): number => sigilCoverage(design, u, v, px);
  const mid = g.w / 2 - 0.5; // the centreline, in texel index
  const marks: NonNullable<Fields['sigils']> = [];
  const spots: Array<{ xs: number[]; cy: number; R: number }> = [];
  for (const [t0, t1] of onDeck ? [[0, 0.45], [0.55, 1]] as const : [[0, 1]] as const) {
    const inBand = (i: number): boolean => ok[i] !== 0 && tbOf(Math.floor(i / g.w)) >= t0 && tbOf(Math.floor(i / g.w)) < t1;
    const best = largestClearCircle(dist, inBand, g.w, g.h);
    const line = largestClearCircle(dist, (i) => inBand(i) && Math.abs((i % g.w) - mid) <= 0.5, g.w, g.h);
    const centred = line.r >= SIGIL_CENTRE_PREF * best.r;
    const c = centred ? line : best;
    if (c.r < SIGIL_MIN_R) continue;
    const cy = c.y + 0.5;
    let R = Math.min(SIGIL_FILL * c.r, SIGIL_MAX_BEAM * halfRow(c.y));
    const xs = centred ? [g.ox] : [c.x + 0.5, g.w - (c.x + 0.5)];
    if (!centred) R = Math.min(R, Math.abs(c.x + 0.5 - g.ox) - 1); // the pair never touches
    if (R < SIGIL_MIN_R * SIGIL_FILL || (!onDeck && R < SIGIL_MIN_HULL * (len / 2) * g.ppu)) continue;
    spots.push({ xs, cy, R });
  }
  // A capital's fore and aft emblems are one size (the smaller fits both).
  const Rall = Math.min(...spots.map((s) => s.R));
  for (const s of spots) {
    for (const cx of s.xs) {
      stamp(cx, s.cy, Rall, emblem);
      marks.push({ x: (cx - g.ox) / g.ppu, y: (s.cy - g.oy) / g.ppu, r: Rall / g.ppu, kind: 'sigil' });
    }
  }
  if (marks.length === 0 && !onDeck) {
    // Dorsal chevron on the centreline: the widest row of the band where
    // nearly all of it lands on clear plating (never across the canopy, its
    // ring or a fitting); failing that, a wider band; failing that, none.
    const chevStroke = 0.42; // sigilChevron's stroke, a fraction of its radius
    const radiusAt = (ty: number, k: number): number => Math.max((k * CHEV_SPAN * halfRow(ty)) / 0.86, CHEV_MIN_STROKE / chevStroke);
    const clearFrac = (cy: number, R: number): number => {
      let all = 0, fine = 0;
      for (let ty = Math.max(0, Math.floor(cy - R)); ty <= Math.min(g.h - 1, Math.ceil(cy + R)); ty++) {
        for (let tx = Math.max(0, Math.floor(g.ox - R)); tx <= Math.min(g.w - 1, Math.ceil(g.ox + R)); tx++) {
          if (sigilChevron((tx + 0.5 - g.ox) / R, -(ty + 0.5 - cy) / R, 1 / R) < 0.5) continue;
          all++;
          if (dist[ty * g.w + tx]! >= CHEV_GAP) fine++; // clear, a texel off anything else
        }
      }
      return all > 0 ? fine / all : 0;
    };
    const tries = [[CHEV_T0, CHEV_T1, 1], [CHEV_T0 - CHEV_WIDEN, CHEV_T1 + CHEV_WIDEN, 1], ...CHEV_SHRINK.map((k) => [CHEV_T0 - CHEV_WIDEN, CHEV_T1 + CHEV_WIDEN, k] as const)] as const;
    for (const [t0, t1, k] of tries) {
      let by = -1, bR = 0;
      for (let ty = 0; ty < g.h; ty++) {
        const tb = tbOf(ty);
        if (tb < t0 || tb >= t1) continue;
        const R = radiusAt(ty, k);
        if (R > bR && clearFrac(ty + 0.5, R) >= CHEV_CLEAR) { bR = R; by = ty; }
      }
      if (by < 0) continue;
      stamp(g.ox, by + 0.5, bR, sigilChevron);
      marks.push({ x: 0, y: (by + 0.5 - g.oy) / g.ppu, r: bR / g.ppu, kind: 'chevron' });
      break;
    }
  }
  if (marks.length > 0) f.sigils = marks;
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

/** Does a slit rect (half extents hw × hh at ±vx, vy) touch any turret ring
 *  (its stamped extent, r × 1.15, plus a small gap)? */
function slitHitsRing(rings: ReadonlyArray<{ x: number; y: number; r: number }>, vx: number, vy: number, hw: number, hh: number): boolean {
  for (const rg of rings) {
    const R = rg.r * 1.15 + 1;
    for (const sx of [vx, -vx]) {
      const dx = Math.max(0, Math.abs(rg.x - sx) - hw), dy = Math.max(0, Math.abs(rg.y - vy) - hh);
      if (dx * dx + dy * dy < R * R) return true;
    }
  }
  return false;
}

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

/** Machined colours for bow fittings: the shared metal ramp, nothing new. */
const BOW_DARK = 0x3b4148, BOW_MID = 0x5d6573, BOW_LIGHT = 0x8a93a1;

/**
 * Stamp planned bow fittings (bowDetail.ts) into a hull's fields: raised
 * metal blocks, domes and walls, recessed hawse pipes and plating grooves.
 * Heights scale with the beam `b`, the same way turret rings scale with
 * their radius, so the light pass shades and shadows them like the rings;
 * the GPU-lit maps take their normals from this height field.
 */
function stampBowFeatures(f: Fields, features: readonly BowFeature[], b: number): void {
  const g = f.g;
  const minHalf = 0.6 / g.ppu; // thin fittings stay at least about a texel wide
  const dark = lin(BOW_DARK), mid = lin(BOW_MID), light = lin(BOW_LIGHT), trim = lin(PALETTE.trim);
  const paint = lin(f.paint);
  for (const ft of features) {
    const hw = Math.max(ft.hw, minHalf), hh = Math.max(ft.hh, minHalf);
    const c = Math.cos(ft.rot), s = Math.sin(ft.rot);
    const ext = ft.shape === 'disc' ? hw : Math.abs(c) * hw + Math.abs(s) * hh;
    const eyt = ft.shape === 'disc' ? hw : Math.abs(s) * hw + Math.abs(c) * hh;
    const x0 = Math.floor((ft.x - ext) * g.ppu + g.ox), x1 = Math.ceil((ft.x + ext) * g.ppu + g.ox);
    const y0 = Math.floor((ft.y - eyt) * g.ppu + g.oy), y1 = Math.ceil((ft.y + eyt) * g.ppu + g.oy);
    const bwr = Math.max(0.5 / g.ppu, Math.min(hw, hh) * 0.4);
    for (let ty = Math.max(0, y0); ty <= Math.min(g.h - 1, y1); ty++) {
      for (let tx = Math.max(0, x0); tx <= Math.min(g.w - 1, x1); tx++) {
        const i = ty * g.w + tx;
        if (f.cov[i]! < 0.5) continue;
        const dx = (tx + 0.5 - g.ox) / g.ppu - ft.x, dy = (ty + 0.5 - g.oy) / g.ppu - ft.y;
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        let ed: number, k = 0;
        if (ft.shape === 'disc') { k = Math.hypot(lx, ly) / hw; ed = hw - k * hw; } else ed = Math.min(hw - Math.abs(lx), hh - Math.abs(ly));
        if (ed < 0) continue;
        const bev = Math.min(1, ed / bwr);
        const dome = Math.sqrt(Math.max(0, 1 - k * k));
        const metal = (col: readonly number[], dh: number, kAlb = 1): void => {
          f.height[i] = f.height[i]! + dh; f.mat[i] = MAT.METAL; f.key[i] = PALETTE.metal; setAlbedo(f, i, col, kAlb);
        };
        switch (ft.kind) {
          case 'seam':
            f.mat[i] = MAT.TRIM;
            f.albedo[i * 3] = f.albedo[i * 3]! * 0.42; f.albedo[i * 3 + 1] = f.albedo[i * 3 + 1]! * 0.42; f.albedo[i * 3 + 2] = f.albedo[i * 3 + 2]! * 0.42;
            f.height[i] = f.height[i]! - Math.min(0.6, b * 0.001);
            break;
          case 'hawse':
            // A dark pipe mouth inside a raised lip.
            if (k > 0.72) metal(mid, b * 0.004 * (1 - Math.abs(k - 0.86) / 0.14), 0.9);
            else { f.height[i] = f.height[i]! - b * 0.008 * (1 - k); f.mat[i] = MAT.TRIM; f.key[i] = PALETTE.trim; setAlbedo(f, i, trim, 0.7); }
            break;
          case 'anchor':
            metal(dark, b * 0.007 * bev, Math.abs(ly) > hh * 0.75 ? 0.75 : 1);
            break;
          case 'chain': {
            // Links: a bump every ~1.6 widths along the run.
            const link = 0.5 + 0.5 * Math.cos((ly / (hw * 1.6)) * Math.PI);
            metal(dark, b * 0.003 * (0.4 + 0.6 * link) * bev, 0.75 + 0.35 * link);
            break;
          }
          case 'windlass':
            metal(bev < 0.4 ? dark : mid, b * 0.022 * bev);
            break;
          case 'wildcat':
            metal(k < 0.35 ? dark : k > 0.85 ? dark : light, b * 0.018 * Math.max(0.35, dome));
            break;
          case 'breakwater':
            // A painted plate wall standing off the deck, lit top edge.
            f.height[i] = f.height[i]! + b * 0.028 * bev;
            f.mat[i] = MAT.PAINT; f.key[i] = f.paint; setAlbedo(f, i, paint, bev < 0.5 ? 0.8 : 1.12);
            break;
          case 'bollard': {
            // Twin posts on a base plate.
            const post = Math.hypot(lx, Math.abs(ly) - hh * 0.55) / hw;
            if (post < 0.9) metal(light, b * 0.016 * Math.sqrt(1 - post * post) + b * 0.004);
            else metal(mid, b * 0.004 * bev, 0.85);
            break;
          }
          case 'fairlead':
            if (Math.abs(lx) < hw * 0.4 && Math.abs(ly) < hh * 0.6) { f.mat[i] = MAT.TRIM; f.key[i] = PALETTE.trim; setAlbedo(f, i, trim, 0.8); }
            else metal(mid, b * 0.007 * bev);
            break;
          case 'ventilator':
            // Mushroom head: a dome with a dark skirt.
            metal(k > 0.82 ? dark : light, b * 0.016 * Math.max(0.25, dome), k > 0.82 ? 1 : 0.95);
            break;
          case 'hatch':
            if (bev < 0.35) metal(mid, b * 0.01 * Math.max(0.5, bev / 0.35));
            else { f.height[i] = f.height[i]! + b * 0.006; f.mat[i] = MAT.PAINT; f.key[i] = f.paint; setAlbedo(f, i, paint, 0.82); }
            break;
          case 'jackstaff':
            metal(light, b * 0.012 * bev);
            break;
          case 'director':
            // A boxy director, its forward face slotted.
            if (ly < -hh * 0.45 && ly > -hh * 0.7 && Math.abs(lx) < hw * 0.7) { f.height[i] = f.height[i]! + b * 0.03; f.mat[i] = MAT.TRIM; f.key[i] = PALETTE.trim; setAlbedo(f, i, trim); }
            else metal(bev < 0.3 ? mid : light, b * 0.04 * Math.max(0.3, bev));
            break;
          case 'rangefinder':
            // The long rangefinder arms, dark lens hoods at each end.
            metal(Math.abs(lx) > hw * 0.88 ? dark : mid, b * 0.05 * Math.max(0.4, bev));
            break;
        }
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
  naval?: NavalTurretSpec;
}

/** Naval turret geometry. `part` bakes the gunhouse alone or ONE barrel
 *  alone (at x 0, same face position), so a quad AA can recoil its barrels
 *  one at a time; absent = the whole turret in one image. */
export interface NavalTurretSpec { barrels: number; houseW: number; houseL: number; part?: 'house' | 'barrel' }

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
  if (nv.part === 'barrel') xs.push(0);
  else if (nv.part !== 'house') for (let k = 0; k < n; k++) xs.push((k - (n - 1) / 2) * pitch);
  const barrelPolys: Poly[] = xs.map((x): Poly => [[x - bw, -hl - len], [x + bw, -hl - len], [x + bw, -hl + 0.5], [x - bw, -hl + 0.5]]);
  const polys = nv.part === 'barrel' ? barrelPolys : [housePoly, ...barrelPolys];
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
      const inHouse = nv.part !== 'barrel' && wy >= -hl && wy <= hl && Math.abs(wx) <= hw;
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
        // The barrel's top stays under the gunhouse roof (user, 2026-11-08:
        // the house shades the barrels, never the reverse).
        const bh = Math.max(0.05, Hh * 0.72 - bw * (1 - cyl));
        if (bh > h) {
          h = bh; mat = MAT.METAL; col = metal; key = PALETTE.metal; kk = 0.95 + 0.08 * nz;
          if (v < 0.07) { col = worn; h = Math.min(Hh * 0.8, h + bw * 0.3); } // blast bag collar
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
          // The barrel's top stays under the casing's crown, so the casing
          // shades the barrel, not the reverse (user, 2026-11-08).
          const bh = Math.max(0.05, capH * 0.62 - half * (1 - cyl));
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
