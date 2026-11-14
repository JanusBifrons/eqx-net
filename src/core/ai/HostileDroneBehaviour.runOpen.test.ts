/**
 * A run picked nose to nose (filmed 2026-11-14, take3 6.4–9.2 s): a Robot Orb
 * Tailed a heavy down to 118 u and stopped (42 → 3 u/s), switched to AttackRun
 * at 103 u, then flipped its turn key at full rate (±5.46 rad/s) at 82–98 u for
 * ~2.5 s while both ships sat at 3–95 u/s: two ships touching nose to nose.
 *
 * Per-tick trace of this scene before the fix (robot 3 u/s, heavy crossing at
 * 30 u/s): the run went DIVE → PASS on its first tick (100 u is far inside its
 * ~440 u pass distance), so it flew the pass from a standstill at the heavy;
 * hull avoidance switched on and off every few ticks (dodge right, then the
 * pass heading back left) and picked its side afresh each tick (23 side flips
 * in one scene): 196–237 turn-key flips in 6 s and up to 3.2 s on end within
 * 4 hull radii at < 40 u/s relative.
 *
 * Fix: the run first opens the range (extend away, boosting, off the target's
 * nose) and only then dives; the dodge side is latched for the manoeuvre.
 * The ships fly the virtual pilot on the kinematic model (`pilotTestKit`).
 */
