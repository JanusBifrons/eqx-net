/**
 * Capital fracture, slice S1 (docs/architecture/capital-destruction.md).
 *
 * `fractureHull` splits a hull outline into wreck pieces: seeded Voronoi cells
 * clustered around the killing blow, clipped to the (possibly concave) hull,
 * optional straight section cuts, jagged cut edges and a convex decomposition
 * per piece for Rapier. Pure and DETERMINISTIC: the server and every client
 * run it from the same `(hull, seed, killPoint, sectionCuts, maxPieces)` and
 * get bit-identical pieces, so no geometry ever goes on the wire.
 *
 * Determinism rules (keep them when editing):
 *  - only + − × ÷ and `Math.sqrt` / `Math.round` / `Math.abs` / min / max in
 *    this path (IEEE-exact on every engine); never sin/cos/atan2/pow/exp;
 *  - randomness from the integer mulberry32 `Rng` (`u32 / 2^32` is exact);
 *  - fixed iteration order (indexed loops; a `Map` is used for lookups only);
 *    every sort has a total tie-break;
 *  - output vertices snap to `FRACTURE_QUANTUM` (1/64 u); after that every
 *    orientation test is exact;
 *  - poly-decomp: `quickDecomp` / `makeCCW` only (its `removeCollinearPoints`
 *    uses `Math.acos`).
 * Any change to the output must bump `FRACTURE_ALGO_VERSION` (the golden test
 * in `fractureHull.test.ts` fails first).
 *
 * Not hot-loop code: it runs once per death (allocates freely, invariant #14
 * applies only to what callers do per frame with the result, which is plain
 * read-only data).
 */
import decomp from 'poly-decomp';
import { Rng, fnvMixU32 } from '../random/rng.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

/** Bump on ANY change to the produced geometry (rides the S2 descriptor). */
export const FRACTURE_ALGO_VERSION = 1;
/** Output grid: every vertex is a multiple of this. */
export const FRACTURE_QUANTUM = 1 / 64;
/** Hard ceiling on pieces (the S2 wire carries the piece index in a u8). */
export const FRACTURE_MAX_PIECES = 64;

/** Seed-density falloff radius as a fraction of sqrt(hull area). */
const FALLOFF_FRAC = 0.18;
/** Minimum acceptance far from the blast, so the far end still splits. */
const ACCEPT_FLOOR = 0.035;
/** Minimum seed spacing as a fraction of sqrt(hull area). */
const MIN_SEED_SEP_FRAC = 0.03;
/** Rejection-sampling attempts per requested seed. */
const ATTEMPTS_PER_SEED = 400;
/** Jag sub-segment target length as a fraction of sqrt(hull area). */
const JAG_SEG_FRAC = 0.02;
/** Maximum midpoint-subdivision depth (2^depth segments per cut edge). */
const JAG_MAX_DEPTH = 4;
/** Midpoint displacement amplitude per level, as a fraction of the sub-segment length. */
const JAG_ROUGHNESS = 0.22;

const EDGE_HULL = 0;
const EDGE_VORONOI = 1;
const EDGE_SECTION = 2;

