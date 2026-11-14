import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { WingmanBehaviour, WINGMAN_FLEE_DIST_MUL, type WingmanConfig } from './WingmanBehaviour.js';
import { MORALE_OUTCOME } from './tactics/morale.js';
import {
  reverseAccelFor,
  type WingmanPose,
  type WingmanPoseOut,
  type WingmanShipStats,
  type WingmanWorldView,
} from './wingman/types.js';

/**
 * RTS slice 8: the standing modes (patrol / escort / hunt / retreat) and the
 * morale link. Same approach as `WingmanBehaviour.test.ts`: a REAL fighter
 * body flown only through `World.applyInput` (the pilot's input path); a fake
 * world view supplies other ships' poses and the hunt contact.
 */

let world: PhysicsWorld;
let nextId = 0;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

const ARRIVE = 40;
const GUARD = 300;

function spawnFighter(x = 0, y = 0): { id: string; stats: WingmanShipStats } {
  const id = `wm-${nextId++}`;
  world.spawnShip(id, x, y, 'fighter');
  const kind = getShipKind('fighter');
  const mass = world.getBodyMass(id)!;
  const stats: WingmanShipStats = {
    maxSpeed: kind.maxSpeed,
    linearDamping: kind.linearDamping,
    maxAngvel: kind.maxAngvel,
    angularDamping: kind.angularDamping,
    turnTorque: kind.turnTorque,
    reverseAccel: reverseAccelFor(kind, mass),
  };
  return { id, stats };
}

function brain(stats: WingmanShipStats, extra: Partial<WingmanConfig> = {}): WingmanBehaviour {
  return new WingmanBehaviour({ stats, arriveRadius: ARRIVE, guardRadius: GUARD, ...extra });
}

function poseOf(id: string): WingmanPose {
  const s = world.getShipState(id)!;
  return { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel ?? 0 };
}

type View = { tick: number } & Pick<WingmanWorldView, 'resolvePoseInto' | 'nearestHostile'>;

function makeView(): View {
  return { tick: 0 };
}

/** One sim tick: brain → control bits → the player input path → step. */
function step(id: string, b: WingmanBehaviour, view: View, before?: () => void): void {
  before?.();
  const c = b.tick(poseOf(id), view);
  expect(c.thrust && c.reverse).toBe(false);
  expect(c.turnLeft && c.turnRight).toBe(false);
  world.applyInput(id, c);
  world.tick(1 / 60);
  view.tick++;
}

function runUntil(id: string, b: WingmanBehaviour, view: View, maxTicks: number, done: () => boolean, before?: () => void): number {
  for (let t = 0; t < maxTicks; t++) {
    step(id, b, view, before);
    if (done()) return t + 1;
  }
  return -1;
}

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

describe('WingmanBehaviour — patrol', () => {
  it('flies the route as a closed loop, then after a move order resumes at the nearest waypoint', () => {
    const bx = 1_100_000;
    const { id, stats } = spawnFighter(bx, 0);
    const b = brain(stats);
    const route: [number, number][] = [[bx, 1200], [bx + 1200, 1200], [bx + 1200, 0]];
    const view = makeView();
    b.setMode('patrol', { route });
    step(id, b, view);
    expect(b.mode).toBe('patrol');
    expect(b.activity).toBe('patrolling');
    expect(b.patrolRouteLength).toBe(3);

    // Record the order waypoints are reached in; it must cycle 0 → 1 → 2 → 0 → 1.
    const seen: number[] = [b.patrolWaypointIndex];
    runUntil(id, b, view, 60 * 60, () => {
      const i = b.patrolWaypointIndex;
      if (i !== seen[seen.length - 1]) seen.push(i);
      expect(b.activity).toBe('patrolling');
      return seen.length >= 5;
    });
    expect(seen.slice(0, 5)).toEqual([0, 1, 2, 0, 1]);

    // A move order next to waypoint 2 (bottom-right): when it completes the
    // patrol resumes from THERE, heading for waypoint 2, not where it left off.
    const mx = bx + 1500, my = -200;
    b.issueOrder({ kind: 'move', x: mx, y: my });
    step(id, b, view);
    expect(b.activity).toBe('moving');
    expect(runUntil(id, b, view, 60 * 30, () => b.order === null)).toBeGreaterThan(0);
    expect(b.mode).toBe('patrol');
    expect(b.patrolWaypointIndex).toBe(2);
    expect(b.activity).toBe('patrolling');
    // ... and it carries on round the loop (2 → 0).
    expect(runUntil(id, b, view, 60 * 30, () => b.patrolWaypointIndex === 0)).toBeGreaterThan(0);
  });

  it('a one-point route defends that point; no route defends where the ship is', () => {
    const { id, stats } = spawnFighter(1_200_000, 0);
    const b = brain(stats);
    const view = makeView();
    b.setMode('patrol', { route: [[1_200_500, 100]] });
    expect(b.mode).toBe('defend');
    expect(b.guardPostX).toBe(1_200_500);
    step(id, b, view);
    expect(b.activity).toBe('moving'); // 500 u > guard radius: flies to it

    b.setMode('patrol');
    step(id, b, view);
    expect(b.mode).toBe('defend');
    expect(Math.abs(b.guardPostX! - poseOf(id).x)).toBeLessThan(20);
  });
});

