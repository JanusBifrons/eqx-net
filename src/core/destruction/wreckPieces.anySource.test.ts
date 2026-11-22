/**
 * The ship death-path geometry (`buildWreckPieces`, `hullLocalKillPoint`,
 * `hullLocalPoint`) takes any wreck source (`WreckSource`), so a structure
 * can break through the same code later. A kind id and its
 * `shipWreckSource` give the same output; a rock source works too.
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, hullLocalKillPoint, hullLocalPoint, type WreckBuildInput } from './wreckPieces.js';
import { rockWreckSource, shipWreckSource } from './wreckSource.js';
import { asteroidShapeSeed } from '../swarm/asteroidShape.js';
import { HEAVY_BEAM_WIDTH } from '../combat/WeaponCatalogue.js';
import { shipShapeScale } from '../geometry/shipHullOutline.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';

const POSE = { x: 120, y: -40, vx: 3, vy: -2, angle: 0.7, angvel: 0.05 };
const HIT = { x: 160, y: -10 };

for (const kindId of ['battleship', 'heavy-cruiser', 'destroyer'] as ShipKindId[]) {
  describe(`${kindId}: kind id and shipWreckSource agree`, () => {
    const src = shipWreckSource(kindId);
    it('hullLocalKillPoint / hullLocalPoint', () => {
      expect(hullLocalKillPoint(src, POSE, HIT)).toEqual(hullLocalKillPoint(kindId, POSE, HIT));
      expect(hullLocalPoint(src, POSE, HIT)).toEqual(hullLocalPoint(kindId, POSE, HIT));
    });
    it('buildWreckPieces (plain kill and a burned-gap slice)', () => {
      const base: Omit<WreckBuildInput, 'kindId'> = {
        pose: POSE, killWorld: HIT, attackerWorld: null, seed: 4242, killBlowDamage: 0.8, recentDamageRate: 0.5,
      };
      expect(buildWreckPieces({ ...base, kindId: src })).toEqual(buildWreckPieces({ ...base, kindId }));
      const cut = { cutKind: 'slice' as const, cutAng: 1234, cutW: HEAVY_BEAM_WIDTH / shipShapeScale(getShipKind(kindId)) };
      expect(buildWreckPieces({ ...base, ...cut, kindId: src })).toEqual(buildWreckPieces({ ...base, ...cut, kindId }));
    });
  });
}

describe('a rock source breaks through the same path', () => {
  const rock = rockWreckSource({ id: 'rock-any-source', shape: asteroidShapeSeed('rock-any-source'), r: 60 });
  const pose = { x: 10, y: 20, vx: 0, vy: 0, angle: 0.3, angvel: 0 };
  it('projects the kill point onto the rock outline and fractures it', () => {
    const k = hullLocalKillPoint(rock, pose, { x: 200, y: 20 });
    expect(Number.isFinite(k.x) && Number.isFinite(k.y)).toBe(true);
    const b = buildWreckPieces({
      kindId: rock, pose, killWorld: { x: 200, y: 20 }, attackerWorld: null, seed: 77, killBlowDamage: 0, recentDamageRate: 0,
    });
    expect(b.fracture.rock?.id).toBe('rock-any-source');
    expect(b.fracture.kindId).toBeUndefined();
    expect(b.pieces.length).toBeGreaterThan(1);
    let area = 0;
    for (const p of b.pieces) area += p.area;
    expect(area).toBeCloseTo(rock.area, 0);
  });
});
