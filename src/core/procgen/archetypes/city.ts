/**
 * CITY archetype — avenues you can fly down, blocks of towers, a central plaza
 * (method: docs/architecture/procedural-bases-research.md §3.2).
 *
 *  1. GRID-BLEND street network grown OUTWARD from a central plaza block, so
 *     the plaza is the true centre: blocks 1100–1700 u (700–1000 u in small
 *     cities) separated by avenues 2.5 corridors wide, inside a ring road. No
 *     perimeter wall: a city is open from every side.
 *  2. The centre block is the PLAZA: open paved floor, a spire landmark at its
 *     heart, light pylons on an integer ring table (big plazas only).
 *  3. Every other block is subdivided Parish–Müller style: split the longer
 *     side (seeded 35–65 %) with an alley exactly one corridor wide until lots
 *     are ≤ 600 u; ~20 % of mid-size lots stop early (categorized lot sizes).
 *  4. Each lot becomes a building inset 16–40 u; ~6 % are open courtyards.
 *     Districts are measured from the plaza's edge: a TOWER core (towers on
 *     habitat podium wings — touching masses, one building, stepped skyline),
 *     a habitat ring (a third with a tower section), low outskirts with yards.
 *
 * Small cities (inner half-extent < 2000 u) shrink the plaza and blocks so
 * they still get a ring of blocks — the first cut at 5000 u was one lonely
 * plaza block (3.4 % coverage). Coverage is locked in generateCity.test.ts.
 *
 * Integer units, 90° geometry only, named RNG streams.
 */
import { basePieceIndex } from '../../../shared-types/basePieceKinds.js';
import { MIN_WALL_THICKNESS } from '../../../shared-types/baseBudgets.js';
import type { BaseDescriptor } from '../baseLayout.js';
import { LayoutBuilder } from '../baseLayout.js';
import { CORRIDOR_WIDTH } from '../corridor.js';
import { stream, type Rng } from '../rng.js';
import { footprintHalf } from './warehouse.js';

const HABITAT = basePieceIndex('habitat_block');
const TOWER = basePieceIndex('tower');
const PLAZA = basePieceIndex('plaza');
const SPIRE = basePieceIndex('spire');
const PYLON = basePieceIndex('light_pylon');

const AVENUE = Math.round(2.5 * CORRIDOR_WIDTH);
const STREET = CORRIDOR_WIDTH; // alleys at exactly the fly-through floor
/** Lots stop splitting below this side length. */
const MAX_LOT = 600;
const MIN_LOT = 260;
/** Half-side of the central plaza block (large cities / small cities). */
const PLAZA_HALF = 640;
const PLAZA_HALF_SMALL = 360;
/** Below this inner half-extent a city uses the small plaza + small blocks. */
const SMALL_CITY_INNER = 2000;

export const CITY_MIN_SIZE = 5000;

/** 8-direction unit ring ×1000 (integer — no trig at generation time). */
const RING8 = [
  [1000, 0], [707, 707], [0, 1000], [-707, 707], [-1000, 0], [-707, -707], [0, -1000], [707, -707],
] as const;

interface Rect { x0: number; y0: number; x1: number; y1: number }

/**
 * Block edges along one axis, growing OUTWARD from the central plaza block
 * [-PLAZA_HALF, PLAZA_HALF] so the plaza is the true centre: returns sorted
 * [blockStart, blockEnd, blockStart, blockEnd, …] with avenues in the gaps.
 */
function plazaHalf(innerHi: number): number {
  return innerHi < SMALL_CITY_INNER ? PLAZA_HALF_SMALL : PLAZA_HALF;
}

function blockEdges(lo: number, hi: number, rng: Rng): number[] {
  // Small cities scale the plaza and blocks down so they still get a ring of
  // blocks around the plaza instead of one lonely block.
  const small = hi < SMALL_CITY_INNER;
  const ph = plazaHalf(hi);
  const bMin = small ? 700 : 1100, bMax = small ? 1000 : 1700;
  const edges: number[] = [-ph, ph];
  let at = ph + AVENUE;
  while (at + 500 <= hi) {
    const end = Math.min(hi, at + rng.int(bMin, bMax));
    edges.push(at, Math.floor(end / 8) * 8);
    at = end + AVENUE;
  }
  at = -ph - AVENUE;
  while (at - 500 >= lo) {
    const start = Math.max(lo, at - rng.int(bMin, bMax));
    edges.unshift(Math.floor(start / 8) * 8, at);
    at = start - AVENUE;
  }
  return edges;
}

