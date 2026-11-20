/**
 * Rock floor (job 1D-0, owner 2026-11-20 "Keep cutting smaller"): a worn
 * rock piece keeps splitting while it is heavier than an AA tractor pulls
 * (`salvageTierMass('AA')`), so a small ship's tractor can take every last
 * piece. Mines whole rocks down through the real child fracture
 * (`wreckChildGeometry`) and the real floor (`wreckCanResplit`).
 *
 * Ore (job 1D-0b, owner 2026-11-20 "Ore shared by weight"): each rock holds
 * a fixed total (`rockOreTotal`, fitted to what a full cut paid under the
 * old 6 % floor and its 0.08 × weight² chunk curve) and a chunk carries its
 * share by weight (`chunkOreUnits`), so the smaller floor loses no ore.
 *
 * Prints, per rock: pieces, splits, piece mass and hold weight range, the
 * chunk ore all pieces carry and the integrity the lasers must wear through.
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
import { chunkOreUnits, rockOreTotal } from './OreDraw.js';

// OreDraw's hold store opens sqlite; the ore curve needs none of it.
vi.mock('../db/PersistenceWorker.js', () => ({ getHoldStore: () => null }));

/** What a full cut paid before job 1D-0b: 0.08 × chunk weight² per chunk. */
const OLD_ORE_PER_WEIGHT_SQ = 0.08;

interface CutDown {
  leaves: WreckPieceGeometry[]; pieces: number; splits: number; minMass: number; maxMass: number;
  mass: number; ore: number; oldCurve: number; rockMass: number; wear: number;
}

/** Cut rock `r` down: every piece the floor lets split is split (the laser
 *  line turns a little each generation, as a moving ship's would) until none
 *  can. A split the fracture can't make (< 2 children) leaves the piece.
 *  `oldFloor`: the floor before job 1D-0 (6 % of the rock's area). */
function cutDown(r: number, oldFloor = false): CutDown {
  const id = `floor-rock-${r}`;
  const rock = { id, shape: asteroidShapeSeed(id), r };
  const rockSrc = rockWreckSource(rock);
  const rs = rockSrc.profile.resplit!;
  const src = oldFloor ? { ...rockSrc, profile: { ...rockSrc.profile, resplit: { ...rs, splitAboveTractor: undefined } } } : rockSrc;
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
  let minMass = Infinity, maxMass = 0, mass = 0, ore = 0, oldCurve = 0;
  for (const g of leaves) {
    minMass = Math.min(minMass, g.mass);
    maxMass = Math.max(maxMass, g.mass);
    mass += g.mass;
    const w = rockChunkWeight(g.mass);
    oldCurve += Math.floor(OLD_ORE_PER_WEIGHT_SQ * w * w);
    ore += chunkOreUnits(g.mass, src.bodyMass);
  }
  return { leaves, pieces: leaves.length, splits, minMass, maxMass, mass, ore, oldCurve, rockMass: src.bodyMass, wear };
}

const RADII = [40, 80, 160, 260];
const runs = new Map<string, CutDown>();
const run = (r: number, oldFloor = false): CutDown => {
  const key = `${r}:${oldFloor}`;
  let c = runs.get(key);
  if (c === undefined) { c = cutDown(r, oldFloor); runs.set(key, c); }
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

  it('total ore in a rock is unchanged by the smaller floor', () => {
    for (const r of RADII) {
      const before = run(r, true);
      const after = run(r);
      const total = rockOreTotal(after.rockMass);
      console.log(`r${r}: ore total ${Math.round(total)}; old 6 % floor ${before.ore} (${before.pieces} chunks); AA floor ${after.ore} (${after.pieces} chunks)`);
      // Within rounding: each chunk rounds down, and the fracture keeps mass to 0.1 %.
      expect(Math.abs(after.ore - before.ore), `r${r}`).toBeLessThanOrEqual(after.pieces + before.pieces + total * 1e-3);
      expect(Math.abs(after.ore - total), `r${r}`).toBeLessThanOrEqual(after.pieces + total * 1e-3);
    }
  });

  it('each rock holds about what a full cut gave before', () => {
    // The old floor's 0.08 × weight² chunks: r40 140k, r80 484k, r160 9.3M, r260 48.6M.
    for (const r of RADII) {
      const old = run(r, true).oldCurve;
      const total = rockOreTotal(run(r).rockMass);
      console.log(`r${r}: before ${old}, now ${Math.round(total)} (${(((total - old) / old) * 100).toFixed(1)} %)`);
      expect(Math.abs(total - old) / old, `r${r}`).toBeLessThan(0.15);
    }
  });

  it('a chunk carries ore in proportion to its weight', () => {
    const c = run(160);
    const perMass = rockOreTotal(c.rockMass) / c.rockMass;
    for (const g of c.leaves) {
      const ore = chunkOreUnits(g.mass, c.rockMass);
      expect(ore).toBeLessThanOrEqual(perMass * g.mass);
      expect(ore).toBeGreaterThan(perMass * g.mass - 1);
    }
    // Twice the weight, twice the ore: the same rock pays a small ship or a Barge alike.
    expect(chunkOreUnits(2 * c.minMass, c.rockMass) / chunkOreUnits(c.minMass, c.rockMass)).toBeCloseTo(2, 2);
  });
});
