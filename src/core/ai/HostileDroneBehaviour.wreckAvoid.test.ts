/**
 * An AI pilot steers around wreck pieces the way it steers around ships
 * (take 11 "ghost ship", 2026-11-14): a ship that flew through a dead ship's
 * pieces caught a slowed one on its shield bubble and carried it along for
 * seconds, so the piece read as a live ship flying in formation. The brain
 * reads the pieces from `view.debris` and clears them by the shared
 * `hullClearance` rule (both shield bubbles + a radius).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { stepKinematic, type KinematicBody } from './pilotTestKit.js';
import { hullClearance } from './tactics/manoeuvre.js';
import type { AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';

const K = getShipKind('fighter');
const KT = getShipKind('patrol-fighter');
/** A sub-cap wreck piece's size (a fighter's pieces run ~10-25 u). */
const PIECE_R = 20;

/** A static point index: `pts` with the given radius. */
function points(pts: KinematicBody[], ids: string[], radius: number, side: string): IAiNeighbourQuery {
  return {
    get count() { return pts.length; },
    queryNeighbours: (x, y, r, maxK, out, excludeId) => {
      let n = 0;
      for (let i = 0; i < pts.length && n < maxK && n < out.length; i++) {
        if (ids[i] === excludeId) continue;
        if (Math.hypot(pts[i]!.x - x, pts[i]!.y - y) <= r) out[n++] = i;
      }
      return n;
    },
    idAt: (i) => ids[i]!, xAt: (i) => pts[i]!.x, yAt: (i) => pts[i]!.y,
    vxAt: (i) => pts[i]!.vx, vyAt: (i) => pts[i]!.vy,
    radiusAt: () => radius, sideAt: () => side, isPilotAt: () => false, isCapitalAt: () => false,
  };
}

interface Run { minD: number; maxLateral: number; avoidTicks: number }

/** A fighter flies at a hostile parked 2400 u ahead with a wreck piece dead
 *  ahead on its course at 900 u. `withDebris` hands the brain the piece. */
function flyAtPiece(withDebris: boolean): Run {
  const A: KinematicBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const T: KinematicBody = { x: 0, y: 2400, vx: 0, vy: 0, angle: Math.PI, angvel: 0 };
  const P: KinematicBody = { x: 0, y: 900, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const b = new HostileDroneBehaviour(K);
  b.markHostile('t', 0);
  const nb = points([T], ['t'], KT.radius, 'traders');
  const debris = points([P], ['w:1'], PIECE_R, '');
  let minD = Infinity;
  let maxLateral = 0;
  for (let t = 1; t <= 12 * 60; t++) {
    const view: AiWorldView = {
      players: [], tick: t, dtSec: 1 / 60, neighbours: nb,
      swarms: [{ id: 't', x: T.x, y: T.y, vx: 0, vy: 0, allegiance: 'traders' }],
      ...(withDebris ? { debris } : {}),
    };
    stepKinematic(A, K, b.tick({ id: 'a', ...A }, view));
    // Past the piece's line only once the ship is level with it.
    if (A.y < P.y + 400) {
      const d = Math.hypot(A.x - P.x, A.y - P.y);
      if (d < minD) minD = d;
      if (Math.abs(A.x) > maxLateral) maxLateral = Math.abs(A.x);
    }
  }
  return { minD, maxLateral, avoidTicks: b.getAvoidTicks() };
}

describe('HostileDroneBehaviour — wreck piece avoidance', () => {
  const clear = hullClearance(K.radius, PIECE_R, shipTuning(K).shieldPad);

  it('a wreck piece dead ahead on its course: the pilot turns aside and keeps clear by the clearance', () => {
    const r = flyAtPiece(true);
    const msg = `minD=${r.minD.toFixed(1)} lateral=${r.maxLateral.toFixed(1)} avoid=${r.avoidTicks} clear=${clear.toFixed(1)}`;
    console.log(msg);
    expect(r.avoidTicks, msg).toBeGreaterThan(0);
    expect(r.maxLateral, msg).toBeGreaterThan(0.5 * clear);
    expect(r.minD, msg).toBeGreaterThanOrEqual(clear);
  });

  it('control: without the pieces in its view the same course runs through the piece', () => {
    const r = flyAtPiece(false);
    console.log(`control minD=${r.minD.toFixed(1)} clear=${clear.toFixed(1)}`);
    expect(r.minD).toBeLessThan(clear);
  });
});
