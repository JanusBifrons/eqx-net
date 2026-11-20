/**
 * Rock floor (job 1D-0, owner 2026-11-20 "Keep cutting smaller"): a worn
 * rock piece keeps splitting while it is heavier than an AA tractor pulls
 * (`salvageTierMass('AA')`), so a small ship's tractor can take every last
 * piece. Mines whole rocks down through the real child fracture
 * (`wreckChildGeometry`) and the real floor (`wreckCanResplit`).
 *
 * Prints, per rock: pieces, splits, piece mass and hold weight range, the
 * chunk ore all pieces carry (`OreDraw.chunkYield`: weight squared, so
 * smaller chunks carry LESS ore in total; rock MASS is what is conserved)
 * and the integrity the lasers must wear through (`wear`).
 */
import { describe, expect, it, vi } from 'vitest';
import { wreckPieceGeometry, type WreckFractureInputs, type WreckPieceGeometry } from '../../core/destruction/wreckPieces.js';
import { wreckChildGeometry, type WreckChildStep } from '../../core/destruction/wreckChildren.js';
import { rockWreckSource } from '../../core/destruction/wreckSource.js';
import { wreckCanResplit, wreckPieceIntegrity } from '../../core/destruction/wreckIntegrity.js';
import { asteroidShapeSeed } from '../../core/swarm/asteroidShape.js';
import { CUT_ANGLE_STEPS, cutDirFromAngle } from '../../core/destruction/fractureHull.js';
import { killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import { MINING_LASER_WIDTH } from '../../core/combat/capitalTurretDefs.js';
import { rockChunkWeight, salvageTierMass } from '../../core/combat/salvageTargeting.js';
import { ROCK_CHUNK_ORE_PER_WEIGHT_SQ } from './OreDraw.js';

// OreDraw's hold store opens sqlite; the ore curve needs none of it.
vi.mock('../db/PersistenceWorker.js', () => ({ getHoldStore: () => null }));

interface CutDown { pieces: number; splits: number; minMass: number; maxMass: number; mass: number; ore: number; rockMass: number; wear: number }

/** Cut rock `r` down: every piece the floor lets split is split (the laser
 *  line turns a little each generation, as a moving ship's would) until none
 *  can. A split the fracture can't make (< 2 children) leaves the piece. */
function cutDown(r: number): CutDown {
  const id = `floor-rock-${r}`;
  const rock = { id, shape: asteroidShapeSeed(id), r };
  const src = rockWreckSource(rock);
  const cutW = killCutStripWidth({ kind: 'slice', width: MINING_LASER_WIDTH });
  const angOf = (gen: number): number => Math.round(CUT_ANGLE_STEPS * ((0.13 + gen * 0.29) % 1));
  const root: WreckFractureInputs = {
    rock, seed: 77, killX: 0, killY: 0, killBlowDamage: 0, recentDamageRate: 0, snapChance: 0.2,
    cutKind: 'slice', cutAng: angOf(0), cutW,
  };
  type Node = { steps: WreckChildStep[]; g: WreckPieceGeometry };
  let level: Node[] = wreckPieceGeometry(root).map((g) => ({ steps: [], g }));
  const leaves: WreckPieceGeometry[] = [];
  let splits = 1;
  let wear = wreckPieceIntegrity(src, src.bodyMass);
  for (let gen = 1; level.length > 0 && gen < 40; gen++) {
    const next: Node[] = [];
    const cutAng = angOf(gen);
    const D = cutDirFromAngle(cutAng);
    for (const n of level) {
      if (!wreckCanResplit(src, n.g.area, n.g.radius)) { leaves.push(n.g); continue; }
      const steps = [...n.steps, {
        pieceIndex: n.g.index, killX: n.g.cx - D.x * 4000, killY: -n.g.cy - D.y * 4000, cutKind: 'slice' as const, cutAng, cutW,
      }];
      const kids = wreckChildGeometry({ root, steps });
      if (kids.length < 2) { leaves.push(n.g); continue; }
      splits++;
      wear += wreckPieceIntegrity(src, n.g.mass);
      for (const g of kids) next.push({ steps, g });
    }
    level = next;
  }
  let minMass = Infinity, maxMass = 0, mass = 0, ore = 0;
  for (const g of leaves) {
    minMass = Math.min(minMass, g.mass);
    maxMass = Math.max(maxMass, g.mass);
    mass += g.mass;
    const w = rockChunkWeight(g.mass);
    ore += Math.floor(ROCK_CHUNK_ORE_PER_WEIGHT_SQ * w * w);
  }
  return { pieces: leaves.length, splits, minMass, maxMass, mass, ore, rockMass: src.bodyMass, wear };
}

const RADII = [40, 80, 160, 260];
const runs = new Map<number, CutDown>();
const run = (r: number): CutDown => {
  let c = runs.get(r);
  if (c === undefined) { c = cutDown(r); runs.set(r, c); }
  return c;
};

describe('rock floor', () => {
  it('a rock piece keeps splitting down to what a small tractor can pull', () => {
    const aa = salvageTierMass('AA');
    for (const r of RADII) {
      const c = run(r);
      console.log(`r${r}: rock ${c.rockMass.toFixed(0)} mass, ${c.pieces} pieces (${c.splits} splits), `
        + `piece mass ${c.minMass.toFixed(1)}-${c.maxMass.toFixed(1)}, hold weight ${rockChunkWeight(c.minMass)}-${rockChunkWeight(c.maxMass)}, chunk ore ${c.ore}, wear ${c.wear.toFixed(0)}`);
    }
    for (const r of RADII) expect(run(r).maxMass, `r${r}`).toBeLessThanOrEqual(aa);
  });

  it('total rock mass is unchanged by the smaller floor', () => {
    for (const r of RADII) {
      const c = run(r);
      expect(c.mass / c.rockMass, `r${r}`).toBeGreaterThan(0.9);
      expect(c.mass, `r${r}`).toBeLessThanOrEqual(c.rockMass * 1.0001);
    }
  });
});
