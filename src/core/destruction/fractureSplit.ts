/**
 * Polygon line splitting for fractureHull.ts: the ring type, the
 * `splitByLine` clipper (with its Sutherland-Hodgman fallback), the two-sided
 * split, the cut strip and the v12 extra cuts. Pure; the edge kinds stay in
 * fractureHull.ts and come in as arguments.
 */
import type { FractureExtraCut } from './fractureHull.js';

/** Internal vertex: position + kind of the edge that starts here. */
export interface P {
  x: number;
  y: number;
  k: number;
}

/** A splitting line `nx·x + ny·y = c`; both sides are kept. */
export interface FractureLine {
  nx: number;
  ny: number;
  c: number;
  kind: number;
}

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
export function splitByLine(poly: P[], nx: number, ny: number, c: number, newKind: number): P[][] {
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

export function splitBoth(sections: P[][], l: FractureLine): P[][] {
  const next: P[][] = [];
  for (const s of sections) {
    for (const part of splitByLine(s, l.nx, l.ny, l.c, l.kind)) next.push(part);
    for (const part of splitByLine(s, -l.nx, -l.ny, -l.c, l.kind)) next.push(part);
  }
  return next;
}

/** v9 channel, v10 wide slice, v12 extra cut: erase the strip
 *  `|nx·x + ny·y − c| < half` from every ring (two straight cuts of edge
 *  kind `kind`, `EDGE_CUT` in fractureHull). A part the strip leaves under
 *  `minPart` is erased with it; a ring the strip misses is kept whole
 *  whatever its size. */
export function cutStrip(rings: P[][], nx: number, ny: number, c: number, half: number, minPart: number, kind: number): P[][] {
  const out: P[][] = [];
  for (const ring of rings) {
    const sides = [
      splitByLine(ring, nx, ny, c - half, kind),
      splitByLine(ring, -nx, -ny, -(c + half), kind),
    ];
    for (const side of sides) for (const r of side) if (r === ring || ringArea(r) >= minPart) out.push(r);
  }
  return out;
}

/** v12 multi-cut: each further beam's line (the first `max` of `cuts`)
 *  splits every part it crosses with edge kind `kind`; a `width` over 0
 *  erases its strip like the main cut (`cutStrip`, same `minPart`). A
 *  zero-length direction is skipped. */
export function applyExtraCuts(
  start: P[][], cuts: ReadonlyArray<FractureExtraCut>, max: number, minPart: number, kind: number,
): P[][] {
  const n = Math.min(cuts.length, max);
  for (let i = 0; i < n; i++) {
    const xc = cuts[i]!;
    const l = Math.sqrt(xc.dirX * xc.dirX + xc.dirY * xc.dirY);
    if (!(l > 0)) continue;
    const nx = -xc.dirY / l;
    const ny = xc.dirX / l;
    const c = nx * xc.x + ny * xc.y;
    start = xc.width > 0
      ? cutStrip(start, nx, ny, c, xc.width / 2, minPart, kind)
      : splitBoth(start, { nx, ny, c, kind });
  }
  return start;
}

/** Drop consecutive duplicate vertices (keeping the later one's edge kind). */
export function dedupe(r: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const nx = r[(i + 1) % r.length]!;
    if (r.length > 1 && p.x === nx.x && p.y === nx.y) continue;
    out.push(p);
  }
  return out;
}

export function ringArea(r: ReadonlyArray<{ x: number; y: number }>): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    const b = r[(i + 1) % r.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