export function generateCity(desc: BaseDescriptor, seed: number): LayoutBuilder {
  if (desc.size < CITY_MIN_SIZE) throw new RangeError(`city size ${desc.size} < ${CITY_MIN_SIZE}`);
  const half = footprintHalf(desc.size);
  const b = new LayoutBuilder(half);
  const gridRng = stream(seed, 'city.grid');
  const lotRng = stream(seed, 'city.lots');
  const bldRng = stream(seed, 'city.buildings');

  // An outer ring road keeps the edge open; blocks live inside it.
  const inner: Rect = { x0: -half + AVENUE, y0: -half + AVENUE, x1: half - AVENUE, y1: half - AVENUE };
  const xs = blockEdges(inner.x0, inner.x1, gridRng);
  const ys = blockEdges(inner.y0, inner.y1, gridRng);
  const blocks: Rect[] = [];
  for (let iy = 0; iy < ys.length; iy += 2) {
    for (let ix = 0; ix < xs.length; ix += 2) blocks.push({ x0: xs[ix]!, y0: ys[iy]!, x1: xs[ix + 1]!, y1: ys[iy + 1]! });
  }
  // Plaza = the block whose centre is nearest the city centre (only when the
  // city has enough blocks to spare one).
  let plazaIdx = blocks.length >= 4 ? 0 : -1;
  let bestD = Infinity;
  for (let i = 0; i < blocks.length && plazaIdx >= 0; i++) {
    const bl = blocks[i]!;
    const d = Math.abs(bl.x0 + bl.x1) + Math.abs(bl.y0 + bl.y1);
    if (d < bestD) { bestD = d; plazaIdx = i; }
  }
  // Districts are measured from the plaza's edge: the first ring of blocks is
  // the tower core, then habitat, then low outskirts.
  const small = inner.x1 < SMALL_CITY_INNER;
  const coreR = plazaHalf(inner.x1) + AVENUE + (small ? 350 : 800);
  const midR = Math.max(coreR + 500, Math.floor(half * 0.72));

  for (let i = 0; i < blocks.length; i++) {
    const bl = blocks[i]!;
    if (i === plazaIdx) {
      buildPlaza(b, bl, bldRng);
      continue;
    }
    const lots: Rect[] = [];
    splitLot(bl, lotRng, lots, 0);
    for (const lot of lots) building(b, lot, bldRng, coreR, midR);
  }
  return b;
}

/** Parish–Müller: split the longer side with a street until lots are small. */
function splitLot(r: Rect, rng: Rng, out: Rect[], depth: number): void {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const big = Math.max(w, h);
  // Categorized sizes: some large lots stop early (≈ 20 %).
  const stopEarly = depth > 0 && big <= 2 * MAX_LOT && rng.chance(1, 5);
  if (big <= MAX_LOT || stopEarly || Math.min(w, h) < MIN_LOT || depth > 6) {
    out.push(r);
    return;
  }
  const alongX = w >= h;
  const span = alongX ? w : h;
  const cut = Math.floor((span * rng.int(35, 65)) / 100 / 8) * 8;
  if (cut < MIN_LOT || span - cut - STREET < MIN_LOT) {
    out.push(r);
    return;
  }
  if (alongX) {
    splitLot({ x0: r.x0, y0: r.y0, x1: r.x0 + cut, y1: r.y1 }, rng, out, depth + 1);
    splitLot({ x0: r.x0 + cut + STREET, y0: r.y0, x1: r.x1, y1: r.y1 }, rng, out, depth + 1);
  } else {
    splitLot({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y0 + cut }, rng, out, depth + 1);
    splitLot({ x0: r.x0, y0: r.y0 + cut + STREET, x1: r.x1, y1: r.y1 }, rng, out, depth + 1);
  }
}

