/**
 * Machined art — faction sigils (emblems) for ship liveries.
 *
 * Each faction gets a procedural emblem, seeded by its id (no PNGs), built
 * from a few chunky elements a WW2-style insignia uses: an optional outer
 * ring (a circle or a vertex-up polygon), k-fold spokes (bars, star points,
 * petals) or swept wings, and a central glyph (disc, diamond, chevron, star,
 * triangle, cross, hexagon, spearhead, or an outline / double variant). A
 * knockout gap separates the glyph from what surrounds it, so the mark reads
 * at 12–40 texels across.
 *
 * Part of the forge, like `bowDetail.ts`: `forgeShip` finds the largest
 * clear flat area of a hull (`largestClearCircle`) and stamps
 * `sigilCoverage` there. Tiny hulls get `sigilChevron` instead.
 *
 * Coordinates: emblem-local u,v in [-1, 1], v up = the ship's nose. Every
 * shape is evaluated on |u|, so the emblem is exactly mirror-symmetric about
 * u = 0 (hulls are), and nothing is drawn outside the unit circle.
 */
import { distanceInside, rng } from './raster.js';
import { lin, MAT, type Fields, type Livery } from './fieldsCore.js';
import { liveryPaint, paintEnamel } from './liveryForge.js';

export type SigilRing = 'none' | 'circle' | 'polygon';
export type SigilSpokes = 'none' | 'bar' | 'point' | 'petal' | 'wings';

export type SigilArchetype = 'roundel' | 'badge' | 'burst' | 'wheel' | 'winged' | 'solo';

export interface SigilDesign {
  /** Layout family: ring + big glyph (roundel, badge), spokes + small glyph (burst),
   *  ring + bar spokes (wheel), wings + glyph (winged), or a big glyph alone (solo). */
  archetype: SigilArchetype;
  /** Rotational symmetry of spokes and polygon ring (3..6); one arm points at the nose. */
  fold: number;
  ring: boolean;
  ringShape: SigilRing;
  /** Ring band, as fractions of the emblem radius. */
  ringInner: number;
  ringOuter: number;
  spokes: SigilSpokes;
  /** Bar half-width, petal half-width, or wing root depth below the centre. */
  spokeWidth: number;
  /** Spoke span, radially (for a star: inner = valley radius, outer = tip radius). */
  spokeInner: number;
  spokeOuter: number;
  /** Central glyph: low 3 bits pick the shape, bit 3 the outline/double variant. */
  glyph: number;
  glyphRadius: number;
  /** Knockout gap around the glyph. */
  gap: number;
}

/** Minimum stroke (fraction of radius) that survives at ~12 texels. */
const STROKE = 0.14;

/** Glyphs that stay legible when small (solid, no inner detail): disc, diamond,
 *  5-star, 4-star, triangle, cross, hexagon. */
