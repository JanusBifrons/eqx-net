/**
 * AI overhaul slice 4: the decision layer inside the brain. Two NPC fighters
 * flown by the virtual pilot on a kinematic model of `applyShipInput`
 * (`pilotTestKit`) dogfight instead of trading fire nose to nose; the brain
 * re-decides on its cadence (5 Hz, 2 Hz with no pilot near) and a change of
 * mind waits out the role's reaction time. Deterministic (seeded by id).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { stepKinematic, type KinematicBody } from './pilotTestKit.js';
import type { AiPlayerView, AiSwarmView, AiTickStats, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { MANOEUVRE_ATTACK_RUN, MANOEUVRE_BREAK } from './tactics/manoeuvre.js';
import { roleProfile } from './tactics/roleProfiles.js';

const KA = getShipKind('fighter');
const KB = getShipKind('patrol-fighter');

/** An empty neighbour index: the decision layer runs only with one. */
const NO_NB: IAiNeighbourQuery = {
  count: 0, queryNeighbours: () => 0, idAt: () => '', xAt: () => 0, yAt: () => 0,
  vxAt: () => 0, vyAt: () => 0, radiusAt: () => 0, sideAt: () => '', isPilotAt: () => false, isCapitalAt: () => false,
};

function sw(o: KinematicBody, id: string, allegiance: string): AiSwarmView {
  return { id, x: o.x, y: o.y, vx: o.vx, vy: o.vy, allegiance };
}

interface Duel { passes: number; toeFrac: number; shotsA: number; shotsB: number; runs: number; trace: string }

function duel(ticks: number, players: AiPlayerView[] = []): Duel {
  const A: KinematicBody = { x: -750, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angvel: 0 };
  const B: KinematicBody = { x: 750, y: 0, vx: 0, vy: 0, angle: Math.PI / 2, angvel: 0 };
  const bA = new HostileDroneBehaviour(KA);
  const bB = new HostileDroneBehaviour(KB);
  bA.markHostile('b', 0);
  bB.markHostile('a', 0);
  const R = bA.getFireRange();
  let toe = 0; let passes = 0; let armed = true; let shotsA = 0; let shotsB = 0; let runs = 0;
  let trace = '';
  let lastA = -1;
  for (let t = 1; t <= ticks; t++) {
    const vA: AiWorldView = { players, tick: t, dtSec: 1 / 60, swarms: [sw(B, 'b', 'traders')], neighbours: NO_NB };
    const vB: AiWorldView = { players, tick: t, dtSec: 1 / 60, swarms: [sw(A, 'a', 'drones')], neighbours: NO_NB };
    const iA = { ...bA.tick({ id: 'a', ...A }, vA) };
    const iB = bB.tick({ id: 'b', ...B }, vB);
    if (iA.fire) shotsA++;
    if (iB.fire) shotsB++;
    stepKinematic(A, KA, iA);
    stepKinematic(B, KB, iB);
    const m = bA.getManoeuvre();
    if (m !== lastA) { trace += `${t}:${m} `; if (m === MANOEUVRE_ATTACK_RUN) runs++; lastA = m; }
    const d = Math.hypot(A.x - B.x, A.y - B.y);
    if (d < 0.7 * R && Math.hypot(A.vx, A.vy) < 0.25 * bA.getCruiseSpeed() && Math.hypot(B.vx, B.vy) < 0.25 * bB.getCruiseSpeed()) toe++;
    // A merge: inside 0.15 R, out past 0.25 R, in again (a turning fight
    // re-merges inside gun range; only a joust opens past R, 2026-11-13).
    if (armed && d < 0.15 * R) { passes++; armed = false; } else if (!armed && d > 0.25 * R) armed = true;
  }
  return { passes, toeFrac: toe / ticks, shotsA, shotsB, runs, trace };
}

describe('HostileDroneBehaviour — dogfight decision layer (slice 4)', () => {
  it('two fighters make an attack run, pass and turn back into the fight; never toe to toe', () => {
    const r = duel(20 * 60);
    expect(r.passes, r.trace).toBeGreaterThanOrEqual(2);
    // After the first pass the close fight is a turning fight (Tail), not a
    // second joust (2026-11-13 on-sight fix: repeated head-on runs were the
    // filmed "dead straight lines, trade head-on").
    expect(r.runs, r.trace).toBeGreaterThanOrEqual(1);
    expect(r.toeFrac).toBeLessThan(0.05);
    expect(r.shotsA).toBeGreaterThan(0);
    expect(r.shotsB).toBeGreaterThan(0);
  });

  it('is deterministic (same seeds, same fight)', () => {
    expect(duel(600).trace).toBe(duel(600).trace);
  });

  it('re-scores at 5 Hz with a pilot near and 2 Hz without (AI LOD)', () => {
    const count = (players: AiPlayerView[]): number => {
      const b = new HostileDroneBehaviour(KA);
      const stats: AiTickStats = { decisions: 0 };
      b.markHostile('b', 0);
      // A stationary target the brain holds off from (no manoeuvre ends early).
      const B = { id: 'b', x: 0, y: 5000, vx: 0, vy: 0, allegiance: 'traders' };
      for (let t = 1; t <= 600; t++) {
        b.tick({ id: 'a', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
          { players, tick: t, dtSec: 1 / 60, swarms: [B], neighbours: NO_NB, stats });
      }
      expect(stats.decisions).toBe(b.getDecisionCount());
      return stats.decisions;
    };
    const pilot: AiPlayerView = { id: 'p', x: 100, y: 0, vx: 0, vy: 0 };
    const near = count([pilot]);
    const far = count([]);
    expect(near).toBeGreaterThanOrEqual(48);
    expect(near).toBeLessThanOrEqual(52);
    expect(far).toBeGreaterThanOrEqual(19);
    expect(far).toBeLessThanOrEqual(22);
  });

  it('a tailed fighter breaks after the decision cadence plus its reaction time, not before', () => {
    const b = new HostileDroneBehaviour(KB);
    b.markHostile('a', 0);
    // A sits 300 u behind B (B's nose +y), barely moving.
    const A = { id: 'a', x: 0, y: -300, vx: 0, vy: 0, allegiance: 'drones' };
    const reaction = roleProfile(KB.aiRole).reactionTicks;
    let decidedAt = -1;
    let brokeAt = -1;
    for (let t = 1; t <= 120 && brokeAt < 0; t++) {
      const stats: AiTickStats = { decisions: 0 };
      b.tick({ id: 'b', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 },
        { players: [], tick: t, dtSec: 1 / 60, swarms: [A], neighbours: NO_NB, stats });
      if (decidedAt < 0 && stats.decisions > 0) decidedAt = t;
      if (b.getManoeuvre() === MANOEUVRE_BREAK) brokeAt = t;
    }
    expect(decidedAt).toBeGreaterThan(0);
    expect(brokeAt - decidedAt).toBe(reaction);
  });
});
