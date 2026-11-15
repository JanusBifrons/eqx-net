/**
 * Fracture v10: a capital cut kill's splinter cracks (hostile film reviews
 * 2026-11-15, a heavy-beam slice and a railgun channel on a heavy cruiser:
 * v9's secondary cracks ran nearly straight, full beam, PARALLEL to the cut
 * either side, so one shot read as three cuts). Owner: "The main cut is dead
 * straight. Splinter cracks stay jagged. The piece count follows the existing
 * violence table."
 *
 * Every secondary crack (`cutEdges` kind 4, a crack) of a slice or channel
 * kill on a heavy cruiser, battleship or destroyer must:
 *  - run well off the cut's direction (>= MIN_ANGLE_DEG),
 *  - be visibly jagged (its vertices stray from its chord), and
 *  - never run the hull's whole width along the cut.
 * The piece count stays what the violence table gave v9.
 */
import { describe, expect, it } from 'vitest';
import { fractureHull, fracturePlan, projectToOutline, FRACTURE_MAX_PIECES, type FracturePiece } from './fractureHull.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';
import { RAILGUN_BOLT_WIDTH } from '../../shared-types/combat/navalGuns.js';

type V = { x: number; y: number };

/** `cutEdges` kind of a crack (zone, fan, far, and v10 splinters). */
const EDGE_CRACK = 4;
const MIN_ANGLE_DEG = 25;
/** Least stray of a crack's vertices from its chord, over the chord. */
const MIN_JAG = 0.02;
/** Least mean stray over every crack of one hull and cut kind. */
const MIN_MEAN_JAG = 0.09;
/** A crack this short (fraction of the beam) between two junctions is a
 *  stub, too short to read as a line either way. */
const STUB_BEAMS = 0.25;
/** Mean piece count over each sweep under v9 (the violence table's count,
 *  measured 2026-11-15 before the v10 change). */
const V9_MEAN_PIECES: Readonly<Record<string, number>> = {
  'heavy-cruiser slice': 4.576, 'heavy-cruiser channel': 4.576,
  'battleship slice': 4.653, 'battleship channel': 4.66,
  'destroyer slice': 4.403, 'destroyer channel': 4.403,
};

/** Each crack as a polyline: the crack-kind edges of all pieces, joined at
 *  shared vertices and split where three or more meet. */
function crackChains(pieces: ReadonlyArray<FracturePiece>): V[][] {
  const key = (p: V): string => `${Math.round(p.x * 64)},${Math.round(p.y * 64)}`;
  const at = new Map<string, V>();
  const adj = new Map<string, Set<string>>();
  for (const p of pieces) {
    for (let i = 0; i < p.outline.length; i++) {
      if (p.cutEdges[i] !== EDGE_CRACK) continue;
      const a = p.outline[i]!;
      const b = p.outline[(i + 1) % p.outline.length]!;
      const ka = key(a);
      const kb = key(b);
      at.set(ka, a);
      at.set(kb, b);
      if (!adj.has(ka)) adj.set(ka, new Set());
      if (!adj.has(kb)) adj.set(kb, new Set());
      adj.get(ka)!.add(kb);
      adj.get(kb)!.add(ka);
    }
  }
  const used = new Set<string>();
  const ek = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const out: V[][] = [];
  const starts = [...adj.keys()].filter((k) => adj.get(k)!.size !== 2).concat([...adj.keys()]);
  for (const s of starts) {
    for (const nb of adj.get(s)!) {
      if (used.has(ek(s, nb))) continue;
      used.add(ek(s, nb));
      const chain = [at.get(s)!];
      let prev = s;
      let cur = nb;
      for (;;) {
        chain.push(at.get(cur)!);
        if (adj.get(cur)!.size !== 2) break;
        const next = [...adj.get(cur)!].find((x) => x !== prev)!;
        if (used.has(ek(cur, next))) break;
        used.add(ek(cur, next));
        prev = cur;
        cur = next;
      }
      out.push(chain);
    }
  }
  return out;
}

/** Chord length, angle off the cut direction (deg), stray over chord and
 *  extent along the cut direction. */