import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { stepKinematic, turnOf, type KinematicBody } from './pilotTestKit.js';
import type { AiEntity, AiSwarmView, AiWorldView, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import { MANOEUVRE_ATTACK_RUN } from './tactics/manoeuvre.js';
import { MORALE_OUTCOME } from './tactics/morale.js';

const ORB = getShipKind('robot-circle');
const HEAVY = getShipKind('heavy');

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

interface Brain {
  switchManoeuvre(id: number, tick: number): void;
  hullAvoid(self: AiEntity, nb: IAiNeighbourQuery): boolean;
  _avX: number;
  _tac: { tick: number };
}

interface Scene { turnFlips: number; maxCloseSlowTicks: number }

/**
 * The Orb 100 u south of the heavy at `orbSpeed` toward it, the heavy moving
 * at `heavySpeed` along `heavyDeg` (scripted, or flown by its own brain in
 * FallBack, as filmed); the Orb starts an AttackRun on tick 2. 6 s.
 */
function scene(heavyDeg: number, heavySpeed: number, orbSpeed: number, heavyBrain: boolean): Scene {
  const a = (heavyDeg * Math.PI) / 180;
  const A: KinematicBody = { x: 0, y: 0, vx: 0, vy: orbSpeed, angle: 0, angvel: 0 };
  const B: KinematicBody = { x: 0, y: 100, vx: -Math.sin(a) * heavySpeed, vy: Math.cos(a) * heavySpeed, angle: a, angvel: 0 };
  const bA = new HostileDroneBehaviour(ORB);
  const bB = new HostileDroneBehaviour(HEAVY);
  bA.setMoraleRoll(() => MORALE_OUTCOME.FightOn);
  bB.setMoraleRoll(() => MORALE_OUTCOME.FallBack);
  bA.markHostile('b', 0);
  bB.markHostile('a', 0);
  const nbA = oneShip(B, 'b', HEAVY.radius, 'drones');
  const nbB = oneShip(A, 'a', ORB.radius, 'robots');
  const close = 4 * ORB.radius;
  let prevTurn = 0, turnFlips = 0, run = 0, maxRun = 0;
  for (let t = 1; t <= 360; t++) {
    if (t === 2) (bA as unknown as Brain).switchManoeuvre(MANOEUVRE_ATTACK_RUN, t);
    const vA: AiWorldView = { players: [], tick: t, dtSec: 1 / 60, swarms: [sw(B, 'b', 'drones')], neighbours: nbA };
    const iA = { ...bA.tick({ id: 'a', ...A }, vA) };
    if (heavyBrain) {
      const vB: AiWorldView = { players: [], tick: t, dtSec: 1 / 60, swarms: [sw(A, 'a', 'robots')], neighbours: nbB };
      stepKinematic(B, HEAVY, bB.tick({ id: 'b', ...B }, vB));
    } else {
      B.x += B.vx / 60;
      B.y += B.vy / 60;
    }
    stepKinematic(A, ORB, iA);
    const turn = turnOf(iA);
    if (turn !== 0 && prevTurn !== 0 && turn !== prevTurn) turnFlips++;
    if (turn !== 0) prevTurn = turn;
    const d = Math.hypot(A.x - B.x, A.y - B.y);
    const rel = Math.hypot(A.vx - B.vx, A.vy - B.vy);
    run = d < close && rel < 40 ? run + 1 : 0;
    if (run > maxRun) maxRun = run;
  }
  return { turnFlips, maxCloseSlowTicks: maxRun };
}

describe('HostileDroneBehaviour — an attack run started nose to nose opens the range first', () => {
  it('the filmed state (Orb ~10 u/s, heavy at 30 u/s, any heading): no > 1 s nose to nose, no turn-key flapping', () => {
    const rows: string[] = [];
    for (const heavyBrain of [false, true]) {
      for (let k = 0; k < 8; k++) {
        const r = scene(k * 45, 30, 10, heavyBrain);
        rows.push(`${heavyBrain ? 'brain' : 'script'} ${k * 45}°: flips=${r.turnFlips} close=${r.maxCloseSlowTicks}`);
      }
    }
    const msg = rows.join('\n');
    console.log(msg);
    for (const row of rows) {
      const flips = Number(/flips=(\d+)/.exec(row)![1]);
      const closeTicks = Number(/close=(\d+)/.exec(row)![1]);
      expect(closeTicks, msg).toBeLessThanOrEqual(60);
      expect(flips, msg).toBeLessThanOrEqual(3);
    }
  });

  it('the flip storm scenes (Orb 3 u/s, heavy crossing at 30 u/s): turn key no longer flaps', () => {
    // Before: 237 and 196 turn-key flips in 6 s.
    for (const deg of [90, 270]) {
      const r = scene(deg, 30, 3, false);
      expect(r.turnFlips, `${deg}°`).toBeLessThanOrEqual(3);
      expect(r.maxCloseSlowTicks, `${deg}°`).toBeLessThanOrEqual(60);
    }
  });

  it('hull avoidance holds its dodge side while the other ship slides across the line', () => {
    const b = new HostileDroneBehaviour(ORB);
    const brain = b as unknown as Brain;
    const self: AiEntity = { id: 'a', x: 0, y: 0, vx: 0, vy: 100, angle: 0, angvel: 0 };
    const other: KinematicBody = { x: -10, y: 200, vx: 0, vy: -100, angle: Math.PI, angvel: 0 };
    const nb = oneShip(other, 'b', HEAVY.radius, 'drones');
    // Passing 10 u to my left: dodge right (+x).
    brain._tac.tick = 100;
    expect(brain.hullAvoid(self, nb)).toBe(true);
    expect(brain._avX).toBeGreaterThan(0.9);
    // Next tick it slides 10 u to my right: a fresh pick would dodge left;
    // the latched side keeps the dodge going right.
    other.x = 10;
    brain._tac.tick = 101;
    expect(brain.hullAvoid(self, nb)).toBe(true);
    expect(brain._avX).toBeGreaterThan(0.9);
    // A new manoeuvre frees the side: now it dodges away, to the left.
    brain.switchManoeuvre(MANOEUVRE_ATTACK_RUN, 102);
    brain._tac.tick = 102;
    expect(brain.hullAvoid(self, nb)).toBe(true);
    expect(brain._avX).toBeLessThan(-0.9);
    // So does a second without a dodge.
    other.x = -10;
    brain._tac.tick = 102 + 61;
    expect(brain.hullAvoid(self, nb)).toBe(true);
    expect(brain._avX).toBeGreaterThan(0.9);
  });
});
