/**
 * Kill-point focus (capital-destruction.md, "Kill point and drift fixes").
 * Hostile review of a filmed heavy-cruiser death (a 16" salvo, 5,600 damage
 * on a 4,018-hull ship): shells hit mid-hull, yet the cracks spread over
 * ~60 % of the hull's length, a long sliver ran down the bow and the bow tip
 * split lengthwise into a "tuning fork". Owner: "The impact location of the
 * last hit should play a huge role in where it splits": the shatter must be
 * densest at the kill point, and cuts must run across the hull, not along it.
 */
import { describe, expect, it } from 'vitest';
import { fractureHull, fracturePlan, FRACTURE_MAX_PIECES, type FracturePiece } from './fractureHull.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';

type V = { x: number; y: number };

const hull = shipHullOutline(getShipKind('heavy-cruiser'));
const pts = hull.map(([x, y]) => ({ x, y }));
let minY = Infinity;
let maxY = -Infinity;
for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
const L = maxY - minY;

/** A point on the port edge `frac` of the length aft of the bow. */
function sidePoint(frac: number): V {
  const y = minY + frac * L;
  let x = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) {
      const xi = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (xi < x) x = xi;
    }
  }
  return { x, y };
}

/** Hull beam (both edges) at station y. */
function widthAt(y: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if ((a.y - y) * (b.y - y) <= 0 && a.y !== b.y) {
      const xi = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
      lo = Math.min(lo, xi);
      hi = Math.max(hi, xi);
    }
  }
  return hi > lo ? hi - lo : 0;
}

/** Hull area between stations y0 and y1 (midpoint rule). */
function bandArea(y0: number, y1: number): number {
  const n = 64;
  let s = 0;
  for (let i = 0; i < n; i++) s += widthAt(y0 + ((i + 0.5) * (y1 - y0)) / n);
  return (s * (y1 - y0)) / n;
}

function area(poly: ReadonlyArray<V>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** The filmed death (5,600 on 4,018 hull after a 4,200 hit) down to a grind. */
const LEVELS: ReadonlyArray<readonly [string, number, number]> = [
  ['filmed salvo', 1.39, 2.4],
  ['heavy', 0.5, 0.9],
  ['medium', 0.15, 0.35],
  ['light', 0.05, 0.1],
];
const SEEDS = 30;

function shatter(seed: number, frac: number, kb: number, rr: number): { pieces: FracturePiece[]; kill: V } {
  const input = { hull, seed, killPoint: sidePoint(frac), maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: kb, recentDamageRate: rr, snapChance: 0 };
  return { pieces: fractureHull(input), kill: fracturePlan(input).killPoint };
}

interface Stats { near: number; along: number; sliver: number; pieces: number }

/** Over a seed sweep of mid-hull side hits: the share of new cut length
 *  within 20 % of the length of the kill point, the share of cut length
 *  running along the keel, the worst long sliver (share of the beam it misses over its span) and
 *  the mean piece count. */
function stats(kb: number, rr: number): Stats {
  let near = 0;
  let along = 0;
  let all = 0;
  let sliver = 0;
  let pieces = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const frac = 0.35 + (0.3 * ((seed * 7) % 10)) / 10;
    const { pieces: ps, kill } = shatter(seed, frac, kb, rr);
    pieces += ps.length;
    for (const p of ps) {
      const o = p.outline;
      for (let i = 0; i < o.length; i++) {
        if (!p.cutEdges[i]) continue;
        const a = o[i]!;
        const b = o[(i + 1) % o.length]!;
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        const len = Math.hypot(dx, dy);
        all += len;
        if (dy > 2 * dx) along += len;
        if (Math.abs((a.y + b.y) / 2 - kill.y) <= 0.2 * L) near += len;
      }
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const v of o) { y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      const len = y1 - y0;
      // A sliver: long, and covering little of the hull's own beam over its
      // span (a full-width end piece covers ~all of it).
      if (len > 0.15 * L) sliver = Math.max(sliver, 1 - area(o) / bandArea(y0, y1));
    }
  }
  return { near: near / all, along: along / all, sliver, pieces: pieces / SEEDS };
}

