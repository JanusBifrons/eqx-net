/**
 * Structure break-up: a destroyed structure breaks like a ship, scaled by
 * size: at a ship's rate it snaps cleanly in two (owner: "structures snap
 * cleanly in two like ships"); otherwise its pieces reach its area cap
 * (`fractureCapFor`), or one short, wherever it is hit (centre,
 * off-centre, a face, a corner), never a sliver. Ships and rocks break
 * exactly as before (a fingerprint of their pieces is locked).
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, wreckPieceGeometry, type WreckFractureInputs } from './wreckPieces.js';
import { fracturePlan } from './fractureHull.js';
import { structureWreckSource } from './wreckSource.js';
import { isGateKind } from '../structures/gateGeometry.js';
import { asteroidShapeSeed } from '../swarm/asteroidShape.js';
import { fnvMixU32 } from '../random/rng.js';
import { DESTRUCTION_PROFILES, fractureCapFor } from '../../shared-types/shipScale/destruction.js';
import { STRUCTURE_KINDS_LIST, type StructureKindId } from '../../shared-types/structureKinds.js';

const STILL = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 };
const SEEDS = Array.from({ length: 24 }, (_, i) => (i + 1) * 7919);

/** Whether a structure's death by `seed` is a clean snap (the plan's seeded
 *  draw against the profile's chance; any kill point). */
function snaps(k: StructureKindId, seed: number): boolean {
  const src = structureWreckSource({ k });
  const opts = src.profile.fracture!;
  return fracturePlan({
    hull: src.outline, seed, killPoint: { x: 0, y: 0 }, maxPieces: fractureCapFor(opts, src.area), snapChance: opts.snapChance,
  }).snap;
}

/** Pieces per seed, split into shatters and clean snaps. */
function counts(k: StructureKindId, kx: number, ky: number): { cap: number; pieces: number[]; snapPieces: number[]; minShare: number } {
  const src = structureWreckSource({ k });
  const cap = fractureCapFor(src.profile.fracture!, src.area);
  const pieces: number[] = [];
  const snapPieces: number[] = [];
  let minShare = 1;
  for (const seed of SEEDS) {
    const b = buildWreckPieces({
      kindId: src, pose: STILL, killWorld: { x: kx * src.radius, y: ky * src.radius }, attackerWorld: null,
      seed, killBlowDamage: 0.5, recentDamageRate: 0.3,
    });
    if (snaps(k, seed)) {
      snapPieces.push(b.pieces.length);
      continue;
    }
    pieces.push(b.pieces.length);
    for (const p of b.pieces) minShare = Math.min(minShare, p.area / src.area);
  }
  return { cap, pieces, snapPieces, minShare };
}

// Kill points as a share of the structure's radius (the fracture projects
// each onto the outline).
const HITS: Record<string, [number, number]> = {
  centre: [0, 0], offCentre: [0.3, 0.2], face: [2, 0], corner: [2, 2], skew: [-1.4, 0.6],
};

describe('a structure snaps in two or breaks to its cap (owner: same break as ships, scaled by size)', () => {
  const kinds = STRUCTURE_KINDS_LIST.filter((k) => !isGateKind(k.id)).map((k) => k.id as StructureKindId);
  for (const k of kinds) {
    it(k, () => {
      for (const [name, [x, y]] of Object.entries(HITS)) {
        const { cap, pieces, snapPieces, minShare } = counts(k, x, y);
        // A clean snap: exactly two pieces.
        for (const n of snapPieces) expect(n, `${k} ${name} snap`).toBe(2);
        const lo = Math.max(1, cap - 1);
        for (const n of pieces) expect(n, `${k} ${name}`).toBeGreaterThanOrEqual(lo);
        for (const n of pieces) expect(n, `${k} ${name}`).toBeLessThanOrEqual(cap);
        // No sliver: every piece holds a fair share of an even split (the
        // fracture guards a quarter of one before the jag; the jag on a long
        // wedge edge moves a little of it).
        if (cap > 1) expect(minShare, `${k} ${name}`).toBeGreaterThan(0.15 / cap);
      }
    });
  }

  it("snaps at a ship's rate (the sub-cap profile's chance) over a seed sweep", () => {
    const chance = DESTRUCTION_PROFILES.subcap.fracture!.snapChance;
    expect(DESTRUCTION_PROFILES.structure.fracture!.snapChance).toBe(chance);
    const seeds = Array.from({ length: 1000 }, (_, i) => (i + 1) * 104729);
    const share = seeds.filter((seed) => snaps('capital', seed)).length / seeds.length;
    expect(share).toBeGreaterThan(chance - 0.04);
    expect(share).toBeLessThan(chance + 0.04);
    // ...and the 24-seed sweep above holds both kinds of break.
    expect(counts('capital', 0, 0).snapPieces.length).toBeGreaterThan(0);
    expect(counts('capital', 0, 0).pieces.length).toBeGreaterThan(0);
  });

  it('the in-game cases (shatters): base Capital reaches 6 or 5; cargo bay and refinery at least 3', () => {
    for (const [x, y] of Object.values(HITS)) {
      for (const n of counts('capital', x, y).pieces) expect(n).toBeGreaterThanOrEqual(5);
      for (const n of counts('cargo_bay', x, y).pieces) expect(n).toBeGreaterThanOrEqual(3);
      for (const n of counts('refinery', x, y).pieces) expect(n).toBeGreaterThanOrEqual(3);
    }
  });
});

/** FNV over every piece's outline, area and edge kinds. */
function fingerprint(all: WreckFractureInputs[]): string {
  let h = 0x811c9dc5;
  let n = 0;
  for (const inp of all) {
    for (const g of wreckPieceGeometry(inp)) {
      n++;
      const nums = [g.cx, g.cy, g.area, g.mass, ...g.outline.flatMap((v) => [v.x, v.y]), ...g.cutEdges];
      for (const v of nums) h = fnvMixU32(h, Math.round(v * 1e6) | 0);
    }
  }
  return `${n}:${(h >>> 0).toString(16)}`;
}

describe('ships and rocks break exactly as before', () => {
  const ROCK = { id: 'belt-0-7', shape: asteroidShapeSeed('belt-0-7'), r: 60 };
  it('ship and rock pieces are unchanged', () => {
    const ins: WreckFractureInputs[] = [];
    for (const kindId of ['battleship', 'heavy-cruiser', 'destroyer', 'fighter'] as const) {
      for (const seed of [1, 77, 4242, 31337]) {
        for (const snapChance of [0, 0.2]) {
          ins.push({ kindId, seed, killX: 40, killY: -30, killBlowDamage: 0.6, recentDamageRate: 0.4, snapChance });
          ins.push({ kindId, seed, killX: -10, killY: 90, killBlowDamage: 0.1, recentDamageRate: 0, snapChance, cutKind: 'slice', cutAng: 9000 });
        }
      }
    }
    for (const seed of [3, 11, 99]) {
      ins.push({ rock: ROCK, seed, killX: -60, killY: 3, killBlowDamage: 0, recentDamageRate: 0, snapChance: 0.2 });
      ins.push({ rock: ROCK, seed, killX: -60, killY: 3, killBlowDamage: 0, recentDamageRate: 0, snapChance: 0.2, cutKind: 'slice', cutAng: 0 });
    }
    expect(fingerprint(ins)).toBe('256:f20b0e8');
  });
});
