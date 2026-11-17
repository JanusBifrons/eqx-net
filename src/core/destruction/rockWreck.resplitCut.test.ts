/**
 * Rock cut re-splits (mining laser): a barge that isn't moving fires along
 * the same line every time. Each re-split must still break into chunky
 * pieces (ROCK_FRACTURE `chunkyPieces`), not halve the piece the long way
 * into hairline strips (448×199 → 430×75 → 420×29 before the fix).
 */
import { describe, expect, it } from 'vitest';
import { wreckPieceGeometry, type WreckFractureInputs, type WreckPieceGeometry } from './wreckPieces.js';
import { wreckChildGeometry, type WreckChildStep } from './wreckChildren.js';
import { rockWreckSource } from './wreckSource.js';
import { asteroidShapeSeed } from '../swarm/asteroidShape.js';
import { CUT_ANGLE_STEPS, cutDirFromAngle } from './fractureHull.js';
import { killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import { MINING_LASER_WIDTH } from '../combat/capitalTurretDefs.js';

const ROCK = { id: 'mine-rock-a', shape: asteroidShapeSeed('mine-rock-a'), r: 260 };
/** ROCK_FRACTURE.chunkyMinWidthBeams. */
const CHUNKY_MIN_WIDTH_BEAMS = 0.36;
const MAX_ASPECT = 3;
const POD_FLOOR = 0.06;

/** Least width and the length along it (calipers over 1° steps). */
function extent(g: WreckPieceGeometry): { width: number; length: number } {
  let width = Infinity;
  let length = 0;
  for (let k = 0; k < 180; k++) {
    const a = (k * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of g.outline) {
      const t = v.x * dx + v.y * dy;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    width = Math.min(width, hi - lo);
    length = Math.max(length, hi - lo);
  }
  return { width, length };
}

interface Node { steps: WreckChildStep[]; g: WreckPieceGeometry; gen: number; parentWidth: number }

/** Re-split every piece above the pod floor with the same laser line until
 *  only pods are left (or `maxGen`). */
function mine(angFrac: number, maxGen = 8): Node[] {
  const src = rockWreckSource(ROCK);
  const floor = POD_FLOOR * src.area;
  const cutAng = Math.round(CUT_ANGLE_STEPS * angFrac);
  const D = cutDirFromAngle(cutAng);
  const cutW = killCutStripWidth({ kind: 'slice', width: MINING_LASER_WIDTH });
  const root: WreckFractureInputs = {
    rock: ROCK, seed: 77, killX: 0, killY: 0, killBlowDamage: 0, recentDamageRate: 0, snapChance: 0.2,
    cutKind: 'slice', cutAng, cutW,
  };
  let level: Node[] = wreckPieceGeometry(root).map((g) => ({ steps: [], g, gen: 1, parentWidth: Infinity }));
  const all: Node[] = [...level];
  for (let gen = 2; gen <= maxGen && level.length > 0; gen++) {
    const next: Node[] = [];
    for (const n of level) {
      if (n.g.area < floor) continue;
      const steps = [...n.steps, {
        pieceIndex: n.g.index, killX: n.g.cx - D.x * 2000, killY: -n.g.cy - D.y * 2000,
        cutKind: 'slice' as const, cutAng, cutW,
      }];
      const kids = wreckChildGeometry({ root, steps });
      if (kids.length < 2) continue;
      const parentWidth = extent(n.g).width;
      for (const g of kids) next.push({ steps, g, gen, parentWidth });
    }
    all.push(...next);
    level = next;
  }
  return all;
}

describe('rock cut re-split: a fixed laser line still leaves chunky pieces', () => {
  for (const angFrac of [0.1, 0.35, 0.6]) {
    it(`angle ${angFrac}: rounds 1-3 stay chunky, and the rock still wears down to pods`, () => {
      const all = mine(angFrac);
      const floor = POD_FLOOR * rockWreckSource(ROCK).area;
      for (const n of all) {
        if (n.gen > 3 || n.g.area < floor) continue;
        const { width, length } = extent(n.g);
        const tag = `gen${n.gen} idx${n.g.index} ${length.toFixed(0)}x${width.toFixed(0)}`;
        expect(length / width, tag).toBeLessThanOrEqual(MAX_ASPECT);
        if (Number.isFinite(n.parentWidth)) expect(width, tag).toBeGreaterThanOrEqual(CHUNKY_MIN_WIDTH_BEAMS * n.parentWidth);
      }
      expect(all.some((n) => n.g.area < floor)).toBe(true);
      // Every branch ends in pods within the generations mined.
      const maxGen = Math.max(...all.map((n) => n.gen));
      for (const n of all) if (n.gen === maxGen) expect(n.g.area).toBeLessThan(floor);
    });
  }
});