export interface FractureCut {
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface FractureInput {
  /** Hull outline in local coordinates, either winding; concave allowed. */
  readonly hull: ReadonlyArray<readonly [number, number]>;
  /** u32 seed (the server picks it; every client regenerates from it). */
  readonly seed: number;
  /** Where the killing blow landed, in the hull's local frame. */
  readonly killPoint: Vec2;
  /** Optional section boundaries; each is the infinite line through a→b.
   *  Section cuts are straight (bulkheads); only Voronoi cuts are jagged. */
  readonly sectionCuts?: ReadonlyArray<FractureCut>;
  /** Cap on real fragments (clamped to 1..FRACTURE_MAX_PIECES). */
  readonly maxPieces: number;
}

export interface FracturePiece {
  /** CCW outline (positive shoelace area), quantised, in the hull's frame. */
  readonly outline: Vec2[];
  /** `cutEdges[i]` is true when edge outline[i] → outline[i+1] is a new cut
   *  (glows molten in S3); false when it is part of the original hull. */
  readonly cutEdges: boolean[];
  /** Convex CCW parts tiling the outline (one Rapier collider each). */
  readonly convexParts: Vec2[][];
  readonly area: number;
  readonly centroid: Vec2;
}

/** Internal vertex: position + kind of the edge that starts here. */
interface P {
  x: number;
  y: number;
  k: number;
}

export function fractureHull(input: FractureInput): FracturePiece[] {
  const cap = Math.max(1, Math.min(FRACTURE_MAX_PIECES, Math.floor(input.maxPieces)));
  const hull = normaliseHull(input.hull);
  if (hull.length < 3) return [];
  const hullArea = ringArea(hull);
  const scale = Math.sqrt(hullArea);
  const cuts = input.sectionCuts ?? [];

  // Seeds: one prefix-stable stream, so fewer seeds = a prefix of more seeds.
  const allSeeds = sampleSeeds(hull, hullArea, input.seed >>> 0, input.killPoint, cap);

  // Retry with fewer seeds (then without section cuts) until the cap holds.
  let useCuts = cuts.length > 0;
  let n = allSeeds.length;
  for (;;) {
    const rings = splitIntoPieces(hull, useCuts ? cuts : [], allSeeds, n);
    const minArea = Math.max(4 * FRACTURE_QUANTUM * FRACTURE_QUANTUM, hullArea * 1e-6);
    const quantised = quantiseRings(rings, minArea);
    if (quantised.length <= cap) {
      const jagged = jagCutEdges(quantised, input.seed >>> 0, scale);
      return jagged.map(toPiece);
    }
    if (n > 1) n = Math.max(1, n - (quantised.length - cap));
    else if (useCuts) {
      useCuts = false;
      n = allSeeds.length;
    } else {
      // Unreachable for a simple hull (one seed, no cuts = the hull itself).
      return [toPiece(quantiseRings([hull], 0)[0]!)];
    }
  }
}

// ───────────────────────────── seeds ─────────────────────────────

function sampleSeeds(hull: P[], hullArea: number, seed: number, kill: Vec2, count: number): Vec2[] {
  const rng = new Rng(seed ^ 0x5eed5eed);
  const f01 = (): number => rng.u32() / 4294967296;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of hull) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const s = Math.sqrt(hullArea);
  const r2 = FALLOFF_FRAC * s * (FALLOFF_FRAC * s);
  const sep2 = MIN_SEED_SEP_FRAC * s * (MIN_SEED_SEP_FRAC * s);
  const seeds: Vec2[] = [];
  if (pointInRing(hull, kill.x, kill.y)) seeds.push({ x: kill.x, y: kill.y });
  const attempts = ATTEMPTS_PER_SEED * count;
  for (let a = 0; a < attempts && seeds.length < count; a++) {
    const x = minX + (maxX - minX) * f01();
    const y = minY + (maxY - minY) * f01();
    const u = f01();
    if (!pointInRing(hull, x, y)) continue;
    const dx = x - kill.x;
    const dy = y - kill.y;
    const accept = Math.max(ACCEPT_FLOOR, r2 / (r2 + dx * dx + dy * dy));
    if (u >= accept) continue;
    let ok = true;
    for (const q of seeds) {
      const ex = q.x - x;
      const ey = q.y - y;
      if (ex * ex + ey * ey < sep2) {
        ok = false;
        break;
      }
    }
    if (ok) seeds.push({ x, y });
  }
  if (seeds.length === 0) seeds.push({ x: hull[0]!.x, y: hull[0]!.y });
  return seeds;
}

// ──────────────────────── sections + Voronoi ────────────────────────

