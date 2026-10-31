/**
 * WAREHOUSE archetype — endless storage rows you can fly down
 * (method: docs/architecture/procedural-bases-research.md §3.1).
 *
 * Deterministic aisle carving on a block grid:
 *  1. square footprint inscribed in the size disc, perimeter wall with 2–4 gates;
 *  2. a perimeter road inside the wall, then seeded MAIN cross-aisles that cut
 *     the interior into zones;
 *  3. each zone fills with rack rows along its long axis, corridor-width aisles
 *     between rows and seeded secondary cross-aisles; every row segment between
 *     cross-aisles is ONE merged rectangle (greedy merge by construction);
 *  4. a loading bay (floor) in front of every gate, lined with container stacks.
 *
 * Integer units only; every random number comes from a named stream.
 */
import { basePieceIndex } from '../../../shared-types/basePieceKinds.js';
import { MIN_WALL_THICKNESS } from '../../../shared-types/baseBudgets.js';
import type { BaseDescriptor } from '../baseLayout.js';
import { LayoutBuilder } from '../baseLayout.js';
import { CORRIDOR_WIDTH } from '../corridor.js';
import { stream } from '../rng.js';

const WALL = basePieceIndex('wall');
const RACK = basePieceIndex('rack_row');
const CONTAINER = basePieceIndex('container_stack');
const BAY = basePieceIndex('loading_bay');
const POST = basePieceIndex('gate_post');

// SCALE (user feedback 2026-10-31: "structures should be a lot larger than the
// normal ship"). A fighter is ~30 u long; industrial architecture should read
// at 10–15× that. Every corridor stays ≥ CORRIDOR_WIDTH (the locked fly-through
// floor) — aisles are now 2–3× it, so the bigger yard is also easier to fly.
/** Perimeter wall thickness. */
const WALL_T = Math.max(MIN_WALL_THICKNESS, 96);
const GATE_W = 5 * CORRIDOR_WIDTH;
const MAIN_AISLE = 4 * CORRIDOR_WIDTH;
const BAY_DEPTH = 1400;
/** Bay overhang either side of a gate (where container stacks line up). */
const BAY_MARGIN = 400;
/** Perimeter road between the wall and the racks. */
const PERIMETER_ROAD = 2 * CORRIDOR_WIDTH;

/** Smallest footprint the warehouse layout reads well at (and validates). */
export const WAREHOUSE_MIN_SIZE = 5000;

interface Rect { x0: number; y0: number; x1: number; y1: number }
/** A loading bay; ships travel through it along y when its gate is in a
 *  horizontal (bottom/top) wall, along x otherwise. */
interface Bay extends Rect { travelAlongY: boolean }

/** Inscribed square half-side for a disc of diameter `size` (integer, /8 grid). */
export function footprintHalf(size: number): number {
  return Math.floor((size * 7071) / 20000 / 8) * 8;
}

