/**
 * The cut field (macro terrain plan v2, docs/architecture/macro-terrain.md).
 *
 * An asteroid field is one giant convex shape cut up like a cake: straight
 * cuts, recursively, down to rock-sized pieces (a fracture), then each piece
 * shrunk to leave narrow streets, its edges roughened, and the whole pattern
 * bent by one smooth warp so streets curve together. One or two lanes are cut
 * end to end first and their strip removed; the middle is a hole; toward the
 * rim streets widen and pieces drop out.
 *
 * Deterministic from `(seed, FIELD_LAYOUT_VERSION)` and arithmetic only
 * (`unitDirFromSteps`, value noise, `Math.sqrt` / `Math.floor`; never
 * sin/cos/atan2/pow/hypot or `**`), so the server and every browser engine cut
 * the same rocks. Every cut is seeded by the piece's place in the cut tree,
 * so any region can be cut on its own. Generation-time code, not a hot path.
 */
import { mulberry32 } from '../swarm/asteroidShape.js';
import { ANGLE_STEPS, unitDirFromSteps } from '../geometry/unitDir.js';
import { fnv1a32, fnvMixU32 } from '../random/rng.js';

/** Bump on ANY change to the rocks a seed gives: saved rock records are keyed
 *  by it, and a mismatch discards them. */
export const FIELD_LAYOUT_VERSION = 1;

// ---------------------------------------------------------------- sliced ---
/*
 * Sliced style (owner 2026-11-15): "spawn one gigantic polygon and cut it up
 * like a cake, then sub-divide the cuts into individual asteroids". A field
 * is one big outline, cut by straight lines recursively (a fracture). Every
 * piece's cut is seeded by its PATH in the cut tree, so any region can be
 * cut on its own (lazily, near ships) and gives the same rocks every time.
 * Pieces are shrunk toward their centre to leave narrow "streets" between
 * neighbours; lanes are cut first and their strip removed; the middle is a
 * hole; toward the rim the streets widen and pieces drop out.
 */

type Pt = { x: number; y: number };
export interface SlicedRock {
  verts: Pt[];
  /** Pre-warp centre (chunk membership uses this). */
  cx: number;
  cy: number;
  size: number;
  /** The piece's cut-tree path hash: unique per field, the basis of its key. */
  path: number;
}

export const SLICED = {
  /** Field radius (world u): ~300 km across (owner). */
  radius: 150_000,
  /** Open core (share of radius). */
  holeShare: 0.07,
  /** Lanes: count, width in battleship lengths. */
  lanes: 2,
  laneWidthB: 1.6,
  /** Street (gap between neighbours) at the core, in fighter widths; ×edge. */
  streetFighters: 2,
  streetEdgeMul: 6,
  /** A piece stops being cut below this size (in fighter lengths), random in range. */
  smallMinF: 4,
  smallMaxF: 20,
  /** Edge roughness: midpoint-displacement levels and amplitude (share of edge). */
  roughLevels: 4,
  /** Warp: one smooth displacement field bends every outline (streets curve
   *  together). Two scales: [wavelength, amplitude] in world u. */
  warp: [[6000, 900], [1500, 220]] as const,
  roughAmp: 0.16,
  /** Rare big rocks: a piece of 1–2 battleship lengths stops with this chance. */
  bigChance: 0.04,
  /** Share of pieces kept at the rim (1 at the core). */
  rimKeep: 0.25,
} as const;

function areaOf(p: Pt[]): number { let a = 0; for (let i = 0; i < p.length; i++) { const u = p[i]!, v = p[(i + 1) % p.length]!; a += u.x * v.y - v.x * u.y; } return Math.abs(a) / 2; }
function centroidOf(p: Pt[]): Pt { let x = 0, y = 0; for (const q of p) { x += q.x; y += q.y; } return { x: x / p.length, y: y / p.length }; }

/** Cut a convex polygon by the line through `o` with normal `n`: [front, back]. */
function cutConvex(poly: Pt[], o: Pt, n: Pt): [Pt[], Pt[]] {
  const a: Pt[] = [], b: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const dp = (p.x - o.x) * n.x + (p.y - o.y) * n.y, dq = (q.x - o.x) * n.x + (q.y - o.y) * n.y;
    if (dp >= 0) a.push(p); else b.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      a.push(m); b.push(m);
    }
  }
  return [a, b];
}

