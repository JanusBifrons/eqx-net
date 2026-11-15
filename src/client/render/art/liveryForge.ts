/**
 * Machined art: ship livery (grey hulls, the owner faction's colour in
 * painted spots or sections). The colour rules, the per-texel layout each
 * treatment paints (`liveryLayout`, called by `forgeShip`), weathering and
 * the faction sigils. Guide: docs/architecture/art-direction.md, "Ship livery".
 */
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { distanceInside, hashStr, type Grid, type Poly } from './raster.js';
import { lin, MAT, muted, PALETTE, setAlbedo, valueNoise, type Fields, type Livery, type LiveryEdge } from './fieldsCore.js';

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
type ShadeTreatment = 'b2' | 'b3' | 'b4' | 'b5' | 'b6' | 'b7' | 'b8';
export const LIVERY_SHADES: Readonly<Record<ShadeTreatment, LiveryShade>> = {
  b2: { hullDl: -0.12, hullS: 0.04, teamS: 1.15, teamD: 1.0, capS: 0.72, capD: 0.74 },
  b3: { hullDl: -0.2, hullS: 0.03, teamS: 1.3, teamD: 1.0, capS: 0.62, capD: 0.6 },
  b4: { hullDl: -0.2, hullS: 0.03, teamS: 1.0, teamD: 0.88, capS: 0.5, capD: 0.74 },
  b5: { hullDl: -0.2, hullS: 0.03, teamS: 1.0, teamD: 0.88, capS: 0.5, capD: 0.74 },
  b6: { hullDl: -0.2, hullS: 0.03, teamS: 1.0, teamD: 0.88, capS: 0.5, capD: 0.74 },
  b7: { hullDl: -0.2, hullS: 0.03, teamS: 1.0, teamD: 0.88, capS: 0.5, capD: 0.74 },
  b8: { hullDl: -0.2, hullS: 0.03, teamS: 1.0, teamD: 0.88, capS: 0.5, capD: 0.74 },
};
/** Painted-section edge shapes (owner, 2026-11-15: "the straight lines look
 *  bad, a more interesting shape than a straight line"). Offset of the edge,
 *  in bow-fraction units, against `ax` = |x| / the row's half-width (0 on
 *  the centreline, 1 at the side): positive moves a bow edge aft and a stern
 *  edge forward. Mirror-symmetric by construction (|x|). Never negative: a
 *  shape only ADDS paint to b4's straight section (a review saw shapes that
 *  cut into it read as streaks and flames). */
const B4_EDGE: Readonly<Record<'straight' | LiveryEdge, (ax: number) => number>> = {
  straight: () => 0, // b4
  swept: (ax) => 0.14 * ax, // chevron on a solid base: the sides reach further
  tongue: (ax) => 0.12 * (1 - ax * ax), // the centreline reaches further
  tooth: (ax) => { const u = ax * 2; return 0.045 * (1 - Math.abs(2 * (u - Math.floor(u)) - 1)); }, // dog-tooth: 2 broad teeth a side
};
/** The deepest each robot edge shape reaches (hull-length fraction). */
const ROBOT_EDGE_MAX4: Readonly<Record<'straight' | LiveryEdge, number>> = { straight: 0, swept: 0.18, tongue: 0.15, tooth: 0.12 };
/** A robot's section edges, bolder than `B4_EDGE` (a review at combat zoom,
 *  ~75 px across, could not read the capital-scale shapes on a robot):
 *  swept a clearly pointed chevron, tongue a clearly rounded tongue (both in
 *  `B4_EDGE`'s units: |x| over the row's half-width, never negative), and
 *  tooth 4 SQUARE teeth across the face (2 a side, `ROBOT_EDGE_MAX4.tooth` of
 *  the hull length deep). Tooth takes |x| over the section edge's OWN
 *  half-width (one per section), not the row's: triangular teeth in
 *  row-relative x on a tapering face (the hexagon's) ran their flanks along
 *  the hull's sloped sides, and a review at combat zoom saw one straight
 *  diagonal. The centre stays clear for the nose turret; the outer tooth
 *  keeps a gap to the side. */
const ROBOT_EDGE4: Readonly<Record<'straight' | LiveryEdge, (ax: number) => number>> = {
  straight: () => 0,
  swept: (ax) => 0.18 * ax,
  tongue: (ax) => 0.15 * Math.sqrt(Math.max(0, 1 - ax * ax)),
  tooth: (ax) => ((ax >= 0.3 && ax < 0.52) || (ax >= 0.68 && ax < 0.9) ? ROBOT_EDGE_MAX4.tooth : 0),
};
/** A turret's paint keep-out radius as a multiple of max(ring, cap)
 *  (`turretCoverOf`); capital b4 sections widen it (`forgeShip`). */
