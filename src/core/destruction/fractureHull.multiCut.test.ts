/**
 * Fracture v12 multi-cut (owner 2026-11-15, "one cut per beam"): a hull or a
 * wreck piece burned by several cutting beams breaks along EVERY line that
 * burned it, not only the last shot's. The fracture's `extraCuts` and the
 * one burn-line tracker (`BurnLines`) both sides of it: the server keeps the
 * lines, the descriptor carries them, the client rebuilds the same pieces.
 * capital-destruction.md "Multi-cut".
 */
import { describe, expect, it } from 'vitest';
import { fractureHull, EDGE_CUT, EDGE_HULL, FRACTURE_MAX_EXTRA_CUTS, type FractureExtraCut, type FractureInput } from './fractureHull.js';
import { BurnLines, BURN_LINE_SLOTS, BURN_LINE_WINDOW_TICKS, sameBurnLine } from './burnLines.js';
import { wreckChainFracture, wreckChildGeometry, type WreckChildChain } from './wreckChildren.js';
import { wreckRootFracture } from './wreckPieceFrame.js';
import { MAX_WRECK_EXTRA_CUTS } from '../../shared-types/messages/wreckDescriptor.js';
import { CUT_ANGLE_STEPS } from './fractureHull.js';

/** A 100 × 40 box, keel along x. */
const BOX: ReadonlyArray<readonly [number, number]> = [[-50, -20], [50, -20], [50, 20], [-50, 20]];

/** A clean snap (snapChance 1): no cracks, so the pieces are the cuts' cells
 *  exactly. The main cut: a vertical slice through x0. */
function boxCut(x0: number, extra?: FractureExtraCut[], width = 0, share?: number): FractureInput {
  return {
    hull: BOX, seed: 11, killPoint: { x: x0, y: 20 }, maxPieces: 8, snapChance: 1,
    cut: { kind: 'slice', dirX: 0, dirY: 1, width },
    ...(extra !== undefined ? { extraCuts: extra } : {}),
    ...(share !== undefined ? { cutBurnMinShare: share } : {}),
  };
}

const areas = (input: FractureInput): number[] =>
  fractureHull(input).map((p) => Math.round(p.area)).sort((a, b) => a - b);

const vertical = (x: number, width = 0): FractureExtraCut => ({ x, y: 0, dirX: 0, dirY: 1, width });
const horizontal = (y: number, width = 0): FractureExtraCut => ({ x: 0, y, dirX: 1, dirY: 0, width });