/** Shrink a convex polygon by moving each vertex toward the centroid by `d`. */
function inset(poly: Pt[], d: number): Pt[] | null {
  const c = centroidOf(poly);
  const out: Pt[] = [];
  for (const p of poly) {
    const dx = p.x - c.x, dy = p.y - c.y, l = Math.sqrt(dx * dx + dy * dy);
    if (l <= d * 1.5) return null;
    out.push({ x: c.x + dx * (1 - d / l), y: c.y + dy * (1 - d / l) });
  }
  return out;
}

function latticeHash(a: number, b: number, seed: number): number {
  let k = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + seed) | 0;
  k = Math.imul(k ^ (k >>> 13), 1274126177);
  return ((k ^ (k >>> 16)) >>> 0) / 4294967296;
}

/** Smooth seeded value noise in -1..1 (arithmetic only, allocation-free; the
 *  ore map's deposit edges use it too, fieldOre.ts). */
export function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
  const a = latticeHash(xi, yi, seed), b = latticeHash(xi + 1, yi, seed), c = latticeHash(xi, yi + 1, seed), d = latticeHash(xi + 1, yi + 1, seed);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}

/** Bend points by the field's one smooth warp (same everywhere, so neighbours
 *  bend together and streets keep roughly their width). */
function warpAll(pts: Pt[], seed: number): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    let dx = 0, dy = 0;
    for (let k = 0; k < SLICED.warp.length; k++) {
      const [lam, amp] = SLICED.warp[k]!;
      dx += vnoise(p.x / lam, p.y / lam, (seed + k * 7919) | 0) * amp;
      dy += vnoise(p.x / lam + 31.7, p.y / lam - 17.3, (seed + k * 7919 + 1) | 0) * amp;
    }
    out.push({ x: p.x + dx, y: p.y + dy });
  }
  return out;
}

/** Break each edge into wobbly segments (midpoint displacement), pushed mostly
 *  inward so streets stay open: irregular, possibly concave rock outlines.
 *  `levels` halvings (rocks: `SLICED.roughLevels`; far-zoom pieces: 1). */
function roughen(poly: Pt[], path: number, rnd: (path: number, k: number) => number, levels: number = SLICED.roughLevels): Pt[] {
  let pts = poly;
  const c = centroidOf(poly);
  for (let lvl = 0; lvl < levels; lvl++) {
    const next: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
      next.push(p);
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const ex = q.x - p.x, ey = q.y - p.y, el = Math.sqrt(ex * ex + ey * ey);
      if (el < 1e-6) continue;
      // Edge normal pointing away from the centre.
      let nx = ey / el, ny = -ex / el;
      if ((mx - c.x) * nx + (my - c.y) * ny < 0) { nx = -nx; ny = -ny; }
      const r = rnd(path, 100 + lvl * 997 + i) - 0.7; // mostly inward
      const amp = el * SLICED.roughAmp * r;
      next.push({ x: mx + nx * amp, y: my + ny * amp });
    }
    pts = next;
  }
  return pts;
}

export interface SlicedOpts {
  seed: string;
  battleshipLength: number;
  fighterLength: number;
  /** Only pieces touching this box are cut down to rocks (lazy); others stop. */
  view: { x0: number; y0: number; x1: number; y1: number };
  /** Pieces smaller than this are not cut further (far-zoom level of detail):
   *  such a piece is kept whole (no rim drop, no street inset) and roughened
   *  one level, so it covers where its rocks are. Never saved or keyed. */
  minSize?: number;
  /** Field radius override (tests); default `SLICED.radius`. */
  radius?: number;
  /** Only rocks whose pre-warp centre is in this half-open box (a chunk).
   *  Same rocks as cutting everything and filtering, much less work: a cut
   *  child lies inside its parent, so a piece whose box misses `own` holds no
   *  member and is dropped before it is cut or finished. */
  own?: { x0: number; y0: number; x1: number; y1: number };
}

/** A child's path in the cut tree: the parent's hash mixed with the depth and
 *  the side, so paths never collide the way `path * 31 + k` did. */
function childPath(path: number, depth: number, k: number): number {
  return fnvMixU32(fnvMixU32(path, depth + 1), k + 1);
}

/** How far the warp plus the roughening can move a vertex: pieces up to this
 *  far outside a view box can still land inside it. */
export function cutFieldPad(): number {
  let p = 0;
  for (const [, amp] of SLICED.warp) p += amp;
  return p * 1.05;
}

/** The rocks of a sliced field inside `view`. Generation-time code, not a hot path. */
/** A lane: the strip of points within `half` of the line through `o` with
 *  unit normal `n` (its direction is (n.y, -n.x)). Before the warp, which
 *  bends lane walls by up to ~1.1 km. */