describe('WingmanBehaviour — escort', () => {
  it('forms up behind-starboard of a moving ship, holds station at its speed, and defends when it vanishes', () => {
    const bx = 1_300_000;
    const { id, stats } = spawnFighter(bx - 400, -300);
    const spacing = 150;
    const b = brain(stats, { escortSpacing: spacing });
    // The escorted ship flies north at 150 u/s.
    const tgt = { x: bx, y: 0, vx: 0, vy: 150 };
    let alive = true;
    const view = makeView();
    view.resolvePoseInto = (tid: string, out: WingmanPoseOut) => {
      if (tid !== 'boss' || !alive) return false;
      out.x = tgt.x; out.y = tgt.y; out.vx = tgt.vx; out.vy = tgt.vy;
      return true;
    };
    const advance = (): void => { tgt.x += tgt.vx / 60; tgt.y += tgt.vy / 60; };

    b.setMode('escort', { escortId: 'boss' });
    step(id, b, view, advance);
    expect(b.mode).toBe('escort');
    expect(b.escortId).toBe('boss');
    expect(b.activity).toBe('formingUp');

    expect(runUntil(id, b, view, 60 * 30, () => b.activity === 'guarding', advance)).toBeGreaterThan(0);
    // Hold station for 5 s: behind (−y) and to starboard (+x) of a north-bound ship.
    let maxErr = 0;
    for (let t = 0; t < 300; t++) {
      step(id, b, view, advance);
      const p = poseOf(id);
      maxErr = Math.max(maxErr, dist(p.x, p.y, tgt.x + spacing, tgt.y - spacing));
    }
    expect(maxErr).toBeLessThan(spacing);
    const p = poseOf(id);
    expect(Math.abs(p.vy - tgt.vy)).toBeLessThan(40);
    expect(b.activity).toBe('guarding');

    // The escorted ship is gone: defend the spot where it was lost.
    alive = false;
    step(id, b, view);
    expect(b.mode).toBe('escort');
    const lostAt = poseOf(id);
    expect(dist(b.guardPostX!, b.guardPostY!, lostAt.x, lostAt.y)).toBeLessThan(10);
    runUntil(id, b, view, 60 * 10, () => false);
    const q = poseOf(id);
    expect(Math.hypot(q.vx, q.vy)).toBeLessThan(stats.maxSpeed * 0.05);
    expect(dist(q.x, q.y, b.guardPostX!, b.guardPostY!)).toBeLessThan(GUARD);
    expect(b.activity).toBe('guarding');
  });

  it('escort with no id (or a view that resolves nothing) defends where it is', () => {
    const { id, stats } = spawnFighter(1_400_000, 0);
    const b = brain(stats);
    const view = makeView();
    b.setMode('escort', {});
    expect(b.mode).toBe('defend');
    b.setMode('escort', { escortId: 'nobody' });
    step(id, b, view);
    expect(b.mode).toBe('escort');
    expect(b.activity).toBe('guarding');
    expect(b.guardPostX).toBeCloseTo(1_400_000, 0);
  });
});