describe('fracture v12: extra cut lines', () => {
  it('a piece cut by 3 lines breaks along all three (every cell of the three lines)', () => {
    // Bands x ∈ [-50,-30], [-30,10], [10,50] × y ∈ [-20,5], [5,20].
    expect(areas(boxCut(10, [vertical(-30), horizontal(5)]))).toEqual([300, 500, 600, 600, 1000, 1000]);
  });

  it('every edge an extra line leaves is a straight kill-cut edge (the cut glow draws one per edge)', () => {
    for (const p of fractureHull(boxCut(10, [vertical(-30), horizontal(5)]))) {
      for (let i = 0; i < p.outline.length; i++) {
        const a = p.outline[i]!;
        const b = p.outline[(i + 1) % p.outline.length]!;
        const onBox = (a.x === b.x && Math.abs(a.x) === 50) || (a.y === b.y && Math.abs(a.y) === 20);
        expect(p.cutEdges[i]).toBe(onBox ? EDGE_HULL : EDGE_CUT);
      }
    }
  });

  it('a wide extra cut erases its strip through the channel code', () => {
    // A 10-wide strip at x = -30: banks [-50,-35] and [-25,10], then [10,50].
    expect(areas(boxCut(10, [vertical(-30, 10)]))).toEqual([600, 1400, 1600]);
  });

  it('the burn-away share applies to the pieces left after ALL the cuts; none left = vaporised', () => {
    // Bands 15 % / 45 % / 40 %: the 15 % band burns at a 0.2 share.
    expect(areas(boxCut(10, [vertical(-35)], 0, 0.2))).toEqual([1600, 1800]);
    // Four 25 % bands under a 0.3 share: nothing left.
    expect(fractureHull(boxCut(0, [vertical(-25), vertical(25)], 0, 0.3))).toEqual([]);
  });

  it('without extra cuts (or with none) a fracture is byte-identical to v11; without a main cut they are ignored', () => {
    const base = fractureHull(boxCut(10));
    expect(fractureHull(boxCut(10, []))).toEqual(base);
    const noCut: FractureInput = { hull: BOX, seed: 11, killPoint: { x: 10, y: 20 }, maxPieces: 8, snapChance: 1 };
    expect(fractureHull({ ...noCut, extraCuts: [vertical(-30)] })).toEqual(fractureHull(noCut));
  });

  it('at most FRACTURE_MAX_EXTRA_CUTS lines apply (the wire bound matches)', () => {
    expect(MAX_WRECK_EXTRA_CUTS).toBe(FRACTURE_MAX_EXTRA_CUTS);
    const four = [vertical(-40), vertical(-20), vertical(20), vertical(40)];
    expect(fractureHull(boxCut(0, four))).toHaveLength(FRACTURE_MAX_EXTRA_CUTS + 2);
  });

  it('a capital root cut kill with extra lines tiles the hull and keeps every line', () => {
    const root = { kindId: 'battleship' as const, seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9, recentDamageRate: 0.5, snapChance: 0.2, cutKind: 'slice' as const, cutAng: 31000 };
    const one = wreckRootFracture(root);
    const three = wreckRootFracture({ ...root, extraCuts: [{ x: 0, y: 0, ang: 0 }, { x: -800, y: 100, ang: 16000 }] });
    expect(three.length).toBeGreaterThan(one.length);
    const sum = (ps: typeof one) => ps.reduce((s, p) => s + p.area, 0);
    expect(sum(three)).toBeCloseTo(sum(one), -2);
  });
});

describe('re-split by several beams (wreckChildGeometry with a step\'s extraCuts)', () => {
  const root = { kindId: 'battleship' as const, seed: 7, killX: 600, killY: -200, killBlowDamage: 0.9, recentDamageRate: 0.5, snapChance: 0 };
  it('a piece cut by 3 beams gives more children than one beam, tiling the same piece; deterministic', () => {
    const pieces = wreckRootFracture(root);
    let bi = 0;
    for (let i = 1; i < pieces.length; i++) if (pieces[i]!.area > pieces[bi]!.area) bi = i;
    const big = pieces[bi]!;
    const c = big.centroid;
    const one: WreckChildChain = { root, steps: [{ pieceIndex: bi, killX: c.x, killY: c.y, cutKind: 'slice', cutAng: 16384 }] };
    const three: WreckChildChain = {
      root,
      steps: [{ ...one.steps[0]!, extraCuts: [{ x: c.x + 40, y: c.y, ang: 8192 }, { x: c.x, y: c.y + 30, ang: 0 }] }],
    };
    const a = wreckChainFracture(one);
    const b = wreckChainFracture(three);
    expect(b.length).toBeGreaterThanOrEqual(a.length + 2);
    const sum = (ps: typeof a) => ps.reduce((s, p) => s + p.area, 0);
    expect(sum(b)).toBeCloseTo(big.area, -1);
    expect(sum(a)).toBeCloseTo(big.area, -1);
    expect(wreckChildGeometry(three)).toEqual(wreckChildGeometry(three));
  });
});