function splitIntoPieces(hull: P[], cuts: ReadonlyArray<FractureCut>, seeds: Vec2[], n: number): P[][] {
  let sections: P[][] = [hull];
  for (const cut of cuts) {
    const nx = -(cut.b.y - cut.a.y);
    const ny = cut.b.x - cut.a.x;
    if (nx === 0 && ny === 0) continue;
    const c = nx * cut.a.x + ny * cut.a.y;
    const next: P[][] = [];
    for (const s of sections) {
      for (const part of splitByLine(s, nx, ny, c, EDGE_SECTION)) next.push(part);
      for (const part of splitByLine(s, -nx, -ny, -c, EDGE_SECTION)) next.push(part);
    }
    sections = next;
  }

  const out: P[][] = [];
  for (const section of sections) {
    const local: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const sd = seeds[i]!;
      if (pointInRing(section, sd.x, sd.y)) local.push(sd);
    }
    if (local.length <= 1) {
      out.push(section);
      continue;
    }
    const box = ringBox(section);
    for (let i = 0; i < local.length; i++) {
      const si = local[i]!;
      const neighbours = voronoiNeighbours(local, i, box);
      let pieces: P[][] = [section];
      for (const j of neighbours) {
        const sj = local[j]!;
        // Keep the side closer to si: (p − m)·(sj − si) < 0.
        const nx = sj.x - si.x;
        const ny = sj.y - si.y;
        const mx = (si.x + sj.x) / 2;
        const my = (si.y + sj.y) / 2;
        const c = nx * mx + ny * my;
        const next: P[][] = [];
        for (const p of pieces) for (const q of splitByLine(p, nx, ny, c, EDGE_VORONOI)) next.push(q);
        pieces = next;
        if (pieces.length === 0) break;
      }
      for (const p of pieces) out.push(p);
    }
  }
  return out;
}

/** Indices j whose bisector with seed i bounds i's (convex) Voronoi cell,
 *  in ascending order. The cell starts as `box` and is clipped by every
 *  bisector half-plane (convex Sutherland–Hodgman is exact for this). */
function voronoiNeighbours(seeds: Vec2[], i: number, box: [number, number, number, number]): number[] {
  const si = seeds[i]!;
  const [x0, y0, x1, y1] = box;
  const padX = (x1 - x0) * 0.5 + 1;
  const padY = (y1 - y0) * 0.5 + 1;
  // cell vertices with the index of the bisector that made the edge starting there (-1 = box)
  let cell: Array<{ x: number; y: number; j: number }> = [
    { x: x0 - padX, y: y0 - padY, j: -1 },
    { x: x1 + padX, y: y0 - padY, j: -1 },
    { x: x1 + padX, y: y1 + padY, j: -1 },
    { x: x0 - padX, y: y1 + padY, j: -1 },
  ];
  for (let j = 0; j < seeds.length && cell.length > 0; j++) {
    if (j === i) continue;
    const sj = seeds[j]!;
    const nx = sj.x - si.x;
    const ny = sj.y - si.y;
    const c = nx * ((si.x + sj.x) / 2) + ny * ((si.y + sj.y) / 2);
    const next: typeof cell = [];
    for (let v = 0; v < cell.length; v++) {
      const a = cell[v]!;
      const b = cell[(v + 1) % cell.length]!;
      const da = nx * a.x + ny * a.y - c;
      const db = nx * b.x + ny * b.y - c;
      if (da <= 0) next.push(a);
      if ((da <= 0) !== (db <= 0)) {
        const t = da / (da - db);
        // Entering (a out): the edge from here continues a's edge; leaving: bisector j.
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, j: da <= 0 ? j : a.j });
      }
    }
    cell = next;
  }
  const js: number[] = [];
  for (const v of cell) if (v.j >= 0 && js.indexOf(v.j) < 0) js.push(v.j);
  js.sort((a, b) => a - b);
  return js;
}

// ───────────────────── robust split of a simple polygon by a line ─────────────────────

interface Node {
  x: number;
  y: number;
  k: number;
  /** 0 = original vertex, 1 = entering crossing, 2 = exiting crossing */
  cross: number;
  t: number;
  tk: number;
  ring: number;
  partner: number;
}

/**
 * Parts of the simple CCW polygon `poly` where `nx·x + ny·y − c < 0`, as
 * separate simple CCW polygons. Unlike Sutherland–Hodgman this never joins
 * disjoint parts with a zero-width bridge: crossings are sorted along the line
 * and paired into inside intervals, and each part is traced through them.
 * A vertex exactly ON the line counts as outside (symbolic perturbation), and
 * ties along the line are broken by the perturbation's first-order term, so
 * the pairing is consistent even through vertices.
 */
