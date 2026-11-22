/**
 * Structure break-up: a shattered structure's pieces are chunky wedges,
 * never needles (capital-destruction.md "Structures"). Radial cracks fanned
 * from the kill point itself cut a hit near a face or corner into long thin
 * wedges reaching across the hull (worst slenderness 0.018); they now fan
 * from a centre pulled most of the way to the centroid (`radialCracks`).
 *
 * Slenderness: piece area ÷ (its longest vertex-to-vertex span)², a square
 * 0.5, a 1 × 10 strip 0.01. The bound is the worst ship wreck piece over the
 * same seeds and hits (a capital's, ~0.077): no structure piece is
 * thinner than the thinnest piece a ship breaks into. Clean snaps (two
 * halves, like a ship's) are not radial and not checked here.
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, wreckPieceGeometry } from './wreckPieces.js';
import { fracturePlan } from './fractureHull.js';
import { shipWreckSource, structureWreckSource } from './wreckSource.js';
import { isGateKind } from '../structures/gateGeometry.js';
import { fractureCapFor } from '../../shared-types/shipScale/destruction.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { SHIP_KINDS_LIST, type ShipKindId } from '../../shared-types/shipKinds.js';
import { STRUCTURE_KINDS_LIST, type StructureKindId } from '../../shared-types/structureKinds.js';

const STILL = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0 };
const SEEDS = Array.from({ length: 24 }, (_, i) => (i + 1) * 7919);
/** Kill points in radii: centre, off-centre, faces, corners. */
const HITS: ReadonlyArray<readonly [number, number]> = [[0, 0], [0.3, 0.2], [2, 0], [2, 2], [-1.4, 0.6], [0.5, -2], [-2, -1.2]];

function slenderness(o: ReadonlyArray<{ x: number; y: number }>, area: number): number {
  let d2 = 0;
  for (let i = 0; i < o.length; i++) {
    for (let j = i + 1; j < o.length; j++) {
      const dx = o[i]!.x - o[j]!.x;
      const dy = o[i]!.y - o[j]!.y;
      d2 = Math.max(d2, dx * dx + dy * dy);
    }
  }
  return area / d2;
}

/** The thinnest piece any ship wreck breaks into over SEEDS × HITS. */
function shipWorst(): number {
  let worst = 1;
  for (const k of SHIP_KINDS_LIST) {
    if (shipTuning(k).destruction === 'none') continue;
    const r = shipWreckSource(k.id as ShipKindId).radius;
    for (const seed of SEEDS) {
      for (const [x, y] of HITS) {
        const b = buildWreckPieces({
          kindId: k.id as ShipKindId, pose: STILL, killWorld: { x: x * r, y: y * r }, attackerWorld: null,
          seed, killBlowDamage: 0.5, recentDamageRate: 0.3,
        });
        for (const g of wreckPieceGeometry(b.fracture)) worst = Math.min(worst, slenderness(g.outline, g.area));
      }
    }
  }
  return worst;
}

describe('structure shatter pieces are never needles', () => {
  const bound = shipWorst();

  it('the ship bound is a real chunk, not a needle', () => {
    expect(bound).toBeGreaterThan(0.05);
  });

  for (const kd of STRUCTURE_KINDS_LIST) {
    if (isGateKind(kd.id)) continue;
    it(`${kd.id}: every shatter piece at least as chunky as the thinnest ship piece`, () => {
      const src = structureWreckSource({ k: kd.id as StructureKindId });
      const opts = src.profile.fracture!;
      const cap = fractureCapFor(opts, src.area);
      let worst = 1;
      let who = '';
      for (const seed of SEEDS) {
        for (const [x, y] of HITS) {
          const killWorld = { x: x * src.radius, y: y * src.radius };
          if (fracturePlan({ hull: src.outline, seed, killPoint: killWorld, maxPieces: cap, snapChance: opts.snapChance }).snap) continue;
          const b = buildWreckPieces({
            kindId: src, pose: STILL, killWorld, attackerWorld: null, seed, killBlowDamage: 0.5, recentDamageRate: 0.3,
          });
          for (const g of wreckPieceGeometry(b.fracture)) {
            const s = slenderness(g.outline, g.area);
            if (s < worst) { worst = s; who = `seed ${seed} hit ${x},${y}`; }
          }
        }
      }
      expect(worst, `${kd.id} worst ${worst.toFixed(4)} at ${who} (bound ${bound.toFixed(4)})`).toBeGreaterThanOrEqual(bound);
    });
  }
});
