/**
 * AI steering slice 2c: combat movement resolves through context steering
 * with same-side separation (`shipTuning(kind).combatSeparation`).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import type { AiEntity, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

const DRONE = getShipKind('fighter');
const SEP = shipTuning(DRONE).combatSeparation;

interface Nb { id: string; x: number; y: number; side: string; pilot?: boolean }

/** Brute-force neighbour query over a fixed list (nearest first). */
function query(list: Nb[]): IAiNeighbourQuery {
  return {
    count: list.length,
    queryNeighbours(x, y, r, maxK, out, excludeId) {
      const hits = list
        .map((e, i) => ({ i, d: Math.hypot(e.x - x, e.y - y), id: e.id }))
        .filter((h) => h.d <= r && h.id !== excludeId)
        .sort((a, b) => a.d - b.d || a.i - b.i);
      const n = Math.min(hits.length, maxK, out.length);
      for (let k = 0; k < n; k++) out[k] = hits[k]!.i;
      return n;
    },
    idAt: (i) => list[i]!.id,
    xAt: (i) => list[i]!.x,
    yAt: (i) => list[i]!.y,
    vxAt: () => 0,
    vyAt: () => 0,
    radiusAt: () => DRONE.radius,
    sideAt: (i) => list[i]!.side,
    isPilotAt: (i) => list[i]!.pilot === true,
    isCapitalAt: () => false,
  };
}

const SELF: AiEntity = { id: 'd1', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
// A robot far up +y: drones engage robots on sight, approach along +y.
const ROBOT: AiSwarmView = { id: 'r1', x: 0, y: 1400, vx: 0, vy: 0, allegiance: 'robots' };

function steerWith(neighbours: Nb[] | undefined) {
  const b = new HostileDroneBehaviour(DRONE);
  const view: AiWorldView = {
    players: [], tick: 100, dtSec: 1 / 60, swarms: [ROBOT],
    ...(neighbours ? { neighbours: query(neighbours) } : {}),
  };
  b.tick(SELF, view);
  return b.lastCombatSteer();
}

/** Angle (rad) between the steer heading and +y (the approach line). */
function offApproach(s: { dirX: number; dirY: number }): number {
  return Math.abs(Math.atan2(s.dirX, s.dirY));
}

describe('HostileDroneBehaviour — combat context steering (slice 2c)', () => {
  it('flies straight down the approach line with no neighbours', () => {
    const s = steerWith([]);
    expect(s).not.toBeNull();
    expect(offApproach(s!)).toBeLessThan(0.2);
  });

  it('a wingman dead ahead on the approach line deflects the desired heading', () => {
    const s = steerWith([{ id: 'd2', x: 0, y: SEP * 0.4, side: 'drones' }]);
    expect(s).not.toBeNull();
    expect(offApproach(s!)).toBeGreaterThan(Math.PI / 6);
  });

  it('an enemy (other side) ahead is not separation danger', () => {
    const s = steerWith([{ id: 'r9', x: 0, y: SEP * 0.4, side: 'robots' }]);
    expect(offApproach(s!)).toBeLessThan(0.2);
  });

  it('a pilot ahead is not danger for drones (not friendly to players)', () => {
    const s = steerWith([{ id: 'p1', x: 0, y: SEP * 0.4, side: 'players', pilot: true }]);
    expect(offApproach(s!)).toBeLessThan(0.2);
  });

  it('without view.neighbours the context path is not used (old behaviour)', () => {
    expect(steerWith(undefined)).toBeNull();
  });

  it('combatSeparation is size-derived (#18): a capital spaces wider than a fighter', () => {
    const cap = getShipKind('battleship');
    expect(shipTuning(cap).combatSeparation).toBeGreaterThan(SEP);
    expect(shipTuning(cap).combatSeparation).toBeGreaterThanOrEqual(cap.radius * 2.4);
  });
});
