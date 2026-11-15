/**
 * The ships turn in an on-sight 1v1 (drone `fighter` vs `robot-square`):
 * the deterministic turning gate.
 *
 * Twelve seeded duels flown by the two brains through the virtual pilot on
 * the kinematic model of `applyShipInput` (`pilotTestKit`), each with the
 * other ship in its neighbour index (as in a room) and no pilot near (the
 * filmed shot spectates). The measure is |Δheading| sampled every 6 ticks,
 * summed per game second over both ships of every duel while in combat:
 * sampling every 6 ticks ignores tick-to-tick turn-key jitter. Exact and
 * repeatable (seeded by id; no wall clock).
 *
 * Why here and not in the room test (2026-11-14): `dogfightOnSight`'s 1v1
 * asserted mean |angvel| > 0.35 rad/s on one filmed pair. One duel turns
 * 0.25–0.51 by seed, and a room ticks in real time, so even 12 pooled duels
 * moved ±0.05 run to run: the pre-easing build (036947c6) read 0.260–0.328
 * and the current one 0.313–0.429 over 5 runs each; no bar separated them.
 * The old single-pair bar was met by that pair's seed luck.
 *
 * Calibration (this test, exact and repeatable): 036947c6 (pre-easing pilot)
 * 0.1775 rad per game second (per duel 0.165–0.187); df385748 (eased pilot +
 * run open-range fix) 0.2680 (per duel 0.226–0.339). The bar, 0.22, sits
 * about halfway: the pre-easing build fails it, the current one passes.
 * (The kinematic model runs lower than a room's Rapier body; compare builds
 * here, not with the room's numbers.)
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { stepKinematic, type KinematicBody } from './pilotTestKit.js';
import type { AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { MORALE_OUTCOME } from './tactics/morale.js';

const KF = getShipKind('fighter');
const KR = getShipKind('robot-square');
const DUELS = 12;
const TICKS = 1200;
const SAMPLE_EVERY = 6;
/** Pooled heading rate bar (rad per game second); see the header. */
const TURN_BAR = 0.22;

function oneShip(o: KinematicBody, id: string, radius: number, side: string): IAiNeighbourQuery {
  return {
    count: 1,
    queryNeighbours: (x, y, r, maxK, out) => {
      if (maxK < 1 || Math.hypot(o.x - x, o.y - y) > r) return 0;
      out[0] = 0;
      return 1;
    },
    idAt: () => id, xAt: () => o.x, yAt: () => o.y, vxAt: () => o.vx, vyAt: () => o.vy,
    radiusAt: () => radius, sideAt: () => side, isPilotAt: () => false, isCapitalAt: () => false,
  };
}

const sw = (o: KinematicBody, id: string, allegiance: string): AiSwarmView =>
  ({ id, x: o.x, y: o.y, vx: o.vx, vy: o.vy, allegiance, angle: o.angle });

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** One duel: heading turned (rad) and combat time (s), both ships summed. */
function duel(k: number): { turned: number; seconds: number } {
  // 1500 u apart, noses toward each other, each duel a little offset so the
  // geometry varies along with the seed.
  const off = (k - DUELS / 2) * 25;
  const F: KinematicBody = { x: -750, y: off, vx: 0, vy: 0, angle: -Math.PI / 2, angvel: 0 };
  const R: KinematicBody = { x: 750, y: -off, vx: 0, vy: 0, angle: Math.PI / 2, angvel: 0 };
  const fid = `scene-b${k}-0`;
  const rid = `scene-r${k}-0`;
  const bF = new HostileDroneBehaviour(KF);
  const bR = new HostileDroneBehaviour(KR);
  bF.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
  bR.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
  const nbF = oneShip(R, rid, KR.radius, 'robots');
  const nbR = oneShip(F, fid, KF.radius, 'drones');
  let turned = 0;
  let seconds = 0;
  let lastF = NaN, lastR = NaN, tF = 0, tR = 0;
  for (let t = 1; t <= TICKS; t++) {
    const vF: AiWorldView = { players: [], tick: t, dtSec: 1 / 60, swarms: [sw(R, rid, 'robots')], neighbours: nbF };
    const vR: AiWorldView = { players: [], tick: t, dtSec: 1 / 60, swarms: [sw(F, fid, 'drones')], neighbours: nbR };
    const iF = { ...bF.tick({ id: fid, ...F }, vF) };
    const iR = bR.tick({ id: rid, ...R }, vR);
    stepKinematic(F, KF, iF);
    stepKinematic(R, KR, iR);
    if (bF.getTargetId() === null) lastF = NaN;
    else if (Number.isNaN(lastF)) { lastF = F.angle; tF = t; }
    else if (t - tF >= SAMPLE_EVERY) { turned += Math.abs(wrap(F.angle - lastF)); seconds += (t - tF) / 60; lastF = F.angle; tF = t; }
    if (bR.getTargetId() === null) lastR = NaN;
    else if (Number.isNaN(lastR)) { lastR = R.angle; tR = t; }
    else if (t - tR >= SAMPLE_EVERY) { turned += Math.abs(wrap(R.angle - lastR)); seconds += (t - tR) / 60; lastR = R.angle; tR = t; }
  }
  return { turned, seconds };
}

describe('HostileDroneBehaviour — on-sight 1v1 duels turn (deterministic gate)', () => {
  it('pooled heading rate over 12 seeded fighter-vs-robot duels clears the bar', () => {
    let turned = 0;
    let seconds = 0;
    const per: string[] = [];
    for (let k = 0; k < DUELS; k++) {
      const d = duel(k);
      turned += d.turned;
      seconds += d.seconds;
      per.push((d.turned / Math.max(1e-9, d.seconds)).toFixed(3));
    }
    const rate = turned / Math.max(1e-9, seconds);
    const msg = `headingRate=${rate.toFixed(4)} perDuel=${per.join(',')} combatS=${seconds.toFixed(0)}`;
    console.log(`[dogfight-turn] ${msg}`);
    expect(seconds, msg).toBeGreaterThan(0.8 * 2 * DUELS * (TICKS / 60));
    expect(rate, msg).toBeGreaterThan(TURN_BAR);
  });
});