describe('WingmanBehaviour — hunt', () => {
  it('chases the injected hostile, then defends where the chase ended when none is left', () => {
    const bx = 1_500_000;
    const { id, stats } = spawnFighter(bx, 0);
    const b = brain(stats, { attackStandoff: 150, sensorRange: 2500 });
    const hostile = { x: bx + 400, y: 2000, vx: 0, vy: 0 };
    let present = true;
    const queries: number[] = [];
    const view = makeView();
    view.nearestHostile = (sx, sy, range, out) => {
      queries.push(range);
      if (!present || dist(sx, sy, hostile.x, hostile.y) > range) return null;
      out.x = hostile.x; out.y = hostile.y; out.vx = hostile.vx; out.vy = hostile.vy;
      return 'h1';
    };
    b.setMode('hunt');
    step(id, b, view);
    expect(queries[0]).toBe(2500);
    expect(b.targetId).toBe('h1');
    expect(b.activity).toBe('chasing');
    expect(runUntil(id, b, view, 60 * 30, () => b.activity === 'attacking')).toBeGreaterThan(0);
    const p = poseOf(id);
    expect(dist(p.x, p.y, hostile.x, hostile.y)).toBeLessThan(150 * 1.5);

    present = false;
    step(id, b, view);
    expect(b.targetId).toBeNull();
    expect(b.mode).toBe('hunt');
    expect(b.activity).toBe('guarding');
    const q = poseOf(id);
    expect(dist(b.guardPostX!, b.guardPostY!, q.x, q.y)).toBeLessThan(10);
  });

  it('ignores a hostile outside sensor range, and a holdFire hunter never chases', () => {
    const bx = 1_600_000;
    const { id, stats } = spawnFighter(bx, 0);
    const b = brain(stats, { sensorRange: 800 });
    const view = makeView();
    let asked = 0;
    view.nearestHostile = (sx, sy, range, out) => {
      asked++;
      if (dist(sx, sy, bx, 1000) > range) return null;
      out.x = bx; out.y = 1000; out.vx = 0; out.vy = 0;
      return 'far';
    };
    b.setMode('hunt');
    step(id, b, view);
    expect(b.targetId).toBeNull();
    expect(b.activity).toBe('guarding');

    const b2 = brain(stats, { sensorRange: 5000, stance: 'holdFire' });
    b2.setMode('hunt');
    const before = asked;
    b2.tick(poseOf(id), view);
    expect(asked).toBe(before); // holdFire does not even look
    expect(b2.targetId).toBeNull();
    expect(b2.activity).toBe('guarding');
  });

  it('the default sensor range is the role sensor range (floored at ON_SIGHT)', () => {
    const { stats } = spawnFighter(1_650_000, 0);
    expect(brain(stats).huntSensorRange).toBeGreaterThanOrEqual(1600);
    expect(brain(stats, { aiRole: 'scout', fireRange: 1000 }).huntSensorRange).toBe(5000);
  });
});

describe('WingmanBehaviour — retreat', () => {
  it('flies to the retreat point without engaging, then defends there', () => {
    const bx = 1_700_000;
    const { id, stats } = spawnFighter(bx, 0);
    const b = brain(stats);
    const view = makeView();
    view.nearestHostile = (_x, _y, _r, out) => { out.x = bx; out.y = 100; out.vx = 0; out.vy = 0; return 'h'; };
    b.setMode('retreat', { x: bx - 1500, y: -800 });
    step(id, b, view);
    expect(b.activity).toBe('retreating');
    expect(b.targetId).toBeNull();
    expect(runUntil(id, b, view, 60 * 30, () => b.mode === 'defend')).toBeGreaterThan(0);
    const p = poseOf(id);
    expect(dist(p.x, p.y, bx - 1500, -800)).toBeLessThanOrEqual(ARRIVE);
    expect(b.activity).toBe('guarding');
    expect(dist(b.guardPostX!, b.guardPostY!, p.x, p.y)).toBeLessThan(1);
  });

  it('with no point it retreats to its guard post', () => {
    const bx = 1_800_000;
    const { id, stats } = spawnFighter(bx, 0);
    const b = brain(stats);
    const view = makeView();
    b.setMode('defend', bx, 0);
    step(id, b, view);
    world.setShipState(id, { x: bx + 200, y: 150, angle: 0, vx: 0, vy: 0, angvel: 0 }); // inside guard radius
    b.setMode('retreat');
    step(id, b, view);
    expect(b.activity).toBe('retreating');
    expect(runUntil(id, b, view, 60 * 20, () => b.mode === 'defend')).toBeGreaterThan(0);
    const p = poseOf(id);
    expect(dist(p.x, p.y, bx, 0)).toBeLessThanOrEqual(ARRIVE);
  });
});