describe('fracture: the shatter is focused on the kill point', () => {
  it('the hull is long and thin (the case the review filmed)', () => {
    expect(L).toBeGreaterThan(5 * (Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))));
  });

  it.each(LEVELS)('%s: cracks cluster at the kill point and run across the hull', (_name, kb, rr) => {
    const s = stats(kb, rr);
    console.log(`[kill focus] ${_name}: ${s.pieces.toFixed(1)} pieces, cut length within 20 % L ${(100 * s.near).toFixed(0)} %, lengthwise ${(100 * s.along).toFixed(0)} %, worst long piece misses ${(100 * s.sliver).toFixed(0)} % of its beam`);
    expect(s.near, 'share of new cut length within 20 % of the length of the kill point').toBeGreaterThan(0.82);
    expect(s.along, 'share of new cut length running along the keel').toBeLessThan(0.1);
    // v7: a fan crack cuts each zone half into a wide triangle and a quad;
    // the triangle covers about half the beam over its span by shape, so
    // the bound is 0.6 (was 0.35). Slivers are locked directly by the v7
    // "no thin sliver" test below.
    expect(s.sliver, 'no long piece is a lengthwise sliver (covers little of the beam over its span)').toBeLessThan(0.6);
  });
});

/** Cut runs (chains of consecutive cut edges on one piece) as chords. */
function cutChords(p: FracturePiece): Array<[V, V]> {
  const o = p.outline;
  const n = o.length;
  const out: Array<[V, V]> = [];
  if (!p.cutEdges.some(Boolean) || p.cutEdges.every(Boolean)) return out;
  for (let i = 0; i < n; i++) {
    if (!p.cutEdges[i] || p.cutEdges[(i - 1 + n) % n]) continue;
    let k = 0;
    while (k < n && p.cutEdges[(i + k) % n]) k++;
    out.push([o[i]!, o[(i + k) % n]!]);
  }
  return out;
}

/** Each crack of a fracture as a chord: the cut edges of every piece joined
 *  into chains (both sides of a crack are one chain), split wherever cracks
 *  meet or a crack meets the hull's own outline (the kill point, where the
 *  primary line and the fan cracks start). */
function crackChords(pieces: ReadonlyArray<FracturePiece>): Array<[V, V]> {
  const key = (v: V): string => `${v.x},${v.y}`;
  const at = new Map<string, V>();
  const adj = new Map<string, Set<string>>();
  const onOutline = new Set<string>();
  for (const p of pieces) {
    const o = p.outline;
    for (let i = 0; i < o.length; i++) {
      const a = o[i]!;
      const b = o[(i + 1) % o.length]!;
      const ka = key(a);
      const kb = key(b);
      if (!p.cutEdges[i]) { onOutline.add(ka); onOutline.add(kb); continue; }
      at.set(ka, a);
      at.set(kb, b);
      if (!adj.has(ka)) adj.set(ka, new Set());
      if (!adj.has(kb)) adj.set(kb, new Set());
      adj.get(ka)!.add(kb);
      adj.get(kb)!.add(ka);
    }
  }
  const stop = (k: string): boolean => adj.get(k)!.size !== 2 || onOutline.has(k);
  const used = new Set<string>();
  const out: Array<[V, V]> = [];
  const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const [k0, nbrs] of adj) {
    if (!stop(k0)) continue;
    for (const k1 of nbrs) {
      if (used.has(edgeKey(k0, k1))) continue;
      let prev = k0;
      let cur = k1;
      used.add(edgeKey(prev, cur));
      while (!stop(cur)) {
        let next = '';
        for (const n of adj.get(cur)!) if (n !== prev) next = n;
        prev = cur;
        cur = next;
        used.add(edgeKey(prev, cur));
      }
      out.push([at.get(k0)!, at.get(cur)!]);
    }
  }
  return out;
}

