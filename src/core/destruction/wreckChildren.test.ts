/**
 * Child fracture (salvage stream PR 3, capital-destruction.md §S4 "Re-split"):
 * a wreck piece re-fractured through the same `fractureHull`, from a chain of
 * (pieceIndex, kill point, cut) steps with seed fnvMixU32(parentSeed, index).
 * Locks: the root output is unchanged by the refactor (golden), a chain is
 * deterministic, children tile their parent, and the depth-2 sliver spike.
 */
import { describe, expect, it } from 'vitest';
import { wreckPieceGeometry, type WreckFractureInputs, type WreckPieceGeometry } from './wreckPieces.js';
import { wreckChainFracture, wreckChildGeometry, wreckChildSeed, wreckResplitOptions, type WreckChildChain } from './wreckChildren.js';
import { wreckRootFracture } from './wreckPieceFrame.js';
import { projectToOutline, EDGE_HULL, type FracturePiece } from './fractureHull.js';
import { fnvMixU32 } from '../random/rng.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';
import { getShipKind, SHIP_KINDS_LIST, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { AT_AUTHORED_SHIP_SCALE } from '../../shared-types/shipScale/config.js';

type V = { x: number; y: number };

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const hashGeom = (g: WreckPieceGeometry[]): number => hashStr(JSON.stringify(g));

function rootInputs(kindId: ShipKindId, seed: number, dir: V, cut?: Pick<WreckFractureInputs, 'cutKind' | 'cutAng' | 'cutW'>): WreckFractureInputs {
  const k = projectToOutline(shipHullOutline(getShipKind(kindId)), { x: dir.x * 1e5, y: dir.y * 1e5 });
  return { kindId, seed, killX: k.x, killY: k.y, killBlowDamage: 0.6, recentDamageRate: 0.4, snapChance: 0, ...cut };
}

/** A deterministic kill point on a piece: the midpoint of its longest edge. */
function hitOn(p: FracturePiece): V {
  let best = 0;
  let at: V = p.outline[0]!;
  for (let i = 0; i < p.outline.length; i++) {
    const a = p.outline[i]!;
    const b = p.outline[(i + 1) % p.outline.length]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > best) {
      best = l;
      at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return at;
}

/** Least width (rotating calipers over the convex hull) and length along it. */
function widthAndLength(ring: ReadonlyArray<V>): { w: number; l: number } {
  const pts = ring.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o: V, a: V, b: V): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: V[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const ch = lower.slice(0, -1).concat(upper.slice(0, -1));
  let w = Infinity;
  let l = 0;
  for (let i = 0; i < ch.length; i++) {
    const a = ch[i]!;
    const b = ch[(i + 1) % ch.length]!;
    const el = Math.hypot(b.x - a.x, b.y - a.y);
    if (el <= 0) continue;
    let d = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of ch) {
      d = Math.max(d, Math.abs((b.x - a.x) * (v.y - a.y) - (b.y - a.y) * (v.x - a.x)) / el);
      const t = ((b.x - a.x) * (v.x - a.x) + (b.y - a.y) * (v.y - a.y)) / el;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    if (d < w) {
      w = d;
      l = hi - lo;
    }
  }
  return { w, l };
}

const CAPITALS = SHIP_KINDS_LIST.filter((k) => shipTuning(k).destruction === 'capital').map((k) => k.id);
const SUBCAPS: ShipKindId[] = ['fighter', 'heavy', 'gunship', 'missile-frigate', 'robot-square', 'trader-hauler'];

describe('wreckChildGeometry: chain shape and determinism', () => {
  it('a chain with no steps is the root wreck, piece for piece', () => {
    for (const k of ['battleship', 'fighter'] as const) {
      const root = rootInputs(k, 777, { x: 1, y: 0.2 });
      expect(wreckChildGeometry({ root, steps: [] })).toEqual(wreckPieceGeometry(root));
    }
  });

  it('the child seed is fnvMixU32(parentSeed, pieceIndex)', () => {
    expect(wreckChildSeed(12345, 3)).toBe(fnvMixU32(12345, 3));
    expect(wreckChildSeed(12345, 3)).not.toBe(wreckChildSeed(12345, 4));
  });

  it('the same chain twice gives identical children (depth 2, with and without a cut)', () => {
    const root = rootInputs('heavy-cruiser', 4242, { x: 0.3, y: 1 });
    const raw = wreckRootFracture(root);
    const h0 = hitOn(raw[0]!);
    const kids = wreckChainFracture({ root, steps: [{ pieceIndex: 0, killX: h0.x, killY: h0.y }] });
    const h1 = hitOn(kids[0]!);
    const chain: WreckChildChain = {
      root,
      steps: [
        { pieceIndex: 0, killX: h0.x, killY: h0.y },
        { pieceIndex: 0, killX: h1.x, killY: h1.y, cutKind: 'slice', cutAng: 9000, cutW: 0 },
      ],
    };
    const a = wreckChildGeometry(chain);
    const b = wreckChildGeometry(JSON.parse(JSON.stringify(chain)) as WreckChildChain);
    expect(a.length).toBeGreaterThan(1);
    expect(hashGeom(a)).toBe(hashGeom(b));
  });

  it('a step naming a missing piece, or a kind that never re-splits, leaves no children', () => {
    const root = rootInputs('battleship', 1, { x: 1, y: 0 });
    expect(wreckChildGeometry({ root, steps: [{ pieceIndex: 99, killX: 0, killY: 0 }] })).toEqual([]);
    expect(wreckResplitOptions('cargo-pod')).toBeNull();
    expect(wreckResplitOptions('battleship')).not.toBeNull();
    expect(wreckResplitOptions('fighter')).not.toBeNull();
  });

  it('children tile their parent: areas and masses sum to the parent\'s (no cut)', () => {
    for (const k of ['battleship', 'destroyer', 'fighter', 'robot-square'] as const) {
      const root = rootInputs(k, 31337, { x: -1, y: 0.4 });
      const parents = wreckPieceGeometry(root);
      const raw = wreckRootFracture(root);
      for (let i = 0; i < parents.length; i++) {
        const h = hitOn(raw[i]!);
        const kids = wreckChildGeometry({ root, steps: [{ pieceIndex: i, killX: h.x, killY: h.y }] });
        const area = kids.reduce((s, g) => s + g.area, 0);
        const mass = kids.reduce((s, g) => s + g.mass, 0);
        expect(area / parents[i]!.area, `${k} piece ${i} area`).toBeCloseTo(1, 2);
        expect(mass / parents[i]!.mass, `${k} piece ${i} mass`).toBeCloseTo(1, 2);
        // Same frame as the root: the area-weighted child centroid is the parent's.
        const cx = kids.reduce((s, g) => s + g.cx * g.area, 0) / area;
        const cy = kids.reduce((s, g) => s + g.cy * g.area, 0) / area;
        const tol = 0.02 * Math.sqrt(parents[i]!.area);
        expect(Math.abs(cx - parents[i]!.cx), `${k} piece ${i} cx`).toBeLessThan(tol);
        expect(Math.abs(cy - parents[i]!.cy), `${k} piece ${i} cy`).toBeLessThan(tol);
      }
    }
  });

  it('a child edge along its parent\'s old crack keeps that crack\'s kind', () => {
    const root = rootInputs('battleship', 99, { x: 1, y: 0 });
    const raw = wreckRootFracture(root);
    const i = raw.findIndex((p) => p.cutEdges.some((k) => k !== EDGE_HULL));
    const h = hitOn(raw[i]!);
    const kids = wreckChainFracture({ root, steps: [{ pieceIndex: i, killX: h.x, killY: h.y }] });
    const parentKinds = new Set(raw[i]!.cutEdges.filter((k) => k !== EDGE_HULL));
    const inherited = kids.flatMap((c) => c.cutEdges).filter((k) => parentKinds.has(k));
    expect(inherited.length).toBeGreaterThan(0);
  });
});

describe.runIf(AT_AUTHORED_SHIP_SCALE)('wreckPieceGeometry golden: the root is unchanged by the child-fracture refactor', () => {
  it('capital, capital cut kill and sub-capital roots hash as before', () => {
    expect({
      battleship: hashGeom(wreckPieceGeometry(rootInputs('battleship', 20261115, { x: 1, y: 0.1 }))),
      cruiserSlice: hashGeom(wreckPieceGeometry(rootInputs('heavy-cruiser', 7, { x: -1, y: 0.3 }, { cutKind: 'slice', cutAng: 20000, cutW: 0 }))),
      cruiserChannel: hashGeom(wreckPieceGeometry(rootInputs('battlecruiser', 8, { x: 0.2, y: -1 }, { cutKind: 'channel', cutAng: 3000, cutW: 30 }))),
      fighter: hashGeom(wreckPieceGeometry(rootInputs('fighter', 5, { x: 0, y: 1 }))),
      robot: hashGeom(wreckPieceGeometry(rootInputs('robot-square', 6, { x: 1, y: 1 }))),
    }).toEqual(ROOT_GOLDEN);
  });
});

// Captured on main before the refactor (FRACTURE_ALGO_VERSION 10).
const ROOT_GOLDEN = { battleship: 301964545, cruiserSlice: 831653827, cruiserChannel: 256980631, fighter: 605653592, robot: 2004662851 };

interface Stats {
  roots: number;
  children: number;
  minWidthFrac: number;
  maxAspect: number;
  minShare: number;
  maxShare: number;
  maxParts: number;
}

/** Re-fracture every root piece, then every child once more (depth 2). */
function spike(kindId: ShipKindId, seed: number, dir: V, violent: boolean): { depth1: Stats; depth2: Stats } {
  const root = { ...rootInputs(kindId, seed, dir), ...(violent ? { killBlowDamage: 2, recentDamageRate: 2 } : {}) };
  const blank = (): Stats => ({ roots: 0, children: 0, minWidthFrac: Infinity, maxAspect: 0, minShare: Infinity, maxShare: 0, maxParts: 0 });
  const d1 = blank();
  const d2 = blank();
  const tally = (st: Stats, parent: FracturePiece, kids: FracturePiece[]): void => {
    const pw = widthAndLength(parent.outline).w;
    for (const c of kids) {
      const { w, l } = widthAndLength(c.outline);
      st.children++;
      st.minWidthFrac = Math.min(st.minWidthFrac, w / pw);
      st.maxAspect = Math.max(st.maxAspect, l / w);
      st.minShare = Math.min(st.minShare, c.area / parent.area);
      st.maxShare = Math.max(st.maxShare, c.area / parent.area);
      st.maxParts = Math.max(st.maxParts, c.convexParts.length);
    }
  };
  const raw = wreckRootFracture(root);
  d1.roots = raw.length;
  for (let i = 0; i < raw.length; i++) {
    const h = hitOn(raw[i]!);
    const s1 = { pieceIndex: i, killX: h.x, killY: h.y };
    const kids = wreckChainFracture({ root, steps: [s1] });
    tally(d1, raw[i]!, kids);
    for (let j = 0; j < kids.length; j++) {
      const h2 = hitOn(kids[j]!);
      const grand = wreckChainFracture({ root, steps: [s1, { pieceIndex: j, killX: h2.x, killY: h2.y }] });
      tally(d2, kids[j]!, grand);
    }
  }
  return { depth1: d1, depth2: d2 };
}

describe('child fracture spike: depth-2 sliver bounds on real hulls', () => {
  const kinds: ShipKindId[] = [...CAPITALS, ...SUBCAPS];
  it.each(kinds)('%s: every child of every piece (and grandchild) is a chunk, not a sliver', (kindId) => {
    // A bow-quarter hit (a tip section breaks off), and two violent beam
    // hits (the shattered zone's small pieces are where slivers would show).
    const cases = [[11, { x: 0.7, y: -1 }, false], [2026, { x: 1, y: 0.1 }, true], [5, { x: -1, y: 0.4 }, true]] as const;
    for (const [seed, dir, violent] of cases) {
      const { depth1, depth2 } = spike(kindId, seed, dir, violent);
      if (process.env.EQX_SPIKE_LOG) console.log(kindId, seed, JSON.stringify({ depth1, depth2 }));
      for (const [name, st] of [['depth1', depth1], ['depth2', depth2]] as const) {
        expect(st.children, `${kindId} ${name}`).toBeGreaterThan(0);
        expect(st.minWidthFrac, `${kindId} ${name} min width / parent width`).toBeGreaterThan(SPIKE.minWidthFrac);
        expect(st.maxAspect, `${kindId} ${name} aspect`).toBeLessThan(SPIKE.maxAspect);
        expect(st.minShare, `${kindId} ${name} smallest share`).toBeGreaterThan(SPIKE.minShare);
        expect(st.maxParts, `${kindId} ${name} convex parts`).toBeLessThanOrEqual(SPIKE.maxParts);
      }
    }
  });
});

// Measured 2026-11-15 over every capital kind and six sub-capitals (three
// hits each): child width >= 0.38 of its parent's, aspect <= 4.8 (a long
// hull half's own shape), smallest share >= 0.098 (a capital's optional
// third chunk), <= 21 convex parts. Bounds sit just outside those.
const SPIKE = { minWidthFrac: 0.3, maxAspect: 5.5, minShare: 0.08, maxParts: 24 };