describe('BurnLines: the one burn-line tracker', () => {
  // A hull at the origin, unturned, 1 world unit per 1× unit: world (x, y)
  // is hull (x, -y) (Pixi-up flips y).
  const rec = (b: BurnLines, shooter: string, tick: number, x: number, y: number, dx: number, dy: number, w = 0) =>
    b.record(shooter, tick, 0, 0, 0, 1, x, y, dx, dy, w);

  it('keeps one line per beam: a beam\'s next hit on (nearly) the same line overwrites its slot', () => {
    const b = new BurnLines(5);
    rec(b, 'lance', 100, 10, 0, 0, 1);
    rec(b, 'lance', 101, 10.5, 0, 0.01, 1);
    expect(b.liveCount(101)).toBe(1);
    // Another turret of the same ship on another line: its own slot.
    rec(b, 'lance', 101, -30, 0, 0, 1);
    expect(b.liveCount(101)).toBe(2);
  });

  it('two ships firing together both contribute lines (any shooter)', () => {
    const b = new BurnLines(5);
    rec(b, 'shipA', 100, 0, 0, 0, 1);
    rec(b, 'shipB', 100, 0, 0, 1, 0);
    // The break runs along shipA's line; shipB's crosses it: one further cut.
    const extra = b.extraCuts(100, 0, 0, 16384, 0)!;
    expect(extra).toHaveLength(1);
    expect(extra[0]!.ang).toBe(0);
    expect(Math.abs(extra[0]!.x) + Math.abs(extra[0]!.y)).toBe(0);
    expect(extra[0]!.w).toBeUndefined();
  });

  it('lines older than ~1 s of game time no longer cut', () => {
    const b = new BurnLines(5);
    rec(b, 'a', 100, 0, 0, 1, 0);
    expect(b.extraCuts(100 + BURN_LINE_WINDOW_TICKS - 1, 0, 0, 16384, 0)).toHaveLength(1);
    expect(b.extraCuts(100 + BURN_LINE_WINDOW_TICKS, 0, 0, 16384, 0)).toBeUndefined();
  });

  it('merges near-duplicates: the breaking shot\'s own line and near-parallel close beams never make a sliver', () => {
    const b = new BurnLines(5);
    // Three beams ~1° apart, crossing within 3 u: one line.
    rec(b, 'a', 100, 0, 0, 0, 1);
    rec(b, 'b', 100, 3, 0, 0.017, 1);
    rec(b, 'c', 100, -2, 0, -0.017, 1);
    expect(b.extraCuts(100, 0, 0, CUT_ANGLE_STEPS * 0.75, 0)).toBeUndefined();
    // Parallel but 40 u apart: a real second cut. Wide strips merge when the
    // gap between them is under the merge gap.
    expect(sameBurnLine(0, 0, 0, 1, 0, 40, 0, 0, 1, 0, 5)).toBe(false);
    expect(sameBurnLine(0, 0, 0, 1, 30, 33, 0, 0, 1, 30, 5)).toBe(true); // a 3 u gap between strips
    expect(sameBurnLine(0, 0, 0, 1, 30, 40, 0, 0, 1, 30, 5)).toBe(false); // a 10 u gap
    // 10° apart through one point: two cuts.
    expect(sameBurnLine(0, 0, 0, 1, 0, 0, 0, Math.sin(0.1745), Math.cos(0.1745), 0, 5)).toBe(false);
  });

  it('is bounded: at most BURN_LINE_SLOTS lines, the oldest replaced, at most FRACTURE_MAX_EXTRA_CUTS further cuts', () => {
    const b = new BurnLines(1);
    for (let i = 0; i < 8; i++) rec(b, `s${i}`, 100 + i, i * 20 - 70, 0, 0, 1);
    expect(b.liveCount(110)).toBe(BURN_LINE_SLOTS);
    const extra = b.extraCuts(110, 500, 0, 0, 0)!;
    expect(extra).toHaveLength(FRACTURE_MAX_EXTRA_CUTS);
    // Newest first: the last three shooters' lines (x = 70, 50, 30).
    expect(extra.map((c) => Math.round(c.x))).toEqual([70, 50, 30]);
  });
});