function measure(c: ReadonlyArray<V>, d: V): { len: number; angle: number; jag: number; along: number } {
  const a = c[0]!;
  const b = c[c.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let stray = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const dl = Math.hypot(d.x, d.y);
  for (const p of c) {
    stray = Math.max(stray, Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len);
    const t = (p.x * d.x + p.y * d.y) / dl;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  const cos = Math.min(1, Math.abs(dx * d.x + dy * d.y) / (len * dl));
  return { len, angle: (Math.acos(cos) * 180) / Math.PI, jag: stray / len, along: hi - lo };
}

/** Length of the hull's chord along the line through k along d. */
function chordOf(pts: ReadonlyArray<V>, k: V, d: V): number {
  const dl = Math.hypot(d.x, d.y);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const da = ((a.x - k.x) * -d.y + (a.y - k.y) * d.x) / dl;
    const db = ((b.x - k.x) * -d.y + (b.y - k.y) * d.x) / dl;
    if ((da < 0) === (db < 0)) continue;
    const s = da / (da - db);
    const t = ((a.x + (b.x - a.x) * s - k.x) * d.x + (a.y + (b.y - a.y) * s - k.y) * d.y) / dl;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return hi - lo;
}

const KINDS = ['heavy-cruiser', 'battleship', 'destroyer'] as const;
const SEEDS = 8;
const STATIONS = [0.35, 0.5, 0.65];
/** A beam shot from starboard and a quartering one (hull frame, Pixi-up). */
const DIRS: ReadonlyArray<V> = [{ x: -1, y: 0.1 }, { x: -1, y: 0.5 }];
const LEVELS: ReadonlyArray<readonly [number, number]> = [[0.3, 0.4], [0.8, 0.6], [1.2, 1.5]];

function sweep(id: (typeof KINDS)[number], cut: 'slice' | 'channel') {
  const kind = getShipKind(id);
  const hull = shipHullOutline(kind);
  const pts = hull.map(([x, y]) => ({ x, y }));
  let x1 = -Infinity;
  let x0 = Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const beam = x1 - x0;
  const width = RAILGUN_BOLT_WIDTH / shipShapeScale(kind);
  const runs: Array<{ tag: string; pieces: FracturePiece[]; target: number; dir: V; chord: number }> = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const f of STATIONS) {
      const k = projectToOutline(hull, { x: 0.6 * x1, y: y0 + f * (y1 - y0) });
      for (const dir of DIRS) {
        for (const [kb, rr] of LEVELS) {
          const input = {
            hull, seed: seed * 7919, killPoint: k, maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: kb, recentDamageRate: rr,
            snapChance: 0, cut: { kind: cut, dirX: dir.x, dirY: dir.y, width },
          };
          const plan = fracturePlan(input);
          runs.push({
            tag: `${id} ${cut} seed ${seed} at ${f} dir ${dir.y} kb ${kb}`,
            pieces: fractureHull(input),
            target: plan.targetPieces,
            dir,
            chord: chordOf(pts, plan.primary!.point, dir),
          });
        }
      }
    }
  }
  return { beam, runs };
}

describe('fracture v10: a cut kill splinters off the cut, never alongside it', () => {
  for (const id of KINDS) {
    for (const cut of ['slice', 'channel'] as const) {
      it(`${id} ${cut}: every splinter crack is jagged and runs well off the cut`, () => {
        const { beam, runs } = sweep(id, cut);
        let jagSum = 0;
        let cracks = 0;
        let pieces = 0;
        for (const r of runs) {
          pieces += r.pieces.length;
          expect(r.pieces.length, `${r.tag}: the violence table's cap`).toBeLessThanOrEqual(r.target);
          for (const c of crackChains(r.pieces)) {
            const m = measure(c, r.dir);
            if (m.len < STUB_BEAMS * beam) continue;
            cracks++;
            jagSum += m.jag;
            expect(m.angle, `${r.tag}: a crack runs alongside the cut`).toBeGreaterThanOrEqual(MIN_ANGLE_DEG);
            expect(m.jag, `${r.tag}: a crack is a straight line`).toBeGreaterThanOrEqual(MIN_JAG);
            expect(m.along / r.chord, `${r.tag}: a crack spans the whole cut`).toBeLessThan(0.9);
          }
        }
        expect(cracks, 'the sweep has splinter cracks').toBeGreaterThan(runs.length);
        expect(jagSum / cracks, 'mean jag').toBeGreaterThanOrEqual(MIN_MEAN_JAG);
        // The count follows the violence table as in v9 (the mean over the
        // sweep within half a piece).
        const mean = pieces / runs.length;
        console.log(`${id} ${cut}: mean pieces ${mean.toFixed(3)}, cracks ${cracks}, mean jag ${(jagSum / cracks).toFixed(3)}`);
        expect(Math.abs(mean - V9_MEAN_PIECES[`${id} ${cut}`]!), `mean pieces ${mean}`).toBeLessThanOrEqual(0.5);
      });
    }
  }
});