function splitByLine(poly: P[], nx: number, ny: number, c: number, newKind: number): P[][] {
  const n = poly.length;
  const d: number[] = new Array<number>(n);
  let anyIn = false;
  let anyOut = false;
  for (let i = 0; i < n; i++) {
    const di = nx * poly[i]!.x + ny * poly[i]!.y - c;
    d[i] = di;
    if (di < 0) anyIn = true;
    else anyOut = true;
  }
  if (!anyIn) return [];
  if (!anyOut) return [poly];

  const ux = -ny;
  const uy = nx;
  const ring: Node[] = [];
  const crossings: Node[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const da = d[i]!;
    const db = d[(i + 1) % n]!;
    ring.push({ x: a.x, y: a.y, k: a.k, cross: 0, t: 0, tk: 0, ring: ring.length, partner: -1 });
    const aIn = da < 0;
    const bIn = db < 0;
    if (aIn === bIn) continue;
    // Always interpolate from the OUT end to the IN end, so a shared edge
    // crossed from either side yields the bit-identical point.
    const o = aIn ? b : a;
    const q = aIn ? a : b;
    const dO = aIn ? db : da;
    const dQ = aIn ? da : db;
    const s = dO / (dO - dQ);
    const x = o.x + (q.x - o.x) * s;
    const y = o.y + (q.y - o.y) * s;
    const node: Node = {
      x,
      y,
      k: aIn ? newKind : a.k,
      cross: aIn ? 2 : 1,
      t: x * ux + y * uy,
      tk: ((q.x - o.x) * ux + (q.y - o.y) * uy) / (dO - dQ),
      ring: ring.length,
      partner: -1,
    };
    ring.push(node);
    crossings.push(node);
  }
  crossings.sort((p, q) => p.t - q.t || p.tk - q.tk || p.ring - q.ring);
  for (let m = 0; m + 1 < crossings.length; m += 2) {
    const p = crossings[m]!;
    const q = crossings[m + 1]!;
    if (p.cross === q.cross) return [sutherlandHodgman(poly, d, newKind)];
    p.partner = q.ring;
    q.partner = p.ring;
  }

  const visited = new Uint8Array(ring.length);
  const out: P[][] = [];
  for (const start of crossings) {
    if (start.cross !== 1 || visited[start.ring]) continue;
    const piece: P[] = [];
    let idx = start.ring;
    let guard = ring.length + 1;
    while (!visited[idx] && guard-- > 0) {
      visited[idx] = 1;
      const nd = ring[idx]!;
      piece.push({ x: nd.x, y: nd.y, k: nd.k });
      if (nd.cross === 2) idx = nd.partner;
      else idx = (idx + 1) % ring.length;
      // Skip outside original vertices (only reachable through an entering crossing).
    }
    const cleaned = dedupe(piece);
    if (cleaned.length >= 3 && ringArea(cleaned) > 0) out.push(cleaned);
  }
  return out;
}

/** Fallback for a degenerate crossing pairing (never seen in tests). */
function sutherlandHodgman(poly: P[], d: number[], newKind: number): P[] {
  const out: P[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const da = d[i]!;
    const db = d[(i + 1) % n]!;
    if (da < 0) out.push({ x: a.x, y: a.y, k: db < 0 ? a.k : newKind });
    if ((da < 0) !== (db < 0)) {
      const s = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, k: da < 0 ? newKind : a.k });
    }
  }
  return dedupe(out);
}

// ───────────────────────────── quantise ─────────────────────────────

function q(v: number): number {
  return Math.round(v / FRACTURE_QUANTUM) * FRACTURE_QUANTUM;
}

function quantiseRings(rings: P[][], minArea: number): P[][] {
  const out: P[][] = [];
  for (const r of rings) {
    const qr = dedupe(r.map((p) => ({ x: q(p.x), y: q(p.y), k: p.k })));
    const clean = stripSpikes(qr);
    if (clean.length >= 3 && ringArea(clean) > minArea) out.push(clean);
  }
  return out;
}

// ───────────────────────────── jagged edges ─────────────────────────────

function edgeKey(ax: number, ay: number, bx: number, by: number): string {
  const ia = Math.round(ax / FRACTURE_QUANTUM);
  const ja = Math.round(ay / FRACTURE_QUANTUM);
  const ib = Math.round(bx / FRACTURE_QUANTUM);
  const jb = Math.round(by / FRACTURE_QUANTUM);
  return ia < ib || (ia === ib && ja < jb) ? `${ia},${ja},${ib},${jb}` : `${ib},${jb},${ia},${ja}`;
}