// ── v7 (owner review of a filmed heavy-cruiser death, 2026-11-13: "Tune
// it"). v6 cut full-width far cracks where no shell hit ("random slicing")
// and a comb of thin glowing slivers at the impact. Owner: "The last hit's
// impact sets the split"; chunks should be ENORMOUS and heavy. Target: the
// break goes through the kill point, 2–5 chunky pieces there, one or two big
// sections either side, a far crack only rarely and only on a very heavy
// blow. All three locks below failed on v6. ──

const B = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
const HULL_AREA = area(pts);

/** Longest over shortest extent of a piece across 64 directions. */
function thinness(o: ReadonlyArray<V>): number {
  let minW = Infinity;
  let maxL = 0;
  for (let k = 0; k < 64; k++) {
    const a = (k * Math.PI) / 64;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of o) {
      const p = v.x * c + v.y * s;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    minW = Math.min(minW, hi - lo);
    maxL = Math.max(maxL, hi - lo);
  }
  return maxL / minW;
}

/** A piece's length (its longest extent, over 180 directions) over its width
 *  across that direction. */
function lengthOverWidth(o: ReadonlyArray<V>): number {
  const N = 180;
  const ext = (a: number): number => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of o) {
      const p = v.x * c + v.y * s;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    return hi - lo;
  };
  let best = 0;
  let bestA = 0;
  for (let k = 0; k < N; k++) {
    const a = (k * Math.PI) / N;
    const e = ext(a);
    if (e > best) { best = e; bestA = a; }
  }
  return best / ext(bestA + Math.PI / 2);
}

/** Width of a piece across its long axis (see `lengthOverWidth`). */
function widthAcross(o: ReadonlyArray<V>): number {
  const N = 180;
  const ext = (a: number): number => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of o) {
      const p = v.x * c + v.y * s;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    return hi - lo;
  };
  let best = 0;
  let bestA = 0;
  for (let k = 0; k < N; k++) {
    const a = (k * Math.PI) / N;
    const e = ext(a);
    if (e > best) { best = e; bestA = a; }
  }
  return ext(bestA + Math.PI / 2);
}

const V7_SEEDS = 60;
/** Side hits over the middle 40 % of the hull, alternating port/starboard. */
function v7Shatter(seed: number, kb: number, rr: number): { pieces: FracturePiece[]; kill: V } {
  const frac = 0.3 + (0.4 * ((seed * 7) % 10)) / 10;
  const p = sidePoint(frac);
  const killPoint = seed % 2 ? p : { x: -p.x, y: p.y };
  const input = { hull, seed, killPoint, maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: kb, recentDamageRate: rr, snapChance: 0 };
  return { pieces: fractureHull(input), kill: fracturePlan(input).killPoint };
}