function building(b: LayoutBuilder, lot: Rect, rng: Rng, coreR: number, midR: number): void {
  // Courtyards: deliberate negative space (≈ 7 %).
  if (rng.chance(1, 16)) {
    b.addRect(PLAZA, lot.x0, lot.y0, lot.x1, lot.y1);
    return;
  }
  const inset = rng.int(16, 40);
  const x0 = lot.x0 + inset, y0 = lot.y0 + inset, x1 = lot.x1 - inset, y1 = lot.y1 - inset;
  if (x1 - x0 < MIN_WALL_THICKNESS * 3 || y1 - y0 < MIN_WALL_THICKNESS * 3) return;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const d = Math.max(Math.abs(cx), Math.abs(cy));
  if (d < coreR) {
    // Core: a tower, often on a habitat podium wing (touching masses read as
    // one building with a stepped skyline).
    massing(b, x0, y0, x1, y1, rng, TOWER, rng.chance(1, 2) ? HABITAT : TOWER);
  } else if (d < midR) {
    // Habitat ring: slab blocks, a third with a tower section.
    if (rng.chance(1, 3)) massing(b, x0, y0, x1, y1, rng, TOWER, HABITAT);
    else b.addRect(HABITAT, x0, y0, x1, y1);
  } else {
    // Outskirts: a lower, smaller block with an open yard beside it.
    const alongX = x1 - x0 >= y1 - y0;
    const cut = Math.floor(((alongX ? x1 - x0 : y1 - y0) * rng.int(55, 75)) / 100);
    if (alongX) b.addRect(HABITAT, x0, y0, x0 + cut, y1);
    else b.addRect(HABITAT, x0, y0, x1, y0 + cut);
  }
}

/**
 * Split a building along its long axis into a centre mass of `centre` kind
 * with wings of `wing` kind either side (all touching — the union outline is
 * one building). Short buildings stay a single mass.
 */
function massing(b: LayoutBuilder, x0: number, y0: number, x1: number, y1: number, rng: Rng, centre: number, wing: number): void {
  const alongX = x1 - x0 >= y1 - y0;
  const span = alongX ? x1 - x0 : y1 - y0;
  if (span < 420 || centre === wing) {
    b.addRect(centre, x0, y0, x1, y1);
    return;
  }
  const lo = alongX ? x0 : y0;
  const a = lo + Math.floor((span * rng.int(20, 35)) / 100 / 8) * 8;
  const c = lo + Math.floor((span * rng.int(65, 80)) / 100 / 8) * 8;
  if (alongX) {
    b.addRect(wing, x0, y0, a, y1);
    b.addRect(centre, a, y0, c, y1);
    b.addRect(wing, c, y0, x1, y1);
  } else {
    b.addRect(wing, x0, y0, x1, a);
    b.addRect(centre, x0, a, x1, c);
    b.addRect(wing, x0, c, x1, y1);
  }
}

function buildPlaza(b: LayoutBuilder, bl: Rect, rng: Rng): void {
  b.addRect(PLAZA, bl.x0, bl.y0, bl.x1, bl.y1);
  const cx = Math.floor((bl.x0 + bl.x1) / 2 / 8) * 8;
  const cy = Math.floor((bl.y0 + bl.y1) / 2 / 8) * 8;
  const side = Math.min(bl.x1 - bl.x0, bl.y1 - bl.y0);
  const s = side < 1000 ? rng.int(90, 130) : rng.int(140, 200);
  b.addRect(SPIRE, cx - s, cy - s, cx + s, cy + s);
  const ringR = Math.min(bl.x1 - bl.x0, bl.y1 - bl.y0) / 2 - 220;
  if (ringR < s + 200) return;
  const p = 40;
  for (const [ux, uy] of RING8) {
    const px = cx + Math.round((ux * ringR) / 1000);
    const py = cy + Math.round((uy * ringR) / 1000);
    b.addRect(PYLON, px - p, py - p, px + p, py + p);
  }
}