const SOLID_GLYPHS = [0, 1, 3, 11, 4, 5, 6] as const;
/** Compact glyphs for the heart of a star: disc, diamond, triangle, hexagon. */
const HUB_GLYPHS = [0, 1, 4, 6] as const;
/** Glyphs with enough character to stand alone (outline, double, pointed). */
const SOLO_GLYPHS = [2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
/** Furthest any glyph reaches, as a multiple of its radius (diamond tip). */
const GLYPH_REACH = 1.3;

/** Deterministic emblem design for a seed (e.g. `hashStr(factionId)`). */
export function sigilDesign(seed: number): SigilDesign {
  const r = rng((seed ^ 0x5161a7) >>> 0);
  r(); r();
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length]!;
  const archetype = pick(['roundel', 'roundel', 'badge', 'burst', 'burst', 'wheel', 'winged', 'solo'] as const);
  let fold = 3 + Math.floor(r() * 4);
  // A triangular badge leaves no room for a glyph.
  if (archetype === 'badge') fold = 4 + (fold % 3);
  // No six-pointed stars: they read as a real-world religious symbol, not a faction mark.
  if (archetype === 'burst' && fold === 6) fold = 5;
  const anyGlyph = Math.floor(r() * 16);
  const solidGlyph = pick(SOLID_GLYPHS);
  const gap = 0.14 + r() * 0.03;
  const ringShape: SigilRing = archetype === 'roundel' || archetype === 'wheel' ? 'circle' : archetype === 'badge' ? 'polygon' : 'none';
  const ring = ringShape !== 'none';
  const ringOuter = ringShape === 'polygon' ? 0.98 : 0.96;
  const ringInner = ringOuter - (STROKE + 0.02 + r() * 0.05);
  let spokes: SigilSpokes = 'none';
  let glyph: number = solidGlyph, glyphRadius: number, spokeWidth = 0, spokeInner = 0, spokeOuter = 0;
  switch (archetype) {
    case 'roundel':
    case 'badge':
      glyphRadius = (ringShape === 'polygon' ? ringInner * Math.cos(Math.PI / fold) : ringInner) - gap - 0.04 - r() * 0.06;
      glyph = glyphRadius >= 0.45 ? anyGlyph : solidGlyph;
      break;
    case 'solo':
      glyph = pick(SOLO_GLYPHS);
      glyphRadius = 0.66 + r() * 0.1;
      break;
    case 'burst':
      // A solid star (or petal rosette) with a compact glyph knocked out of
      // its heart; pointed glyphs would cut the arms on their axes.
      spokes = pick(['point', 'point', 'petal'] as const);
      glyph = pick(HUB_GLYPHS);
      glyphRadius = 0.24 + r() * 0.06;
      spokeOuter = 0.96;
      if (spokes === 'point') {
        spokeInner = glyphRadius + gap + STROKE + r() * 0.08; // star valley radius
      } else {
        spokeInner = glyphRadius;
        spokeWidth = (spokeInner + (spokeOuter - spokeInner) * 0.45) * Math.sin(Math.PI / fold) * (0.7 + r() * 0.15);
      }
      break;
    case 'wheel':
      // A round hub: a pointed one's knockout would bite the spokes away.
      spokes = 'bar';
      glyph = r() < 0.6 ? 0 : 6;
      glyphRadius = 0.26 + r() * 0.06;
      spokeWidth = 0.08 + r() * 0.025;
      spokeInner = glyphRadius;
      spokeOuter = ringInner + 0.02;
      break;
    default: // winged
      spokes = 'wings';
      glyph = pick(HUB_GLYPHS);
      glyphRadius = 0.34 + r() * 0.06;
      spokeWidth = 0.3 + r() * 0.08;
      spokeInner = glyphRadius;
      spokeOuter = 0.97;
  }
  return { archetype, fold, ring, ringShape, ringInner, ringOuter, spokes, spokeWidth, spokeInner, spokeOuter, glyph, glyphRadius, gap };
}

// ---------------------------------------------------------------------------
// Signed-distance helpers (negative inside), all on x = |u| >= 0.

/** Fold (x >= 0, y) into the dihedral wedge of a k-fold pattern with an arm on +y.
 *  Returns local [across, along] coordinates. */
function fold(x: number, y: number, k: number): [number, number] {
  const r = Math.hypot(x, y);
  const seg = (2 * Math.PI) / k;
  let a = Math.atan2(x, y) % seg;
  if (a > seg / 2) a = seg - a;
  return [r * Math.sin(a), r * Math.cos(a)];
}

/** Regular k-gon, circumradius R, vertex up. */
function sdPoly(x: number, y: number, k: number, R: number): number {
  const [fx, fy] = fold(x, y, k);
  const h = Math.PI / k;
  return fx * Math.sin(h) + fy * Math.cos(h) - R * Math.cos(h);
}

/** k-pointed star, tip radius R, valley radius ri, a point up. */
function sdStar(x: number, y: number, k: number, R: number, ri: number): number {
  const [fx, fy] = fold(x, y, k);
  const h = Math.PI / k;
  const vx = ri * Math.sin(h), vy = ri * Math.cos(h);
  let nx = R - vy, ny = vx;
  const l = Math.hypot(nx, ny);
  nx /= l; ny /= l;
  return fx * nx + (fy - R) * ny;
}

