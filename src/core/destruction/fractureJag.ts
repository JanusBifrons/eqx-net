/**
 * Jagged cut edges for fractureHull.ts: T-junction welding and the seeded
 * midpoint-displacement jag drawn on every cut edge shared by exactly two
 * pieces (both neighbours draw the same line). Pure and deterministic under
 * the rules in fractureHull.ts.
 */
import { Rng, fnvMixU32 } from '../random/rng.js';
import type { Vec2 } from '../swarm/asteroidShape.js';
import { dedupe, type P } from './fractureSplit.js';
import {
  EDGE_CRACK, EDGE_HULL, EDGE_PRIMARY, EDGE_VORONOI, FRACTURE_QUANTUM, isSimpleRing, q, ringBox, stripSpikes,
} from './fractureRings.js';

/** Jag sub-segment target length as a fraction of sqrt(hull area). */
const JAG_SEG_FRAC = 0.02;
/** v6: passes that straighten one broken jag per piece before giving up on
 *  a piece's jags altogether. */
const JAG_FIX_PASSES = 48;
/** v6: a vertex this many quanta from a cut edge lies on it (T-junction weld). */
const WELD_TOL = 2;

/** Cut edges that get jagged: Voronoi cuts, and since v6 the cracks and the
 *  primary line (cracks, not bulkheads); section cuts and kill cuts stay
 *  straight. */
function jagged(k: number): boolean {
  return k === EDGE_VORONOI || k === EDGE_CRACK || k === EDGE_PRIMARY;
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
function jagPoints(a: Vec2, b: Vec2, seed: number, segLen: number, maxDepth: number, roughness: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  let depth = 0;
  let seg = len;
  while (seg > segLen * 2 && depth < maxDepth) {
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
    const amp = (roughness * len) / (1 << lvl);
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

/**
 * v6: weld T-junctions on cut edges. A crack between a big piece and a wedge
 * that Voronoi cells split again is ONE edge on the big piece and several on
 * the wedge side, so no sub-edge was shared by exactly two pieces and the
 * crack stayed straight. Every vertex of another ring lying on a cut edge
 * (within `WELD_TOL` quanta: the vertices are already on the grid) is
 * inserted into it, so both sides list the same sub-edges. Deterministic:
 * rings and vertices in a fixed order, insertions sorted along the edge.
 */
export function weldTJunctions(rings: P[][]): P[][] {
  const tol = WELD_TOL * FRACTURE_QUANTUM;
  const box: Array<[number, number, number, number]> = rings.map((r) => ringBox(r));
  const out: P[][] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri]!;
    const [rx0, ry0, rx1, ry1] = box[ri]!;
    const res: P[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      res.push(a);
      if (a.k === EDGE_HULL) continue;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const l2 = ex * ex + ey * ey;
      if (l2 === 0) continue;
      const len = Math.sqrt(l2);
      const ins: Array<{ t: number; x: number; y: number }> = [];
      for (let rj = 0; rj < rings.length; rj++) {
        if (rj === ri) continue;
        const [sx0, sy0, sx1, sy1] = box[rj]!;
        if (sx1 < rx0 - tol || sx0 > rx1 + tol || sy1 < ry0 - tol || sy0 > ry1 + tol) continue;
        for (const v of rings[rj]!) {
          if ((v.x === a.x && v.y === a.y) || (v.x === b.x && v.y === b.y)) continue;
          const t = ((v.x - a.x) * ex + (v.y - a.y) * ey) / l2;
          if (t <= 0 || t >= 1) continue;
          const d = Math.abs((v.x - a.x) * ey - (v.y - a.y) * ex) / len;
          if (d > tol) continue;
          let dup = false;
          for (const p of ins) if (p.x === v.x && p.y === v.y) { dup = true; break; }
          if (!dup) ins.push({ t, x: v.x, y: v.y });
        }
      }
      ins.sort((p, q) => p.t - q.t || p.x - q.x || p.y - q.y);
      for (const p of ins) res.push({ x: p.x, y: p.y, k: a.k });
    }
    out.push(stripSpikes(dedupe(res)));
  }
  return out;
}

/** `softer` (v10, a capital cut kill): a jag that breaks a piece is first
 *  redrawn at this gentler roughness, and only straightened if that breaks
 *  a piece too. Absent: straightened at once (byte-identical to v9). */
export function jagCutEdges(rings: P[][], seed: number, scale: number, maxDepth: number, roughness: number, softer?: number): P[][] {
  // Count each Voronoi cut edge; only edges shared by exactly two pieces are
  // jagged, so both neighbours always draw the same line.
  const count = new Map<string, number>();
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      if (!jagged(r[i]!.k)) continue;
      const b = r[(i + 1) % r.length]!;
      const key = edgeKey(r[i]!.x, r[i]!.y, b.x, b.y);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const segLen = JAG_SEG_FRAC * scale;
  const cache = new Map<string, Vec2[]>();
  const straight = new Set<string>();
  const softened = new Set<string>();
  const build = (r: P[]): { ring: P[]; keys: string[] } => {
    const out: P[] = [];
    const keys: string[] = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      out.push(a);
      if (!jagged(a.k)) continue;
      const key = edgeKey(a.x, a.y, b.x, b.y);
      if (count.get(key) !== 2 || straight.has(key)) continue;
      const forward = a.x < b.x || (a.x === b.x && a.y < b.y);
      let pts = cache.get(key);
      if (!pts) {
        const rough = softened.has(key) ? softer! : roughness;
        pts = forward ? jagPoints(a, b, seed, segLen, maxDepth, rough) : jagPoints(b, a, seed, segLen, maxDepth, rough);
        cache.set(key, pts);
      }
      if (pts.length === 0) continue;
      keys.push(key);
      if (forward) for (let m = 0; m < pts.length; m++) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: a.k });
      else for (let m = pts.length - 1; m >= 0; m--) out.push({ x: pts[m]!.x, y: pts[m]!.y, k: a.k });
    }
    return { ring: stripSpikes(dedupe(out)), keys };
  };
  // Straighten (globally, so both sides agree) any jag that breaks a piece.
  // v6: one edge at a time (the one with the most jag points first), so a
  // thin wedge doesn't straighten every crack around it; after
  // `JAG_FIX_PASSES` passes, every jag of a still-broken piece goes.
  for (let pass = 0; pass < 2 * JAG_FIX_PASSES; pass++) {
    let changed = false;
    for (const r of rings) {
      const { ring, keys } = build(r);
      if (keys.length > 0 && !isSimpleRing(ring)) {
        if (pass < JAG_FIX_PASSES) {
          let best = keys[0]!;
          for (const k of keys) if ((cache.get(k)?.length ?? 0) > (cache.get(best)?.length ?? 0)) best = k;
          if (softer !== undefined && !softened.has(best)) {
            softened.add(best);
            cache.delete(best);
          } else straight.add(best);
        } else for (const k of keys) straight.add(k);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rings.map((r) => build(r).ring);
}