export const TURRET_COVER_REACH = 1.4;
/** The b4-family treatments and the section edge each wears. */
function b4EdgeOf(l: Livery | undefined): 'straight' | LiveryEdge | undefined {
  switch (l?.treatment) {
    case 'b4': return 'straight';
    case 'b5': return 'swept';
    case 'b6': return 'tongue';
    case 'b7': return 'tooth';
    case 'b8': return l.edge ?? 'tongue';
    default: return undefined;
  }
}
/** The shade experiment a livery uses, or undefined (plain treatment). */
export function liveryShade(l: Livery | undefined): LiveryShade | undefined {
  const t = l?.treatment;
  return t !== undefined && t in LIVERY_SHADES ? LIVERY_SHADES[t as ShadeTreatment] : undefined;
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
export function paintEnamel(f: Fields, i: number, c: number, k: number): void {
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

/** What `forgeShip` hands the livery layout (its hull, already rasterised). */
export interface LiveryLayoutIn {
  f: Fields;
  livery: Livery | undefined;
  turretCover: ReadonlyArray<{ x: number; y: number; reach: number }> | undefined;
  g: Grid;
  dist: Float32Array;
  parts: ReadonlyArray<{ pts: Poly; color: number; role?: string }>;
  /** Top-most part per texel (-1: none). */
  layer: Int8Array;
  arch: 'fighter' | 'freighter' | 'robot';
  sizeCls: string;
  seedKey: string;
  yMin: number;
  len: number;
  maxDu: number;
  bw: number;
  spacing: number;
}

/**
 * The livery layout for one hull: which texels each treatment paints
 * (`liveryHexAt`: the colour, or -1 for grey), plus what `forgeShip` needs
 * later (lamps, sigils, weathering).
 */
export function liveryLayout(p: LiveryLayoutIn) {
  const { f, livery, turretCover, g, dist, parts, layer, arch, sizeCls, seedKey, yMin, len, maxDu, bw, spacing } = p;
  const n = g.w * g.h;
  // Livery treatment 'a' (rim / edge band): the team colour runs along the
  // outer edge, everything inside stays grey. Frigates and cruisers add a thin
  // pinstripe inside the rim; capitals carry a narrower rim on the hull part
  // only (deck and superstructure stay grey). Never under 2 texels wide.
  // `dist` counts whole texels to the nearest outside centre (a full edge
  // texel is 1), so < 2.5 texels keeps two full texels plus the AA edge.
  const minLiv = 2.5 / g.ppu;
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
  //    INSTEAD of those spots; one whose spots are under TAIL_FULL4 wears
  //    them as well. The flashes grow (TAIL_GROW4) until the paint reaches
  //    TAIL_FULL4 of the hull (owner, 2026-11-15: "all hulls should be
  //    painted").
  //  - Robots: painted bow and stern sections like the capitals' (bow
  //    fraction < ROBOT_SEC4, never under ROBOT_MIN_TEX4 texels deep), in the
  //    faction's edge shape drawn bolder (ROBOT_EDGE4), instead of B's corner
  //    tips; the core ring stays. A crisp edge (no jitter, no flaking, half
  //    the wear), and no turret keep-out: a sub-cap's keep-out (1.4x the
  //    ring) round the orb's nose turret ate the middle of its bow section,
  //    leaving two flecked slivers that read grey in game.
  const b4Key = b4EdgeOf(livery);
  const b4 = b4Key !== undefined;
  const edgeOf = b4Key !== undefined ? B4_EDGE[b4Key] : B4_EDGE.straight;
  const robotEdgeOf = ROBOT_EDGE4[b4Key ?? 'straight'];
  /** |x| over this row's half-width (0 = centreline, 1 = side). */
  const axOf = (wx: number, ty: number): number => Math.min(1, Math.abs(wx) / Math.max(1e-3, halfRow[ty] ?? 0));
  const CAP_BOW4 = 0.2, CAP_STERN4 = 0.085, EDGE_JIT4 = 0.018, TAIL_T4 = 0.66, TAIL_NEED4 = 0.05, TAIL_FULL4 = 0.085, B4_VALUE = 0.78;
  const TAIL_GROW4 = [1, 1.25, 1.5, 1.8, 2.2] as const;
  /** Robot b4 sections: share of the hull length at each end, at most
   *  ROBOT_SEC4 and pulled in so the edge shape's deepest point stops
   *  ROBOT_CLEAR4 short of the core (a review saw cubes all violet: the teeth
   *  reached 37 % in from each end, and the grey between them hid behind the
   *  core ring); never under ROBOT_SEC_MIN4 nor ROBOT_MIN_TEX4 texels (the
   *  smallest cube must still show the edge shape). */
  const ROBOT_SEC4 = 0.24, ROBOT_SEC_MIN4 = 0.1, ROBOT_CLEAR4 = 0.06, ROBOT_MIN_TEX4 = 3.5;
  /** Dog-tooth's capital bow tip read thinnest at line-up zoom (its teeth hide
   *  under the forward turrets' keep-out): at the bow only, a fuller base and
   *  teeth twice as deep, so the outer teeth clear the barbettes. */
  const toothBow = edgeOf === B4_EDGE.tooth;
  const bowOff4 = (ax: number): number => (toothBow ? 0.04 + 2 * edgeOf(ax) : edgeOf(ax));
  const paintLum = (() => { const p = lin(f.paint); return Math.max(1e-4, 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]); })();
  const cover = b4 ? turretCover ?? [] : [];
  /** Inside a turret's paint keep-out, its reach times `k`. */
  const underTurret = (wx: number, wy: number, k = 1): boolean => {
    for (const c of cover) { const dx = wx - c.x, dy = wy - c.y, r = c.reach * k; if (dx * dx + dy * dy < r * r) return true; }
    return false;
  };
  /** Capital section paint keeps a wider grey margin round each turret base
   *  (a review could not see one at `turretCoverOf`'s reach); the paint a
   *  shaped edge adds beyond b4's straight section (swept arms reaching past
   *  the secondaries) keeps a wider one still (a review saw only a sliver). */
  const CAP_KEEPOUT4 = 1.7 / TURRET_COVER_REACH, CAP_KEEPOUT_SHAPE4 = 2.0 / TURRET_COVER_REACH;
  /** b4 sections: the edge's broken jitter (mirror-symmetric). */
  const jit4 = (wx: number, wy: number, a = EDGE_JIT4): number => a * (valueNoise((Math.abs(wx) / len) * 40, (wy / len) * 40, edgeSeed) - 0.5) * 2;
  /** Capital b4: inside the painted BOW section (its edge as the paint draws it). */
  const inBow4 = (i: number): boolean => {
    const ty = Math.floor(i / g.w);
    const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
    return (wy - yMin) / len < CAP_BOW4 + jit4(wx, wy) + bowOff4(axOf(wx, ty));
  };
  const robot4 = b4 && arch === 'robot';
  /** The robot core's radius (its ring is stamped later), centred on the origin. */
  const robotCoreR = Math.max(1, maxDu * 0.35);
  const robotCoreTb = Math.min((-robotCoreR - yMin) / len, 1 - (robotCoreR - yMin) / len);
  const robotSec4 = Math.max(
    ROBOT_SEC_MIN4, ROBOT_MIN_TEX4 / Math.max(1e-3, len * g.ppu),
    Math.min(ROBOT_SEC4, robotCoreTb - ROBOT_CLEAR4 - ROBOT_EDGE_MAX4[b4Key ?? 'straight']),
  );
  /** Half-width of the hull at a robot section's edge row (tooth's |x| unit). */
  const robotHwAt = (tb: number): number => {
    const hw = halfRow[Math.floor(g.oy + (yMin + tb * len) * g.ppu)] ?? 0;
    return hw > 1e-3 ? hw : Math.max(1e-3, maxHalf);
  };
  const robotHwF = robot4 ? robotHwAt(robotSec4) : 1, robotHwR = robot4 ? robotHwAt(1 - robotSec4) : 1;
  const roleOf = (i: number): string | undefined => (parts[layer[i]!] as { role?: string } | undefined)?.role;
  const edgeSeed = hashStr(seedKey + ':b4edge');
  let tailFlash = false, tailSpots = false;
  let tailW = Math.max(minLiv * 1.5, 0.24 * maxDu), tailT = TAIL_T4;
  /** A tail-flash texel (a broken, worn, mirror-symmetric edge); `off`: the section-edge shape's offset. */
  const flashAt = (tb: number, du: number, wx: number, wy: number, off: number): boolean =>
    tb > tailT - 1.6 * off && du < tailW * (0.75 + 0.5 * valueNoise(Math.abs(wx) * 0.9, wy * 0.9, edgeSeed));
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
    const spotAt = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (f.cov[i]! <= 0.5) continue;
      hull++;
      const ty = Math.floor(i / g.w);
      const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const tb = (wy - yMin) / len, du = dist[i]! / g.ppu;
      // The straight (b4) layout decides, so a shaped edge only adds paint.
      const spot = tb < NOSE_B || tipAt(wx, wy, ty) || (pin && du < 2 * spacing && tb < 0.4);
      if (spot && !underTurret(wx, wy)) { vis++; spotAt[i] = 1; }
    }
    tailFlash = vis < TAIL_FULL4 * hull;
    tailSpots = tailFlash && vis >= TAIL_NEED4 * hull;
    if (tailFlash) {
      // Grow the flashes until the hull's visible paint reaches TAIL_FULL4.
      const w0 = tailW;
      for (const k of TAIL_GROW4) {
        tailW = w0 * k;
        tailT = TAIL_T4 - 0.12 * (k - 1);
        let p = tailSpots ? vis : 0;
        for (let i = 0; i < n; i++) {
          if (f.cov[i]! <= 0.5 || (tailSpots && spotAt[i])) continue;
          const ty = Math.floor(i / g.w);
          const wx = (i % g.w + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
          if (!underTurret(wx, wy) && flashAt((wy - yMin) / len, dist[i]! / g.ppu, wx, wy, 0)) p++;
        }
        if (p >= TAIL_FULL4 * hull) break;
      }
    }
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
      if (underTurret(wx, wy, CAP_KEEPOUT4)) return -1;
      const jit = jit4(wx, wy);
      if (tb < CAP_BOW4 + jit || tb > 1 - CAP_STERN4 + jit) return teamHex; // b4's straight section
      const off = edgeOf(axOf(wx, ty));
      if (tb < CAP_BOW4 + jit + bowOff4(axOf(wx, ty)) || tb > 1 - CAP_STERN4 + jit - 0.6 * off) return underTurret(wx, wy, CAP_KEEPOUT_SHAPE4) ? -1 : teamHex;
      return -1;
    }
    if (b4 && arch === 'robot') {
      // Bow and stern sections in the faction's edge shape (no corner tips),
      // crisp and painted under the turret too (see ROBOT_EDGE4).
      const front = tb < 0.5;
      const off = robotEdgeOf(b4Key === 'tooth' ? Math.abs(wx) / (front ? robotHwF : robotHwR) : axOf(wx, ty));
      return (front ? tb < robotSec4 + off : tb > 1 - robotSec4 - off) ? teamHex : -1;
    }
    if (b4) {
      if (underTurret(wx, wy)) return -1;
      if (tailFlash && flashAt(tb, du, wx, wy, edgeOf(axOf(wx, ty)))) return teamHex;
      // A hull whose spots are mostly turret-hidden shows the flashes alone:
      // what is left of them would only peek out as slivers.
      if (tailFlash && !tailSpots) return -1;
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
    if (arch !== 'robot' && tb < NOSE_B + (b4 ? 1.2 * edgeOf(axOf(wx, ty)) : 0)) return teamHex;
    if (tipAt(wx, wy, ty)) return teamHex;
    if (pin && du < 2 * spacing) return fadeStep(teamHex, f.paint, tb, 0.15, 0.4);
    return -1;
  };

  /** 'b4': the paint takes the hull's own tone at this texel. */
  const b4Tone = (surf: readonly number[]): number =>
    B4_VALUE * Math.min(1.15, Math.max(0.6, (0.2126 * surf[0]! + 0.7152 * surf[1]! + 0.0722 * surf[2]!) / paintLum));
  return { treatB, teamHex, lampHex, halfRow, shade, b4, robot4, inBow4, liveryHexAt, b4Tone };
}