export interface FieldLane { o: Pt; n: Pt; half: number }

function laneStrips(R: number, B: number, rnd: (path: number, k: number) => number): FieldLane[] {
  const dir = { x: 0, y: 0 };
  const lanes: FieldLane[] = [];
  for (let l = 0; l < SLICED.lanes; l++) {
    unitDirFromSteps(rnd(1000 + l, 1) * ANGLE_STEPS, dir);
    const n = { x: -dir.y, y: dir.x };
    const off = (rnd(1000 + l, 2) - 0.5) * R * 0.5;
    lanes.push({ o: { x: n.x * off, y: n.y * off }, n, half: (SLICED.laneWidthB * B) / 2 });
  }
  return lanes;
}

/** The field's lanes (test rooms and shots place ships in them). */
export function slicedFieldLanes(o: Pick<SlicedOpts, 'seed' | 'battleshipLength' | 'radius'>): FieldLane[] {
  const base = fnv1a32(`sliced:${o.seed}`);
  const rnd = (path: number, k: number): number => mulberry32((Math.imul(path, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b) ^ base) >>> 0)();
  return laneStrips(o.radius ?? SLICED.radius, o.battleshipLength, rnd);
}

export function slicedField(o: SlicedOpts): SlicedRock[] {
  const S = SLICED, R = o.radius ?? S.radius, B = o.battleshipLength, F = o.fighterLength;
  const base = fnv1a32(`sliced:${o.seed}`);
  const rnd = (path: number, k: number): number => mulberry32((Math.imul(path, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b) ^ base) >>> 0)();
  const dir = { x: 0, y: 0 };
  // Field outline: a 64-gon with a low-frequency wobble.
  const outline: Pt[] = [];
  for (let i = 0; i < 64; i++) {
    unitDirFromSteps((i / 64) * ANGLE_STEPS, dir);
    // Convex on purpose: the cuts assume convex pieces. The field's ragged
    // edge comes from rim thinning and the warp, not from the outline.
    outline.push({ x: dir.x * R, y: dir.y * R });
  }
  // Lanes: straight strips end to end through the field, cut first.
  const lanes = laneStrips(R, B, rnd);
  const inLane = (p: Pt): boolean => lanes.some((ln) => Math.abs((p.x - ln.o.x) * ln.n.x + (p.y - ln.o.y) * ln.n.y) < ln.half);
  const pad = cutFieldPad();
  const touchesView = (poly: Pt[]): boolean => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    // Padded by how far warp + roughening can move a vertex, so a rock whose
    // final outline reaches into the view is never culled at its edge.
    return x1 + pad >= o.view.x0 && x0 - pad <= o.view.x1 && y1 + pad >= o.view.y0 && y0 - pad <= o.view.y1;
  };

  const out: SlicedRock[] = [];
  const stack: Array<{ poly: Pt[]; path: number; depth: number }> = [{ poly: outline, path: 1, depth: 0 }];
  // Lane walls are the first cuts (2 per lane), so lanes have straight walls.
  for (const ln of lanes) {
    const next: typeof stack = [];
    for (const s of stack) {
      const [a, b] = cutConvex(s.poly, { x: ln.o.x + ln.n.x * ln.half, y: ln.o.y + ln.n.y * ln.half }, ln.n);
      for (const [p, k] of [[a, 0], [b, 1]] as const) {
        if (p.length < 3) continue;
        const [c, d] = cutConvex(p, { x: ln.o.x - ln.n.x * ln.half, y: ln.o.y - ln.n.y * ln.half }, ln.n);
        if (c.length >= 3) next.push({ poly: c, path: childPath(s.path, s.depth, k * 2), depth: s.depth + 1 });
        if (d.length >= 3) next.push({ poly: d, path: childPath(s.path, s.depth, k * 2 + 1), depth: s.depth + 1 });
      }
    }
    stack.length = 0; stack.push(...next);
  }
  const own = o.own;
  const missesOwn = (poly: Pt[]): boolean => {
    if (!own) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return x1 < own.x0 || x0 >= own.x1 || y1 < own.y0 || y0 >= own.y1;
  };
  while (stack.length > 0) {
    const { poly, path, depth } = stack.pop()!;
    if (missesOwn(poly)) continue;
    const c = centroidOf(poly);
    if (inLane(c)) continue; // the lane strip itself
    const size = Math.sqrt(areaOf(poly));
    const d = Math.sqrt(c.x * c.x + c.y * c.y) / R; // 0 core .. ~1 rim
    if (d < S.holeShare && size < R * 0.2) continue; // the open core
    const small = F * (S.smallMinF + (S.smallMaxF - S.smallMinF) * rnd(path, 3));
    const bigStop = size <= 2 * B && size >= B && rnd(path, 4) < S.bigChance;
    const lodStop = o.minSize !== undefined && size < o.minSize;
    if (size <= small || bigStop || lodStop || depth > 40 || !touchesView(poly)) {
      if (!touchesView(poly)) continue;
      if (own && !(c.x >= own.x0 && c.x < own.x1 && c.y >= own.y0 && c.y < own.y1)) continue;
      if (lodStop && size > small && !bigStop) {
        // A far-zoom piece, not a rock: kept whole so it covers its rocks.
        out.push({ verts: warpAll(roughen(poly, path, rnd, 1), base), cx: c.x, cy: c.y, size, path });
        continue;
      }
      // Thin out toward the rim (smoothly), wider streets there.
      const keep = S.rimKeep + (1 - S.rimKeep) * (1 - d * d);
      if (rnd(path, 5) > keep) continue;
      const street = F * S.streetFighters * (1 + (S.streetEdgeMul - 1) * d * d);
      const v = inset(poly, street / 2);
      if (v) out.push({ verts: warpAll(roughen(v, path, rnd), base), cx: c.x, cy: c.y, size, path });
      continue;
    }
    // Cut ACROSS the piece's longest dimension (no slivers), at a seeded
    // point between 35% and 65% along it, the angle jittered a little.
    // Children's paths extend the parent's, so any piece re-cuts on its own.
    let ai = 0, bi = 0, best = -1;
    for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) {
      const dx = poly[j]!.x - poly[i]!.x, dy = poly[j]!.y - poly[i]!.y, dd = dx * dx + dy * dy;
      if (dd > best) { best = dd; ai = i; bi = j; }
    }
    const P = poly[ai]!, Q = poly[bi]!, L = Math.sqrt(best);
    const t = 0.35 + 0.3 * rnd(path, 2);
    const pc = { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t };
    // Normal along the long axis, turned by up to ±0.35 rad (small-angle rotation).
    const ax = (Q.x - P.x) / L, ay = (Q.y - P.y) / L, tw = (rnd(path, 1) - 0.5) * 0.7;
    const nlen = Math.sqrt(1 + tw * tw);
    const nrm = { x: (ax - tw * ay) / nlen, y: (ay + tw * ax) / nlen };
    const [a, b] = cutConvex(poly, pc, nrm);
    const pa = childPath(path, depth, 0), pb = childPath(path, depth, 1);
    if (a.length >= 3) stack.push({ poly: a, path: pa, depth: depth + 1 });
    if (b.length >= 3) stack.push({ poly: b, path: pb, depth: depth + 1 });
  }
  return out;
}