/** Jag polyline interior points from canonical a → b (a lexicographically first). */
function jagPoints(a: Vec2, b: Vec2, seed: number, segLen: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  let depth = 0;
  let seg = len;
  while (seg > segLen * 2 && depth < JAG_MAX_DEPTH) {
    seg /= 2;
    depth++;
  }
  if (depth === 0) return [];
  const N = 1 << depth;
  const off = new Array<number>(N + 1).fill(0);
  let h = fnvMixU32(seed ^ 0x9e3779b9, Math.round(a.x / FRACTURE_QUANTUM) >>> 0);
  h = fnvMixU32(h, Math.round(a.y / FRACTURE_QUANTUM) >>> 0);
  h = fnvMixU32(h, Math.round(b.x / FRACTURE_QUANTUM) >>> 0);
  h = fnvMixU32(h, Math.round(b.y / FRACTURE_QUANTUM) >>> 0);
  const rng = new Rng(h);
  for (let lvl = 1; lvl <= depth; lvl++) {
    const step = N >> lvl;
    const amp = (JAG_ROUGHNESS * len) / (1 << lvl);
    for (let i = step; i < N; i += 2 * step) {
      const r = rng.u32() / 4294967296;
      off[i] = (off[i - step]! + off[i + step]!) / 2 + (r * 2 - 1) * amp;
    }
  }
  const px = -dy / len;
  const py = dx / len;
  const pts: Vec2[] = [];
  for (let i = 1; i < N; i++) {
    const t = i / N;
    pts.push({ x: q(a.x + dx * t + px * off[i]!), y: q(a.y + dy * t + py * off[i]!) });
  }
  return pts;
}

function jagCutEdges(rings: P[][], seed: number, scale: number): P[][] {
  // Count each Voronoi cut edge; only edges shared by exactly two pieces are
  // jagged, so both neighbours always draw the same line.
  const count = new Map<string, number>();
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (r[i]!.k !== EDGE_VORONOI) continue;
      const b = r[(i + 1) % r.length]!;
      const key = edgeKey(r[i]!.x, r[i]!.y, b.x, b.y);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const segLen = JAG_SEG_FRAC * scale;
  const cache = new Map<string, Vec2[]>();
  const straight = new Set<string>();
  const build = (r: P[]): { ring: P[]; keys: string[] } => {
    const out: P[] = [];
    const keys: string[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      out.push(a);
      if (a.k !== EDGE_VORONOI) continue;
      const key = edgeKey(a.x, a.y, b.x, b.y);
      if (count.get(key) !== 2 || straight.has(key)) continue;
      const forward = a.x < b.x || (a.x === b.x && a.y < b.y);
      let pts = cache.get(key);
      if (!pts) {
        pts = forward ? jagPoints(a, b, seed, segLen) : jagPoints(b, a, seed, segLen);
        cache.set(key, pts);
      }
      if (pts.length === 0) continue;
      keys.push(key);
      if (forward) for (let m = 0; m < pts.length; m++) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: EDGE_VORONOI });
      else for (let m = pts.length - 1; m >= 0; m--) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: EDGE_VORONOI });
    }
    return { ring: stripSpikes(dedupe(out)), keys };
  };
  // Straighten (globally, so both sides agree) any jag that breaks a piece.
  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    for (const r of rings) {
      const { ring, keys } = build(r);
      if (keys.length > 0 && !isSimpleRing(ring)) {
        for (const k of keys) straight.add(k);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rings.map((r) => build(r).ring);
}

// ───────────────────────────── piece output ─────────────────────────────

function toPiece(r: P[]): FracturePiece {
  const outline = r.map((p) => ({ x: p.x, y: p.y }));
  const cutEdges = r.map((p) => p.k !== EDGE_HULL);
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!;
    const n = outline[(i + 1) % outline.length]!;
    const cr = p.x * n.y - n.x * p.y;
    a2 += cr;
    cx += (p.x + n.x) * cr;
    cy += (p.y + n.y) * cr;
  }
  const area = a2 / 2;
  return {
    outline,
    cutEdges,
    convexParts: convexDecompose(outline, area),
    area,
    centroid: { x: cx / (3 * a2), y: cy / (3 * a2) },
  };
}