/** Axis-aligned box centred (cx, cy), half extents hw × hh. */
function sdBox(x: number, y: number, cx: number, cy: number, hw: number, hh: number): number {
  const dx = Math.abs(x - cx) - hw, dy = Math.abs(y - cy) - hh;
  return Math.max(dx, dy) < 0 ? Math.max(dx, dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

/** Upward chevron (^) with its apex at (0, top): arms of half-thickness t,
 *  drooping by `drop` over half-span w. */
function sdChevron(x: number, y: number, top: number, w: number, drop: number, t: number): number {
  const l = Math.hypot(w, drop);
  // Line through (0, top) and (w, top - drop); distance measured along its normal.
  const d = (x * drop + (y - top) * w) / l;
  // Band of thickness 2t whose upper edge passes through the apex.
  return Math.max(Math.abs(d + t) - t, x - w);
}

/** Half-plane through (ax, ay)→(bx, by): positive on the side away from the
 *  interior point (cx, cy) (default the origin). */
function halfPlane(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx = 0, cy = 0): number {
  let nx = by - ay, ny = -(bx - ax);
  if (nx * (cx - ax) + ny * (cy - ay) > 0) { nx = -nx; ny = -ny; }
  const l = Math.hypot(nx, ny);
  return ((x - ax) * nx + (y - ay) * ny) / l;
}

/** Hollow a convex shape to a band of width w inside its edge. */
const outline = (d: number, w: number): number => Math.max(d, -(d + w));

function sdGlyph(d: SigilDesign, x: number, y: number): number {
  const g = d.glyphRadius;
  const alt = (d.glyph & 8) !== 0;
  const band = Math.max(STROKE + 0.02, g * 0.32);
  switch (d.glyph & 7) {
    case 0: { // disc / roundel
      const c = Math.hypot(x, y) - g;
      return alt ? Math.min(outline(c, band), Math.hypot(x, y) - g * 0.28) : c;
    }
    case 1: { // diamond
      const c = sdPoly(x, y * 0.82, 4, g * 1.05);
      return alt ? outline(c, band) : c;
    }
    case 2: { // chevron (double when alt)
      const t = Math.max(STROKE / 2 + 0.01, g * 0.2);
      if (!alt) return sdChevron(x, y, g * 0.75, g * 1.05, g * 0.95, t);
      return Math.min(
        sdChevron(x, y, g * 0.95, g, g * 0.75, t * 0.85),
        sdChevron(x, y, g * 0.95 - t * 3.6, g, g * 0.75, t * 0.85),
      );
    }
    case 3: // star: 5-pointed, or a 4-pointed compass star when alt
      return alt ? sdStar(x, y, 4, g * 1.1, g * 0.38) : sdStar(x, y + g * 0.08, 5, g * 1.08, g * 0.48);
    case 4: { // triangle, point to the nose
      const c = sdPoly(x, y + g * 0.15, 3, g * 1.15);
      return alt ? outline(c, band * 1.1) : c;
    }
    case 5: { // cross, or saltire when alt
      const t = Math.max(STROKE / 2 + 0.02, g * 0.24);
      if (!alt) return Math.min(sdBox(x, y, 0, 0, t, g), sdBox(x, y, 0, 0, g, t));
      const s = Math.SQRT1_2;
      const ra = (x + y) * s, rb = (y - x) * s;
      return Math.min(sdBox(ra, rb, 0, 0, t, g * 1.05), sdBox(ra, rb, 0, 0, g * 1.05, t));
    }
    case 6: { // hexagon
      const c = sdPoly(x, y, 6, g);
      return alt ? Math.min(outline(c, band), Math.hypot(x, y) - g * 0.25) : c;
    }
    default: { // spearhead: blade over a stem (alt: with a crossguard)
      const blade = Math.max(halfPlane(x, y, 0, g, g * 0.6, -g * 0.05), -g * 0.05 - y);
      const t = Math.max(STROKE / 2 + 0.01, g * 0.16);
      let s = Math.min(blade, sdBox(x, y, 0, -g * 0.5, t, g * 0.5));
      if (alt) s = Math.min(s, sdBox(x, y, 0, -g * 0.42, g * 0.7, t * 0.85));
      return s;
    }
  }
}

function sdRing(d: SigilDesign, x: number, y: number): number {
  if (d.ringShape === 'circle') {
    const r = Math.hypot(x, y);
    return Math.max(r - d.ringOuter, d.ringInner - r);
  }
  if (d.ringShape === 'polygon') {
    const c = sdPoly(x, y, d.fold, d.ringOuter);
    return outline(c, d.ringOuter - d.ringInner);
  }
  return Infinity;
}

function sdSpokes(d: SigilDesign, x: number, y: number): number {
  const r0 = d.spokeInner, r1 = d.spokeOuter, w = d.spokeWidth;
  switch (d.spokes) {
    case 'bar': {
      const [a, b] = fold(x, y, d.fold);
      return sdBox(a, b, 0, (r0 + r1) / 2, w, (r1 - r0) / 2);
    }
    case 'point':
      return sdStar(x, y, d.fold, r1, r0);
    case 'petal': {
      const [a, b] = fold(x, y, d.fold);
      const mid = r0 + (r1 - r0) * 0.45;
      return Math.max(halfPlane(a, b, 0, r0 - 0.1, w, mid, 0, mid), halfPlane(a, b, w, mid, 0, r1, 0, mid));
    }
    case 'wings': {
      // A swept wing each side: deep at the root by the glyph, blunt raised tip.
      const ax = r0 - 0.05, ay = 0.24, by = -w, tx = 0.86, tTop = 0.3, tBot = 0.04;
      const cx = (ax + tx) / 2, cy = (ay + by + tTop + tBot) / 4;
      return Math.max(
        ax - x,
        x - tx,
        halfPlane(x, y, ax, ay, tx, tTop, cx, cy),
        halfPlane(x, y, ax, by, tx, tBot, cx, cy),
      );
    }
    default:
      return Infinity;
  }
}

/** Signed distance of the whole emblem (negative inside). */
export function sigilDistance(d: SigilDesign, u: number, v: number): number {
  const x = Math.abs(u), y = v;
  const glyph = sdGlyph(d, x, y);
  let rest = Math.min(sdRing(d, x, y), sdSpokes(d, x, y));
  // Knock a gap out around the glyph. Offsetting a max-of-half-planes SDF
  // spikes far past sharp tips, so the halo is also capped by a circle just
  // beyond the glyph's reach.
  if (rest !== Infinity) {
    const halo = Math.max(glyph - d.gap, Math.hypot(x, y) - (d.glyphRadius * GLYPH_REACH + d.gap));
    rest = Math.max(rest, -halo);
  }
  return Math.min(glyph, rest);
}

/** Coverage from a signed distance, antialiased over one texel (`px` in the same units). */
function cover(dist: number, r: number, px: number): number {
  const d = Math.max(dist, r - (1 - px * 0.5));
  const t = Math.min(1, Math.max(0, 0.5 - d / px));
  return t * t * (3 - 2 * t);
}

/**
 * Emblem coverage 0..1 at emblem-local (u, v) in [-1, 1] (v up = nose).
 * `px` = one texel in emblem units (2 / diameter in texels). 0 outside the
 * unit circle; exactly mirror-symmetric about u = 0.
 */
export function sigilCoverage(d: SigilDesign, u: number, v: number, px: number): number {
  const r = Math.hypot(u, v);
  if (r > 1) return 0;
  return cover(sigilDistance(d, u, v), r, px);
}

/** Fallback mark for tiny hulls: one bold chevron pointing at the nose. */
export function sigilChevron(u: number, v: number, px: number): number {
  const r = Math.hypot(u, v);
  if (r > 1) return 0;
  return cover(sdChevron(Math.abs(u), v, 0.62, 0.86, 0.74, 0.21), r, px);
}

/**
 * Largest clear circle: the allowed texel with the greatest distance-field
 * value (texels). Texels within 10% of the best are treated as ties and the
 * one nearest the grid's vertical centreline wins (hulls are mirror-
 * symmetric; an emblem belongs on the centreline). Returns r = 0 when no
 * texel is allowed.
 */
export function largestClearCircle(
  dist: Float32Array,
  mask: Uint8Array | ((i: number) => boolean),
  w: number,
  h: number,
): { x: number; y: number; r: number } {
  const ok = typeof mask === 'function' ? mask : (i: number) => mask[i]! !== 0;
  let best = 0;
  for (let i = 0; i < w * h; i++) if (dist[i]! > best && ok(i)) best = dist[i]!;
  if (best <= 0) return { x: 0, y: 0, r: 0 };
  const cx = (w - 1) / 2, floor = best * 0.9;
  let bx = 0, by = 0, br = 0, bOff = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, r = dist[i]!;
      if (r < floor || !ok(i)) continue;
      const off = Math.abs(x - cx);
      if (off < bOff - 1e-9 || (Math.abs(off - bOff) <= 1e-9 && r > br)) { bx = x; by = y; br = r; bOff = off; }
    }
  }
  return { x: bx, y: by, r: br };
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
export function stampSigils(
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