describe('WingmanBehaviour — morale', () => {
  const FLEE = { fightOn: 0, fallBack: 0, flee: 1 };

  it('a Flee roll breaks off the order and runs away from the threat, then resumes the mode', () => {
    const bx = 1_900_000;
    const { id, stats } = spawnFighter(bx, 0);
    const b = brain(stats, { moraleWeights: FLEE, moraleSeedId: 7 });
    const view = makeView();
    const route: [number, number][] = [[bx, 1500], [bx + 1500, 1500]];
    b.setMode('patrol', { route });
    step(id, b, view);
    b.issueOrder({ kind: 'move', x: bx, y: 3000 });
    step(id, b, view);
    expect(b.moraleOutcome).toBeNull();

    // Hit from the east, hull down to 40 % ⇒ the 50 % trigger fires and rolls.
    const start = poseOf(id);
    b.reportDamage(60, 100, 0.4, start.x + 500, start.y);
    step(id, b, view);
    expect(b.isMoraleRetreating).toBe(true);
    expect(b.moraleOutcome).toBe(MORALE_OUTCOME.Flee);
    expect(b.order).toBeNull();
    expect(b.activity).toBe('retreating');

    expect(runUntil(id, b, view, 60 * 40, () => !b.isMoraleRetreating)).toBeGreaterThan(0);
    const p = poseOf(id);
    // It ran WEST (away from the threat) by the flee distance.
    expect(p.x).toBeLessThan(start.x - GUARD * WINGMAN_FLEE_DIST_MUL + ARRIVE * 2);
    expect(b.mode).toBe('patrol');
    expect(b.activity).toBe('patrolling');
    expect(b.patrolWaypointIndex).toBe(0); // nearest waypoint to where it ended up
  });

  it('with no known threat a Flee falls back to the post (already there ⇒ resumes at once)', () => {
    const { id, stats } = spawnFighter(2_050_000, 0);
    const view = makeView();
    const b = brain(stats, { moraleWeights: FLEE });
    b.tick(poseOf(id), view);
    b.reportDamage(60, 100, 0.4);
    b.tick(poseOf(id), view);
    expect(b.moraleOutcome).toBe(MORALE_OUTCOME.Flee);
    expect(b.isMoraleRetreating).toBe(false);
    expect(b.activity).toBe('guarding');
  });

  it('a FightOn roll changes nothing; the same ship + damage always rolls the same', () => {
    const { id, stats } = spawnFighter(2_000_000, 0);
    const view = makeView();
    const fight = brain(stats, { moraleWeights: { fightOn: 1, fallBack: 0, flee: 0 } });
    fight.tick(poseOf(id), view);
    fight.reportDamage(60, 100, 0.4, 0, 0);
    fight.tick(poseOf(id), view);
    expect(fight.moraleOutcome).toBe(MORALE_OUTCOME.FightOn);
    expect(fight.isMoraleRetreating).toBe(false);

    const outcomes = new Set<number>();
    for (let k = 0; k < 2; k++) {
      const b = brain(stats, { moraleSeedId: 12345 });
      b.tick(poseOf(id), view);
      b.reportDamage(80, 100, 0.2, 0, 0);
      b.tick(poseOf(id), view);
      outcomes.add(b.moraleOutcome!);
    }
    expect(outcomes.size).toBe(1);
  });

  it('a new order from the owner overrides a morale retreat', () => {
    const { id, stats } = spawnFighter(2_100_000, 0);
    const view = makeView();
    const b = brain(stats, { moraleWeights: FLEE });
    b.tick(poseOf(id), view);
    b.reportDamage(60, 100, 0.4, 2_100_300, 0);
    b.tick(poseOf(id), view);
    expect(b.isMoraleRetreating).toBe(true);
    b.issueOrder({ kind: 'move', x: 2_100_000, y: 2000 });
    b.tick(poseOf(id), view);
    expect(b.isMoraleRetreating).toBe(false);
    expect(b.activity).toBe('moving');
  });
});