export function generateWarehouse(desc: BaseDescriptor, seed: number): LayoutBuilder {
  if (desc.size < WAREHOUSE_MIN_SIZE) throw new RangeError(`warehouse size ${desc.size} < ${WAREHOUSE_MIN_SIZE}`);
  const half = footprintHalf(desc.size);
  const b = new LayoutBuilder(half);
  const gatesRng = stream(seed, 'warehouse.gates');
  const zonesRng = stream(seed, 'warehouse.zones');
  const rowsRng = stream(seed, 'warehouse.rows');
  const bayRng = stream(seed, 'warehouse.bays');

  // ── 1. Perimeter + gates ───────────────────────────────────────────────
  // Sides: 0 = bottom (-y), 1 = right (+x), 2 = top (+y), 3 = left (-x).
  const gateCount = gatesRng.int(2, 4);
  const sides = [0, 1, 2, 3];
  for (let i = sides.length - 1; i > 0; i--) {
    const j = gatesRng.int(0, i);
    const t = sides[i]!; sides[i] = sides[j]!; sides[j] = t;
  }
  const gateSides = sides.slice(0, gateCount).sort((a, c) => a - c);
  const span = 2 * half;
  const gateOffset: number[] = [0, 0, 0, 0]; // along-side centre, -1 = no gate
  for (let s = 0; s < 4; s++) gateOffset[s] = -1;
  for (const s of gateSides) {
    // Gate centre in the middle 60 % of the side, on an 8 u grid.
    const lo = -half + Math.floor(span * 0.2);
    const hi = half - Math.floor(span * 0.2);
    gateOffset[s] = Math.floor(gatesRng.int(lo, hi) / 8) * 8;
  }

  const bays: Bay[] = [];
  for (let s = 0; s < 4; s++) {
    const g = gateOffset[s]!;
    const horizontal = s === 0 || s === 2;
    const fixed0 = s === 0 ? -half : s === 2 ? half - WALL_T : s === 3 ? -half : half - WALL_T;
    if (gateOffset[s] === -1) {
      if (horizontal) b.addRect(WALL, -half, fixed0, half, fixed0 + WALL_T);
      else b.addRect(WALL, fixed0, -half + WALL_T, fixed0 + WALL_T, half - WALL_T);
      continue;
    }
    const gLo = g - GATE_W / 2;
    const gHi = g + GATE_W / 2;
    const post = WALL_T * 2;
    if (horizontal) {
      b.addRect(WALL, -half, fixed0, gLo - post, fixed0 + WALL_T);
      b.addRect(WALL, gHi + post, fixed0, half, fixed0 + WALL_T);
      b.addRect(POST, gLo - post, fixed0 - (s === 2 ? WALL_T : 0), gLo, fixed0 + WALL_T + (s === 0 ? WALL_T : 0));
      b.addRect(POST, gHi, fixed0 - (s === 2 ? WALL_T : 0), gHi + post, fixed0 + WALL_T + (s === 0 ? WALL_T : 0));
      b.addGate(g, s === 0 ? -half : half);
      const by0 = s === 0 ? -half + WALL_T : half - WALL_T - BAY_DEPTH;
      bays.push({ x0: gLo - BAY_MARGIN, y0: by0, x1: gHi + BAY_MARGIN, y1: by0 + BAY_DEPTH, travelAlongY: true });
    } else {
      b.addRect(WALL, fixed0, -half + WALL_T, fixed0 + WALL_T, gLo - post);
      b.addRect(WALL, fixed0, gHi + post, fixed0 + WALL_T, half - WALL_T);
      b.addRect(POST, fixed0 - (s === 1 ? WALL_T : 0), gLo - post, fixed0 + WALL_T + (s === 3 ? WALL_T : 0), gLo);
      b.addRect(POST, fixed0 - (s === 1 ? WALL_T : 0), gHi, fixed0 + WALL_T + (s === 3 ? WALL_T : 0), gHi + post);
      b.addGate(s === 3 ? -half : half, g);
      const bx0 = s === 3 ? -half + WALL_T : half - WALL_T - BAY_DEPTH;
      bays.push({ x0: bx0, y0: gLo - BAY_MARGIN, x1: bx0 + BAY_DEPTH, y1: gHi + BAY_MARGIN, travelAlongY: false });
    }
  }

  // ── 4 (placed first so racks avoid them). Loading bays + containers ─────
  const bayKeepOut: Rect[] = [];
  for (const raw of bays) {
    // Keep every bay inside the walls (small footprints / gates near a corner).
    const lim = half - WALL_T;
    const bay: Bay = {
      x0: Math.max(raw.x0, -lim), y0: Math.max(raw.y0, -lim),
      x1: Math.min(raw.x1, lim), y1: Math.min(raw.y1, lim),
      travelAlongY: raw.travelAlongY,
    };
    b.addRect(BAY, bay.x0, bay.y0, bay.x1, bay.y1);
    bayKeepOut.push({ x0: bay.x0 - CORRIDOR_WIDTH, y0: bay.y0 - CORRIDOR_WIDTH, x1: bay.x1 + CORRIDOR_WIDTH, y1: bay.y1 + CORRIDOR_WIDTH });
    // Container stacks line the two bay edges PARALLEL to the travel
    // direction (inside the BAY_MARGIN either side of the gate), so the
    // gate → interior lane stays clear.
    const wide = !bay.travelAlongY;
    const stackLen = bayRng.int(240, 400);
    const stackDepth = bayRng.int(140, 220);
    const gap = 48;
    if (wide) {
      for (let x = bay.x0; x + stackLen <= bay.x1; x += stackLen + gap) {
        b.addRect(CONTAINER, x, bay.y0, x + stackLen, bay.y0 + stackDepth);
        b.addRect(CONTAINER, x, bay.y1 - stackDepth, x + stackLen, bay.y1);
      }
    } else {
      for (let y = bay.y0; y + stackLen <= bay.y1; y += stackLen + gap) {
        b.addRect(CONTAINER, bay.x0, y, bay.x0 + stackDepth, y + stackLen);
        b.addRect(CONTAINER, bay.x1 - stackDepth, y, bay.x1, y + stackLen);
      }
    }
  }

  // ── 2. Interior + main cross-aisles → zones ────────────────────────────
  const inner: Rect = {
    x0: -half + WALL_T + PERIMETER_ROAD,
    y0: -half + WALL_T + PERIMETER_ROAD,
    x1: half - WALL_T - PERIMETER_ROAD,
    y1: half - WALL_T - PERIMETER_ROAD,
  };
  const cutsX = cuts(inner.x0, inner.x1, zonesRng);
  const cutsY = cuts(inner.y0, inner.y1, zonesRng);
  const xs = [inner.x0, ...cutsX.flatMap((c) => [c, c + MAIN_AISLE]), inner.x1];
  const ys = [inner.y0, ...cutsY.flatMap((c) => [c, c + MAIN_AISLE]), inner.y1];

  // ── 3. Rack rows per zone ──────────────────────────────────────────────
  // ONE seeded row direction for the whole warehouse (a real warehouse's racks
  // all run the same way — mixed directions read as clutter, not "endless
  // rows"); ~1 zone in 8 turns 90° as a deliberate accent.
  const baseAlongX = rowsRng.chance(1, 2);
  for (let iy = 0; iy < ys.length; iy += 2) {
    for (let ix = 0; ix < xs.length; ix += 2) {
      const z: Rect = { x0: xs[ix]!, y0: ys[iy]!, x1: xs[ix + 1]!, y1: ys[iy + 1]! };
      const alongX = rowsRng.chance(1, 8) ? !baseAlongX : baseAlongX;
      fillZone(b, z, rowsRng, bayKeepOut, alongX);
    }
  }
  return b;
}