describe('fracture v7: chunky pieces at the impact, big sections elsewhere', () => {
  /** A sliver: under 4 % of the hull's area and over 4× longer than wide. */
  const SLIVER_AREA = 0.04;
  const SLIVER_THIN = 4;
  /** No cut more than this many beams (keel-wise) from the kill point,
   *  except the one rare far crack. */
  const FAR_BEAMS = 2;

  it.each(LEVELS)('%s: no thin sliver anywhere', (_name, kb, rr) => {
    let slivers = 0;
    let worst = 0;
    for (let seed = 1; seed <= V7_SEEDS; seed++) {
      for (const p of v7Shatter(seed, kb, rr).pieces) {
        if (p.area >= SLIVER_AREA * HULL_AREA) continue;
        const t = thinness(p.outline);
        worst = Math.max(worst, t);
        if (t > SLIVER_THIN) slivers++;
      }
    }
    console.log(`[v7 sliver] ${_name}: worst small-piece length/width ${worst.toFixed(1)}`);
    expect(slivers, `pieces under ${SLIVER_AREA * 100} % of the hull and over ${SLIVER_THIN}× longer than wide; v6 had 14–129 over this sweep`).toBe(0);
  });

  // Filmed take 2026-11-13 (heavy cruiser, port-side hit amidships): a fan
  // crack left a long thin triangle along the port edge. It was bigger than
  // 4 % of the hull, so the small-sliver test above let it through. So for
  // pieces of ANY size: none narrower than MIN_BEAMS (across its long
  // axis), and none narrower than a hull section (HULL_SECTION_BEAMS) more
  // than LONG_THIN× longer than it is wide. Before the fix the sweep had
  // pieces 3.5× long and 0.41 beams wide. Exempt: the bow and stern
  // sections (the pieces holding a hull tip), which keep the hull's own
  // shape (this hull is ~9.6 beams long, so a whole end section is 4–6×
  // longer than wide), and a section a full beam wide, which is not thin.
  const LONG_THIN = 3;
  const MIN_BEAMS = 0.45;
  const HULL_SECTION_BEAMS = 0.9;
  const holdsTip = (o: ReadonlyArray<V>): boolean => o.some((v) => v.y <= minY + 0.005 * L || v.y >= maxY - 0.005 * L);
  it.each(LEVELS)('%s: no long thin piece of any size', (_name, kb, rr) => {
    const bad: string[] = [];
    let worst = 0;
    let narrowest = Infinity;
    for (let seed = 1; seed <= V7_SEEDS; seed++) {
      for (const p of v7Shatter(seed, kb, rr).pieces) {
        if (holdsTip(p.outline)) continue;
        const t = lengthOverWidth(p.outline);
        const w = widthAcross(p.outline) / B;
        narrowest = Math.min(narrowest, w);
        if (w >= HULL_SECTION_BEAMS) continue;
        worst = Math.max(worst, t);
        if (t > LONG_THIN || w < MIN_BEAMS) bad.push(`seed ${seed}: ${t.toFixed(1)}× longer than wide, ${w.toFixed(2)} beams wide (${(100 * p.area / HULL_AREA).toFixed(1)} % of the hull)`);
      }
    }
    console.log(`[v7 long thin] ${_name}: worst length/width (under a hull section wide) ${worst.toFixed(2)}, narrowest ${narrowest.toFixed(2)} beams`);
    expect(bad, `pieces over ${LONG_THIN}× longer than wide or under ${MIN_BEAMS} beams wide`).toEqual([]);
  });

  // Filmed take 2026-11-13 (heavy cruiser, 16" salvo amidships): two cracks
  // seemed to run side by side ~40–50 u apart with a thin strip between
  // them. That strip was the glow over one crack's opening gap (see
  // `swarmSpriteUpdater.wreckArt.test.ts`), but the geometry rule it asked
  // about must hold too: no two distinct cracks run near-parallel closer
  // than MIN_BEAMS over any real stretch. Before the fix, the primary line
  // and a zone crack could come to 0.43 beams (zone 0.75 beams off at the
  // kill point's edge, tilted 0.25 more than a primary already tilted 0.35:
  // 0.5 beams keel-wise at the far edge, 0.43 across the cracks).
  const PARALLEL_DEG = 12;
  it.each(LEVELS)('%s: no two cracks run near-parallel closer than 0.45 beams', (_name, kb, rr) => {
    const sinMax = Math.sin((PARALLEL_DEG * Math.PI) / 180);
    let worst = Infinity;
    const bad: string[] = [];
    for (let seed = 1; seed <= 2 * V7_SEEDS; seed++) {
      const chords = crackChords(v7Shatter(seed, kb, rr).pieces);
      for (const [a, b] of chords) {
        const el = Math.hypot(b.x - a.x, b.y - a.y);
        if (el < 0.25 * B) continue;
        const ux = (b.x - a.x) / el;
        const uy = (b.y - a.y) / el;
        for (const [c, d] of chords) {
          if (c === a) continue;
          const fl = Math.hypot(d.x - c.x, d.y - c.y);
          if (fl < 1e-9 || Math.abs((ux * (d.y - c.y) - uy * (d.x - c.x)) / fl) > sinMax) continue;
          // Over the stretch where the two run side by side (projected on
          // this crack), the least distance between them.
          const t0 = (c.x - a.x) * ux + (c.y - a.y) * uy;
          const t1 = (d.x - a.x) * ux + (d.y - a.y) * uy;
          const lo = Math.max(0, Math.min(t0, t1));
          const hi = Math.min(el, Math.max(t0, t1));
          if (hi - lo < 0.25 * B) continue;
          const off = (t: number): number => {
            const k = (t - t0) / (t1 - t0);
            const px = c.x + (d.x - c.x) * k - a.x;
            const py = c.y + (d.y - c.y) * k - a.y;
            return Math.abs(px * -uy + py * ux);
          };
          const dist = Math.min(off(lo), off(hi));
          worst = Math.min(worst, dist / B);
          if (dist < MIN_BEAMS * B) bad.push(`seed ${seed}: two cracks ${(dist / B).toFixed(2)} beams apart over ${((hi - lo) / B).toFixed(2)} beams`);
        }
      }
    }
    console.log(`[v7 parallel] ${_name}: closest near-parallel cracks ${worst.toFixed(2)} beams`);
    expect(bad, 'near-parallel cracks under 0.45 beams apart').toEqual([]);
  });

  it.each(LEVELS)('%s: no cut far from the kill point (a far crack only rarely, on a very heavy blow, and one at most)', (_name, kb, rr) => {
    let withFar = 0;
    for (let seed = 1; seed <= V7_SEEDS; seed++) {
      const { pieces, kill } = v7Shatter(seed, kb, rr);
      let farChords = 0;
      for (const p of pieces) {
        for (const [a, b] of cutChords(p)) if (Math.abs((a.y + b.y) / 2 - kill.y) > FAR_BEAMS * B) farChords++;
      }
      if (farChords > 0) withFar++;
      // One crack across the hull is two chords (one on each piece beside it).
      expect(farChords, `seed ${seed}: at most one far crack`).toBeLessThanOrEqual(2);
    }
    console.log(`[v7 far] ${_name}: ${withFar}/${V7_SEEDS} fractures with a far crack`);
    if (kb < 1) expect(withFar, 'no far crack below a very heavy blow; v6 had them on most').toBe(0);
    else expect(withFar / V7_SEEDS, 'far cracks are rare; v6 had them on every fracture').toBeLessThanOrEqual(0.2);
  });

  it.each(LEVELS.slice(0, 3))('%s: 2–5 pieces sit at the kill point', (_name, kb, rr) => {
    let lo = Infinity;
    let hi = 0;
    for (let seed = 1; seed <= V7_SEEDS; seed++) {
      const { pieces, kill } = v7Shatter(seed, kb, rr);
      let near = 0;
      for (const p of pieces) if (Math.hypot(p.centroid.x - kill.x, p.centroid.y - kill.y) <= 1.5 * B) near++;
      lo = Math.min(lo, near);
      hi = Math.max(hi, near);
    }
    console.log(`[v7 near] ${_name}: ${lo}..${hi} pieces centred within 1.5 beams of the kill point`);
    expect(lo, 'at least two pieces at the kill point').toBeGreaterThanOrEqual(2);
    expect(hi, 'at most five pieces at the kill point; v6 had 10–30').toBeLessThanOrEqual(5);
  });

  it.each(LEVELS.slice(0, 2))('%s: the rest of the hull stays as one or two big sections each side', (_name, kb, rr) => {
    for (let seed = 1; seed <= V7_SEEDS; seed++) {
      const { pieces, kill } = v7Shatter(seed, kb, rr);
      let fore = 0;
      let aft = 0;
      for (const p of pieces) {
        const d = p.centroid.y - kill.y;
        if (d < -1.5 * B) fore++;
        else if (d > 1.5 * B) aft++;
      }
      expect(fore, `seed ${seed}: sections fore of the impact`).toBeLessThanOrEqual(2);
      expect(aft, `seed ${seed}: sections aft of the impact`).toBeLessThanOrEqual(2);
    }
  });
});
