import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { WingmanBehaviour, stoppingDistance, type WingmanConfig } from './WingmanBehaviour.js';
import { reverseAccelFor, type WingmanPose, type WingmanShipStats, type WingmanWorldView } from './wingman/types.js';

/**
 * The wingman flies a REAL fighter body through the same `World.applyInput`
 * (→ `applyShipInput`) a pilot's keys use: the brain only ever outputs control
 * bits. A fake world view supplies the tick and target poses.
 */

let world: PhysicsWorld;
let nextId = 0;

beforeAll(async () => {
  world = await PhysicsWorld.create();
});

const ARRIVE = 40;
const GUARD = 300;

function spawnFighter(x = 0, y = 0): { id: string; stats: WingmanShipStats } {
  const id = `wing-${nextId++}`;
  // Far apart so tests never collide with each other's bodies.
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

const view = { tick: 0 } as { tick: number; resolvePoseInto?: WingmanWorldView['resolvePoseInto'] };

/** One sim tick: brain → control bits → the player input path → step. */
function step(id: string, b: WingmanBehaviour): void {
  const c = b.tick(poseOf(id), view);
  // Bits must be a legal pilot input: never thrust and reverse at once, never both turns.
  expect(c.thrust && c.reverse).toBe(false);
  expect(c.turnLeft && c.turnRight).toBe(false);
  world.applyInput(id, c);
  world.tick(1 / 60);
  view.tick++;
}

function runUntil(id: string, b: WingmanBehaviour, maxTicks: number, done: () => boolean): number {
  for (let t = 0; t < maxTicks; t++) {
    step(id, b);
    if (done()) return t + 1;
  }
  return -1;
}

describe('WingmanBehaviour — move order', () => {
  it('reaches the move point, then resumes defend with the post at the new spot', () => {
    const base = 100_000;
    const { id, stats } = spawnFighter(base, 0);
    const b = brain(stats);
    step(id, b); // first tick: post = spawn point
    expect(b.activity).toBe('guarding');
    expect(b.guardPostX).toBeCloseTo(base);

    // Behind and to the side, so it must turn round first.
    const tx = base + 900, ty = -1200;
    b.issueOrder({ kind: 'move', x: tx, y: ty });
    step(id, b);
    expect(b.activity).toBe('moving');

    const ticks = runUntil(id, b, 60 * 40, () => b.order === null);
    expect(ticks, 'order never completed').toBeGreaterThan(0);
    const p = poseOf(id);
    expect(Math.hypot(p.x - tx, p.y - ty)).toBeLessThanOrEqual(ARRIVE);
    expect(b.mode).toBe('defend');
    expect(b.activity).toBe('guarding');
    // Resume-from-here: the guard post is where the ship stopped, not the old post.
    expect(Math.hypot(b.guardPostX! - p.x, b.guardPostY! - p.y)).toBeLessThan(1);

    // And it then holds: no drift away over the next 3 s.
    runUntil(id, b, 180, () => false);
    const q = poseOf(id);
    expect(Math.hypot(q.x - tx, q.y - ty)).toBeLessThan(GUARD);
    expect(Math.hypot(q.vx, q.vy)).toBeLessThan(stats.maxSpeed * 0.05);
    expect(b.activity).toBe('guarding');
  });

  it('a long leg boosts on the way (player boost bit), a short one does not', () => {
    const { id, stats } = spawnFighter(200_000, 0);
    const b = brain(stats, { boostDistance: 1500 });
    step(id, b);
    b.issueOrder({ kind: 'move', x: 200_000, y: 4000 });
    let boosted = false;
    for (let t = 0; t < 120; t++) {
      const c = b.tick(poseOf(id), view);
      boosted ||= c.boost;
      world.applyInput(id, c);
      world.tick(1 / 60);
    }
    expect(boosted).toBe(true);

    const s2 = spawnFighter(300_000, 0);
    const b2 = brain(s2.stats, { boostDistance: 1500 });
    step(s2.id, b2);
    b2.issueOrder({ kind: 'move', x: 300_000, y: 500 });
    for (let t = 0; t < 120; t++) expect(b2.tick(poseOf(s2.id), view).boost).toBe(false);
  });
});

describe('WingmanBehaviour — stop order', () => {
  it('stop clears the order and holds where the ship brakes to (defend there)', () => {
    const { id, stats } = spawnFighter(400_000, 0);
    const b = brain(stats);
    step(id, b);
    b.issueOrder({ kind: 'move', x: 400_000, y: 5000 });
    runUntil(id, b, 240, () => false); // build up speed
    const before = poseOf(id);
    expect(Math.hypot(before.vx, before.vy)).toBeGreaterThan(100);

    b.issueOrder({ kind: 'stop' });
    step(id, b);
    expect(b.order).toBeNull();
    expect(b.mode).toBe('defend');
    expect(b.activity).toBe('guarding');
    const postY = b.guardPostY!;
    expect(postY).toBeGreaterThan(before.y); // ahead along the motion, not behind

    // It brakes to a halt and stays inside its guard radius of the post.
    runUntil(id, b, 60 * 15, () => false);
    const p = poseOf(id);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(stats.maxSpeed * 0.05);
    expect(Math.hypot(p.x - b.guardPostX!, p.y - postY)).toBeLessThan(GUARD);
    expect(b.activity).toBe('guarding');
  });
});

describe('WingmanBehaviour — defend', () => {
  it('returns to its post when displaced outside the guard radius', () => {
    const base = 500_000;
    const { id, stats } = spawnFighter(base, 0);
    const b = brain(stats);
    b.setMode('defend', base, 0);
    step(id, b);
    expect(b.activity).toBe('guarding');

    // Shove it 1000 u away (an external push, not an order).
    world.setShipState(id, { x: base + 800, y: 600, angle: 1, vx: 0, vy: 0, angvel: 0 });
    step(id, b);
    expect(b.activity).toBe('moving');

    const ticks = runUntil(id, b, 60 * 30, () => b.activity === 'guarding');
    expect(ticks, 'never got back').toBeGreaterThan(0);
    const p = poseOf(id);
    expect(Math.hypot(p.x - base, p.y)).toBeLessThanOrEqual(ARRIVE);
    // The post did NOT move (a displacement is not an order).
    expect(b.guardPostX).toBe(base);
    expect(b.guardPostY).toBe(0);
  });

  it('a nudge inside the guard radius is absorbed: it brakes and holds, no return trip', () => {
    const base = 600_000;
    const { id, stats } = spawnFighter(base, 0);
    const b = brain(stats);
    b.setMode('defend', base, 0);
    step(id, b);
    world.setShipState(id, { x: base + 100, y: 50, angle: 0, vx: 40, vy: 0, angvel: 0 });
    for (let t = 0; t < 300; t++) {
      step(id, b);
      expect(b.activity).toBe('guarding');
    }
    const p = poseOf(id);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(stats.maxSpeed * 0.05);
  });

  it('modes not yet built (patrol/hunt/escort/retreat) fall back to defend from where it is', () => {
    const { id, stats } = spawnFighter(700_000, 0);
    const b = brain(stats);
    b.setMode('patrol');
    step(id, b);
    expect(b.mode).toBe('patrol');
    expect(b.activity).toBe('guarding');
    expect(b.guardPostX).toBeCloseTo(700_000);
  });
});

describe('WingmanBehaviour — attack order (movement only)', () => {
  it('pursues a resolvable target, exposes targetId, and resumes when it is gone', () => {
    const { id, stats } = spawnFighter(800_000, 0);
    const b = brain(stats, { attackStandoff: 150 });
    let alive = true;
    const target = { x: 800_000, y: 2000, vx: 0, vy: 0 };
    view.resolvePoseInto = (tid, out) => {
      if (tid !== 'enemy' || !alive) return false;
      out.x = target.x; out.y = target.y; out.vx = target.vx; out.vy = target.vy;
      return true;
    };
    try {
      step(id, b);
      b.issueOrder({ kind: 'attack', targetId: 'enemy' });
      expect(b.targetId).toBe('enemy');
      step(id, b);
      expect(b.activity).toBe('chasing');
      runUntil(id, b, 60 * 30, () => b.activity === 'attacking');
      expect(b.activity).toBe('attacking');
      const p = poseOf(id);
      expect(Math.hypot(p.x - target.x, p.y - target.y)).toBeLessThan(150 * 1.5);

      alive = false;
      step(id, b);
      expect(b.order).toBeNull();
      expect(b.targetId).toBeNull();
      expect(b.activity).toBe('guarding');
      const q = poseOf(id);
      expect(Math.hypot(b.guardPostX! - q.x, b.guardPostY! - q.y)).toBeLessThan(10);
    } finally {
      view.resolvePoseInto = undefined;
    }
  });

  it('an attack order with no resolvable target completes at once', () => {
    const { id, stats } = spawnFighter(900_000, 0);
    const b = brain(stats);
    b.issueOrder({ kind: 'attack', targetId: 'ghost' });
    step(id, b);
    expect(b.order).toBeNull();
    expect(b.targetId).toBeNull();
    expect(b.activity).toBe('guarding');
  });
});

describe('stoppingDistance', () => {
  const s: WingmanShipStats = { maxSpeed: 250, linearDamping: 0.3, maxAngvel: 2, angularDamping: 0, reverseAccel: 30 };
  it('is 0 at rest, grows with speed, and damping shortens it', () => {
    expect(stoppingDistance(0, s)).toBe(0);
    expect(stoppingDistance(200, s)).toBeGreaterThan(stoppingDistance(100, s));
    expect(stoppingDistance(200, s)).toBeLessThan((200 * 200) / (2 * 30));
    expect(stoppingDistance(200, { ...s, linearDamping: 0 })).toBeCloseTo((200 * 200) / 60);
  });
});