/**
 * Shade experiments: weather every livery texel so the paint belongs to the
 * hull. Mottled (~30-texel patches) and sun-faded toward the hull grey; on
 * capitals, chips of bare metal (~3-texel noise, more near the hull edge).
 * Sub-caps get a light mottle only, so their team colour stays strong.
 * `light` ('patch' only): half the chalk, grime and chips, none near the section
 * edge (CRISP_TEX) (a b4 robot, whose edge must stay crisp; it passes
 * `flakeTex` 0 for no flaking).
 */
export function weatherLivery(
  f: Fields, dist: Float32Array, seed: number, heavy: boolean, patch = false, flakeTex = 2.5, inBow: ((i: number) => boolean) | null = null,
  light = false,
): void {
  const g = f.g, n = g.w * g.h;
  // 'patch': deck sigils / chevrons stay clean team paint (a review saw them
  // washed out by the chalk, grime and flaking).
  const marks = patch ? f.sigils ?? [] : [];
  const inMark = (i: number): boolean => {
    const x = (i % g.w + 0.5 - g.ox) / g.ppu, y = ((i / g.w | 0) + 0.5 - g.oy) / g.ppu;
    for (const m of marks) if ((x - m.x) * (x - m.x) + (y - m.y) * (y - m.y) <= m.r * m.r) return true;
    return false;
  };
  const grey = lin(f.paint), metal = lin(PALETTE.metal);
  // Robots ('light'): owner (2026-11-15) "the weathering is too extreme" on
  // them, so a faint mottle only, light grime and chalk, and no chips.
  const s = heavy ? 1 : light ? 0.12 : 0.35;
  // 'patch': texels to the nearest place the paint meets grey HULL (its
  // section edge), for flaking there. Space outside the hull counts as paint,
  // so a narrow bow does not flake away along its outline (in game the bows
  // vanished at line-up zoom). Mirror-symmetric like the paint.
  let dPaint: Float32Array | null = null;
  if (patch && (flakeTex > 0 || light)) {
    const mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = f.mat[i] === MAT.LIVERY || f.cov[i]! <= 0.5 ? 1 : 0;
    dPaint = distanceInside(mask, g.w, g.h);
  }
  for (let i = 0; i < n; i++) {
    if (f.mat[i] !== MAT.LIVERY) continue;
    if (marks.length > 0 && inMark(i)) continue;
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
      // Owner (2026-11-15): B4 "didn't look very weathered". On top: paint
      // flaking where it meets the grey (its own edge or the hull's), thin
      // fore-aft scratches to bare metal, chalky sun-faded patches, and
      // heavier grime.
      // A capital's bow section wears half the chalk, flaking and scratches,
      // so it still reads red at line-up zoom (the stern keeps them).
      const bow = inBow !== null && inBow(i);
      const w = light ? 0.15 : 1, zf = heavy ? 1 : 4, z0 = heavy ? 0.6 : 0.5;
      const streak = valueNoise(tx * 0.15 * Math.min(2, zf), ty * 0.01 * zf, seed + 2);
      const dk = 1 - w * 0.5 * (1 - Math.pow(streak, 1.4));
      const chalk = Math.max(0, valueNoise(tx * 0.012 * zf, ty * 0.012 * zf, seed + 6) - 0.45) * (bow ? 0.35 : 0.7) * w; // 0 .. ~0.38
      for (let c = 0; c < 3; c++) {
        const a = f.albedo[i * 3 + c]! * dk;
        f.albedo[i * 3 + c] = a + (grey[c]! * 1.2 - a) * chalk;
      }
      const E = bow ? flakeTex * 0.5 : flakeTex; // flaking band, texels
      if (dPaint !== null && dPaint[i]! < E && valueNoise(tx * 0.35 * Math.min(2, zf), ty * 0.35 * Math.min(2, zf), seed + 7) > 0.32 + 0.55 * (dPaint[i]! / E)) {
        f.mat[i] = MAT.PAINT;
        f.key[i] = f.paint;
        setAlbedo(f, i, grey, 0.85 + 0.1 * n1);
        continue;
      }
      // Scratches on capitals only: at a small ship's texel scale they are speckle.
      if (heavy && valueNoise(tx * 0.9, ty * 0.045, seed + 8) > 0.88 && (!bow || valueNoise(tx * 0.9, ty * 0.045, seed + 10) > 0.5)) {
        f.mat[i] = MAT.METAL;
        f.key[i] = PALETTE.metal;
        setAlbedo(f, i, metal, 0.72);
        continue;
      }
      const zone = valueNoise(tx * 0.025 * zf, ty * 0.025 * zf, seed + 5);
      const fleck = valueNoise(tx * 0.3 * Math.min(2, zf), ty * 0.3 * Math.min(2, zf), seed + 4);
      if (!light && zone > z0 && fleck > 0.74 - (zone - z0) * 0.9 && (!heavy || valueNoise(tx * 0.3, ty * 0.3, seed + 9) > CHIP_THIN)
        && (!light || (dPaint![i]! >= CRISP_TEX && valueNoise(tx * 0.3 * zf, ty * 0.3 * zf, seed + 11) > 0.5))) {
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

/** Capital b4 weathering: a dark-primer chip survives only where a second
 *  fleck-scale noise clears this (about 30 % fewer chips than sub-caps' rule;
 *  a review found the capital mottling too dense). */
const CHIP_THIN = 0.38;
/** `light` weathering: no chip within this many texels of the section edge
 *  (`distanceInside` units: the edge texel is 1), so the edge shape reads as
 *  one crisp line. */
const CRISP_TEX = 5;