/**
 * Emit the rack segment [s,e) along the row axis × [a0,a1) across it, TRIMMED
 * around keep-out rects (loading bays + their access margin) instead of being
 * dropped — dropping whole rows left big empty patches next to every bay.
 * Pieces shorter than a corridor are skipped (they'd read as debris).
 */
function emitTrimmed(
  b: LayoutBuilder,
  alongX: boolean,
  s: number,
  e: number,
  a0: number,
  a1: number,
  keepOut: readonly Rect[],
): void {
  let start = s;
  // Keep-outs crossing this row, as [lo, hi) intervals on the row axis, sorted.
  const cutsOnRow: Array<[number, number]> = [];
  for (const k of keepOut) {
    const kA0 = alongX ? k.y0 : k.x0;
    const kA1 = alongX ? k.y1 : k.x1;
    if (kA1 <= a0 || kA0 >= a1) continue;
    const lo = alongX ? k.x0 : k.y0;
    const hi = alongX ? k.x1 : k.y1;
    if (hi > s && lo < e) cutsOnRow.push([lo, hi]);
  }
  cutsOnRow.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const [lo, hi] of cutsOnRow) {
    if (lo > start) emitSeg(b, alongX, start, Math.min(lo, e), a0, a1);
    start = Math.max(start, hi);
    if (start >= e) return;
  }
  emitSeg(b, alongX, start, e, a0, a1);
}

function emitSeg(b: LayoutBuilder, alongX: boolean, s: number, e: number, a0: number, a1: number): void {
  if (e - s < 2 * CORRIDOR_WIDTH) return;
  if (alongX) b.addRect(RACK, s, a0, e, a1);
  else b.addRect(RACK, a0, s, a1, e);
}

/** Seeded main cross-aisle positions across [lo, hi): one per ~2400 u. */
function cuts(lo: number, hi: number, rng: ReturnType<typeof stream>): number[] {
  const len = hi - lo;
  const n = Math.max(0, Math.floor(len / 4500));
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    const centre = lo + Math.floor((len * i) / (n + 1));
    const jitter = rng.int(-400, 400);
    out.push(Math.floor((centre + jitter - MAIN_AISLE / 2) / 8) * 8);
  }
  return out;
}

function fillZone(
  b: LayoutBuilder,
  z: Rect,
  rng: ReturnType<typeof stream>,
  keepOut: readonly Rect[],
  rowsAlongX: boolean,
): void {
  const zw = z.x1 - z.x0;
  const zh = z.y1 - z.y0;
  if (zw < 4 * CORRIDOR_WIDTH || zh < 4 * CORRIDOR_WIDTH) return;
  // Double-depth racks with aisles held just above fly-through width: storage
  // dominates the floor, which is what reads as a warehouse.
  const depth = rng.int(320, 480);
  const aisle = rng.int(2 * CORRIDOR_WIDTH, 3 * CORRIDOR_WIDTH);
  const pitch = rng.int(2000, 3600);
  const cross = 2 * CORRIDOR_WIDTH;

  const along0 = rowsAlongX ? z.x0 : z.y0;
  const along1 = rowsAlongX ? z.x1 : z.y1;
  const acr0 = rowsAlongX ? z.y0 : z.x0;
  const acr1 = rowsAlongX ? z.y1 : z.x1;

  // Rows start one aisle in, so the zone edge (next to a road) stays open.
  for (let a = acr0 + aisle; a + depth <= acr1 - aisle; a += depth + aisle) {
    for (let s = along0; s < along1; s += pitch + cross) {
      const e = Math.min(s + pitch, along1);
      if (e - s < 2 * CORRIDOR_WIDTH) continue; // stub too short to read as a rack
      emitTrimmed(b, rowsAlongX, s, e, a, a + depth, keepOut);
    }
  }
}