// ---------------------------------------------------------------- chunks ---
/*
 * Chunks and rock keys (macro terrain plan v2, A2). The field is split into a
 * fixed grid of square chunks. A rock belongs to the chunk holding its
 * pre-warp centre, and its key is (chunk x, chunk y, index): the index is the
 * rock's rank by cut path within its chunk, so it is the same whether one
 * chunk or the whole field is cut, and whatever else was cut before.
 */

/** Chunk side in world units (~4 km). Part of the layout: changing it renames
 *  every rock, so bump FIELD_LAYOUT_VERSION with it. */
/** How far a rock's collider may stray from its drawn outline, as a share of
 *  the radius of a circle with the rock's area (not its bounding radius, which
 *  a long thin rock inflates): bumps and dents shallower than this are
 *  smoothed over before the outline is split into convex parts
 *  (`convexParts`). Keeps a rock at about 4.5 parts (at most 9) instead of
 *  about 25, area within 4.8 % (measured on 644 rocks, two seeds).
 *  docs/architecture/macro-terrain.md. */
export const FIELD_COLLIDER_SIMPLIFY = 0.06;

export const CHUNK_SIZE = 4096;
/** Chunk coordinates fit a signed byte: ±128 chunks = ±524 km, past any sector. */
const CHUNK_COORD_BIAS = 128;
/** Index within a chunk fits 16 bits. */
export const MAX_ROCKS_PER_CHUNK = 0xffff;

export interface ChunkRock extends SlicedRock {
  /** Index within the chunk (rank by cut path). */
  index: number;
  /** Packed rock key: chunk x, chunk y, index (see `rockKey`). */
  key: number;
}

/** The chunk a world point falls in. */
export function chunkOf(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) };
}