function convexDecompose(outline: Vec2[], area: number): Vec2[][] {
  // Strip exactly-collinear vertices (exact on the 1/64 grid).
  const pts: [number, number][] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[(i - 1 + n) % n]!;
    const b = outline[i]!;
    const c = outline[(i + 1) % n]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) pts.push([b.x, b.y]);
  }
  if (pts.length >= 3) {
    decomp.makeCCW(pts);
    const parts = decomp.quickDecomp(pts);
    let sum = 0;
    let convex = parts.length > 0;
    for (const part of parts) {
      sum += tupleArea(part);
      if (!isConvexTuples(part)) convex = false;
    }
    if (convex && Math.abs(sum - area) <= Math.abs(area) * 1e-9 + 1e-9) {
      return parts.map((part) => part.map(([x, y]) => ({ x, y })));
    }
  }
  return earClip(outline);
}

/** Fallback: ear clipping (triangles are convex). Exact on the 1/64 grid. */
function earClip(outline: Vec2[]): Vec2[][] {
  const idx: number[] = [];
  for (let i = 0; i < outline.length; i++) idx.push(i);
  const tris: Vec2[][] = [];
  let guard = outline.length * outline.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = outline[idx[(i - 1 + idx.length) % idx.length]!]!;
      const b = outline[idx[i]!]!;
      const c = outline[idx[(i + 1) % idx.length]!]!;
      if (orient(a, b, c) <= 0) continue;
      let blocked = false;
      for (let j = 0; j < idx.length && !blocked; j++) {
        const p = outline[idx[j]!]!;
        if (p === a || p === b || p === c) continue;
        if (orient(a, b, p) >= 0 && orient(b, c, p) >= 0 && orient(c, a, p) >= 0) blocked = true;
      }
      if (blocked) continue;
      tris.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) {
    const [a, b, c] = [outline[idx[0]!]!, outline[idx[1]!]!, outline[idx[2]!]!];
    if (orient(a, b, c) > 0) tris.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]);
  }
  return tris;
}

// ───────────────────────────── geometry helpers ─────────────────────────────

function normaliseHull(hull: ReadonlyArray<readonly [number, number]>): P[] {
  let ring = dedupe(hull.map(([x, y]) => ({ x, y, k: EDGE_HULL })));
  if (ringArea(ring) < 0) ring = ring.reverse();
  return ring;
}

/** Drop consecutive duplicate vertices (keeping the later one's edge kind). */
function dedupe(r: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const nx = r[(i + 1) % r.length]!;
    if (r.length > 1 && p.x === nx.x && p.y === nx.y) continue;
    out.push(p);
  }
  return out;
}

/** Remove zero-width spikes (b where a→b→c folds straight back). */
function stripSpikes(r: P[]): P[] {
  const pts = r.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const n = pts.length;
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (cr === 0 && dot < 0) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
    const d = dedupe(pts);
    if (d.length !== pts.length) {
      pts.length = 0;
      for (const p of d) pts.push(p);
      changed = true;
    }
  }
  return pts;
}

function ringArea(r: ReadonlyArray<{ x: number; y: number }>): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function tupleArea(r: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function isConvexTuples(r: ReadonlyArray<readonly [number, number]>): boolean {
  if (r.length < 3) return false;
  let span = 0;
  for (const p of r) span = Math.max(span, Math.abs(p[0]), Math.abs(p[1]));
  const eps = 1e-9 * span * span;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    const c = r[(i + 2) % r.length]!;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < -eps) return false;
  }
  return tupleArea(r) > 0;
}

function ringBox(r: P[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of r) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

function pointInRing(r: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!;
    const b = r[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function orient(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segTouch(a: P, b: P, c: P, d: P): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: P, s: P, e: P): boolean =>
    Math.min(s.x, e.x) <= p.x && p.x <= Math.max(s.x, e.x) && Math.min(s.y, e.y) <= p.y && p.y <= Math.max(s.y, e.y);
  return (o1 === 0 && on(c, a, b)) || (o2 === 0 && on(d, a, b)) || (o3 === 0 && on(a, c, d)) || (o4 === 0 && on(b, c, d));
}

/** Exact (on the 1/64 grid) simplicity test: no repeated vertex, no
 *  touching non-adjacent edges, positive area. O(n²); n is small. */
function isSimpleRing(r: P[]): boolean {
  const n = r.length;
  if (n < 3 || ringArea(r) <= 0) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) if (r[i]!.x === r[j]!.x && r[i]!.y === r[j]!.y) return false;
  }
  for (let i = 0; i < n; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segTouch(a, b, r[j]!, r[(j + 1) % n]!)) return false;
    }
  }
  return true;
}