/** Pack (chunk x, chunk y, index) into one u32: 8 + 8 + 16 bits. */
export function rockKey(cx: number, cy: number, index: number): number {
  return ((((cx + CHUNK_COORD_BIAS) & 0xff) << 24) | (((cy + CHUNK_COORD_BIAS) & 0xff) << 16) | (index & 0xffff)) >>> 0;
}

/** Unpack a rock key. */
export function unpackRockKey(key: number): { cx: number; cy: number; index: number } {
  return { cx: ((key >>> 24) & 0xff) - CHUNK_COORD_BIAS, cy: ((key >>> 16) & 0xff) - CHUNK_COORD_BIAS, index: key & 0xffff };
}

export interface ChunkOpts {
  seed: string;
  battleshipLength: number;
  fighterLength: number;
  /** Field radius override (tests); default `SLICED.radius`. */
  radius?: number;
}

/**
 * The rocks of one chunk, at full detail, each with its canonical index and
 * key. Generation-time code (never per frame): the client runs it off the
 * frame, the server on wake.
 */
export function rocksInChunk(o: ChunkOpts, cx: number, cy: number): ChunkRock[] {
  const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
  const cut = slicedField({
    seed: o.seed, battleshipLength: o.battleshipLength, fighterLength: o.fighterLength,
    view: { x0, y0, x1: x0 + CHUNK_SIZE, y1: y0 + CHUNK_SIZE },
    own: { x0, y0, x1: x0 + CHUNK_SIZE, y1: y0 + CHUNK_SIZE },
    ...(o.radius !== undefined ? { radius: o.radius } : {}),
  });
  // Members: pre-warp centre inside this chunk (half-open, so each rock has
  // exactly one chunk). Neighbours' rocks that reach in belong to them.
  const mine = cut.filter((r) => r.cx >= x0 && r.cx < x0 + CHUNK_SIZE && r.cy >= y0 && r.cy < y0 + CHUNK_SIZE);
  mine.sort((a, b) => (a.path >>> 0) - (b.path >>> 0));
  if (mine.length > MAX_ROCKS_PER_CHUNK) throw new Error(`chunk ${cx},${cy} holds ${mine.length} rocks (max ${MAX_ROCKS_PER_CHUNK})`);
  return mine.map((r, index) => ({ ...r, index, key: rockKey(cx, cy, index) }));
}

// --------------------------------------------------------------- far zoom ---
/*
 * Far zoom (plan v2, B4): the whole field cut only down to
 * `FIELD_COARSE_MIN_SIZE`, grouped into tiles of `COARSE_TILE_CHUNKS` x
 * `COARSE_TILE_CHUNKS` chunks by pre-warp centre (as `rocksInChunk` assigns
 * rocks to chunks). Drawn instead of the rocks when they are a few pixels
 * across. docs/architecture/macro-terrain.md#far-zoom-b4.
 */

/** Far-zoom piece size (world u): pieces below it are not cut further. */
export const FIELD_COARSE_MIN_SIZE = 2048;
/** A far-zoom tile is this many chunks on a side. */
export const COARSE_TILE_CHUNKS = 8;

export interface CoarseTile { tx: number; ty: number; pieces: SlicedRock[] }

/** The whole field's far-zoom pieces by tile (tiles in (ty, tx) order, pieces
 *  by cut path). Generation-time code, not a hot path. */
export function coarseFieldTiles(o: ChunkOpts): CoarseTile[] {
  const R = (o.radius ?? SLICED.radius) + cutFieldPad();
  const pieces = slicedField({
    seed: o.seed, battleshipLength: o.battleshipLength, fighterLength: o.fighterLength,
    view: { x0: -R, y0: -R, x1: R, y1: R }, minSize: FIELD_COARSE_MIN_SIZE,
    ...(o.radius !== undefined ? { radius: o.radius } : {}),
  });
  const byTile = new Map<string, CoarseTile>();
  for (const p of pieces) {
    const c = chunkOf(p.cx, p.cy);
    const tx = Math.floor(c.cx / COARSE_TILE_CHUNKS), ty = Math.floor(c.cy / COARSE_TILE_CHUNKS);
    const k = `${tx},${ty}`;
    let t = byTile.get(k);
    if (!t) { t = { tx, ty, pieces: [] }; byTile.set(k, t); }
    t.pieces.push(p);
  }
  const tiles = [...byTile.values()].sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  for (const t of tiles) t.pieces.sort((a, b) => (a.path >>> 0) - (b.path >>> 0));
  return tiles;
}
