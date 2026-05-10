import { describe, it, expect } from 'vitest';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { DriftingAsteroidBehaviour } from './DriftingAsteroidBehaviour.js';
import type { AiEntity, AiWorldView } from '../contracts/IAiBehaviour.js';
import { WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';

const droneAt = (x: number, y: number, angle = 0, angvel = 0): AiEntity => ({
  id: 'drone-1', x, y, vx: 0, vy: 0, angle, angvel,
});

const viewWith = (
  players: Array<{ id: string; x: number; y: number }>,
  tick = 0,
): AiWorldView => ({
  players: players.map((p) => ({ ...p, vx: 0, vy: 0 })),
  tick,
  dtSec: 1 / 60,
});

describe('DriftingAsteroidBehaviour', () => {
  it('returns zero intent regardless of player position', () => {
    const b = new DriftingAsteroidBehaviour();
    const intent = b.tick(droneAt(0, 0), viewWith([{ id: 'p1', x: 50, y: 0 }]));
    expect(intent.fx).toBe(0);
    expect(intent.fy).toBe(0);
    expect(intent.torque).toBe(0);
    expect(intent.fire).toBeUndefined();
  });

  it('does not allocate per call (returns frozen singleton)', () => {
    const b = new DriftingAsteroidBehaviour();
    const a = b.tick(droneAt(0, 0), viewWith([]));
    const c = b.tick(droneAt(10, 10), viewWith([]));
    expect(a).toBe(c);
  });
});

describe('HostileDroneBehaviour — IDLE patrol', () => {
  it('starts in IDLE state', () => {
    const b = new HostileDroneBehaviour();
    expect(b.getState()).toBe('IDLE');
  });

  it('IDLE drone with no players still produces patrol motion (does not idle to zero)', () => {
    // Phase 1 deliberately changed the "no players => zero intent"
    // contract: drones now patrol when not provoked. This documents the
    // new behaviour.
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(500, 0, 0, 0), viewWith([]));
    // Some component of motion should be non-zero.
    const motion = Math.abs(intent.fx) + Math.abs(intent.fy) + Math.abs(intent.torque);
    expect(motion).toBeGreaterThan(0);
    // IDLE drones never fire.
    expect(intent.fire).toBeUndefined();
  });

  it('IDLE drone never fires even when a non-hostile player is in lethal position', () => {
    const b = new HostileDroneBehaviour();
    // Player directly ahead of a drone facing +y, in fire range.
    const intent = b.tick(
      droneAt(0, 0, 0, 0),
      viewWith([{ id: 'innocent', x: 0, y: 100 }], 100),
    );
    expect(intent.fire).toBeUndefined();
  });

  it('IDLE drone outside the patrol radius steers back inward over many ticks', () => {
    // Spawn the drone well outside the patrol radius. With the inward
    // bias active, repeated ticks of patrol intent — applied through a
    // simple Euler integrator that mimics Rapier's drag — should bring
    // the drone closer to origin over time.
    const b = new HostileDroneBehaviour();
    let x = 5000, y = 0, angle = 0, angvel = 0;
    let vx = 0, vy = 0;
    const drag = 0.97; // approximation of Rapier linear damping per tick
    const angDrag = 0.85;
    for (let t = 0; t < 1200; t++) {
      const intent = b.tick({ id: 'd', x, y, vx, vy, angle, angvel }, viewWith([], t));
      // Linear: velocity Verlet–ish. Mass=1 for simplicity.
      vx = vx * drag + intent.fx;
      vy = vy * drag + intent.fy;
      x += vx * (1 / 60);
      y += vy * (1 / 60);
      angvel = angvel * angDrag + intent.torque;
      angle += angvel * (1 / 60);
    }
    const finalR = Math.hypot(x, y);
    // Drone should have moved measurably toward origin (started at 5000).
    expect(finalR).toBeLessThan(5000);
  });
});

describe('HostileDroneBehaviour — hostility lifecycle', () => {
  it('flips to COMBAT after markHostile', () => {
    const b = new HostileDroneBehaviour();
    expect(b.getState()).toBe('IDLE');
    b.markHostile('attacker', 100);
    expect(b.getState()).toBe('COMBAT');
  });

  it('returns to IDLE after purgeHostility clears the only hostile', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('attacker', 100);
    expect(b.getState()).toBe('COMBAT');
    b.purgeHostility('attacker');
    expect(b.getState()).toBe('IDLE');
  });

  it('stays in COMBAT after purging one of two hostiles', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('a', 100);
    b.markHostile('b', 100);
    b.purgeHostility('a');
    expect(b.getState()).toBe('COMBAT');
  });

  it('time-decays hostile players after FORGET_TICKS without a fresh hit', () => {
    // FORGET_TICKS = 1800 in HostileDroneBehaviour. Bump tick past that.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 100);
    // Tick at 100 + 1801: hostility should have decayed and state should
    // return to IDLE on the next tick (decay runs at the top of `tick`).
    b.tick(droneAt(0, 0, 0, 0), viewWith([], 100 + 1801));
    expect(b.getState()).toBe('IDLE');
  });

  it('markHostile is a no-op for falsy shooterIds', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('', 100);
    expect(b.getState()).toBe('IDLE');
  });

  it('purgeHostility is a no-op for unknown players', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('a', 100);
    b.purgeHostility('not-a');
    expect(b.getState()).toBe('COMBAT');
  });
});

describe('HostileDroneBehaviour — COMBAT pursuit', () => {
  // Combat tests now require markHostile to put the drone in COMBAT mode
  // (which targets only marked-hostile players, not "any nearest").

  it('targets the nearest hostile when two players are present', () => {
    // Far player at (200, 0); near (and hostile) at (0, 50). Drone at
    // origin facing +y already aims at the near player.
    const b = new HostileDroneBehaviour();
    b.markHostile('near', 0);
    b.markHostile('far', 0);
    const intent = b.tick(
      droneAt(0, 0, 0, 0),
      viewWith([{ id: 'far', x: 200, y: 0 }, { id: 'near', x: 0, y: 50 }]),
    );
    expect(Math.abs(intent.torque)).toBeLessThan(0.1);
    expect(intent.fy).toBeGreaterThan(0);
  });

  it('ignores non-hostile players (a bystander cannot bait the drone)', () => {
    // Drone hostile only to "attacker"; bystander is closer but invisible
    // to combat targeting. Drone should fall through to patrol because
    // there's no hostile in view (attacker not in view this frame).
    const b = new HostileDroneBehaviour();
    b.markHostile('attacker', 0);
    const intent = b.tick(
      droneAt(500, 0, 0, 0),
      viewWith([{ id: 'bystander', x: 510, y: 0 }]),
    );
    // Patrol intent: never fires on bystanders.
    expect(intent.fire).toBeUndefined();
  });

  it('produces nonzero torque when hostile target is off-bearing', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 100, y: 0 }]));
    expect(intent.torque).not.toBe(0);
  });

  it('thrust is along the drone\'s current forward, not toward the target', () => {
    // Drone at angle=π/2 → forward = (-sin(π/2), cos(π/2)) = (-1, 0).
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, Math.PI / 2, 0), viewWith([{ id: 'p', x: 100, y: 0 }]));
    expect(intent.fx).toBeLessThan(0);
    expect(intent.fy).toBeCloseTo(0, 5);
  });

  it('fires when in range, aimed, and off cooldown', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 100 }], 100));
    expect(intent.fire).toBeDefined();
    expect(intent.fire!.dirX).toBeCloseTo(0, 5);
    expect(intent.fire!.dirY).toBeCloseTo(1, 5);
  });

  it('does not fire when out of range', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 500 }], 100));
    expect(intent.fire).toBeUndefined();
  });

  it('does not fire when off-bearing', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 100, y: 0 }], 100));
    expect(intent.fire).toBeUndefined();
  });

  it('respects cooldown (no fire on second call within WEAPON_COOLDOWN_TICKS)', () => {
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const aimed = viewWith([{ id: 'p', x: 0, y: 100 }], 100);
    const first = b.tick(droneAt(0, 0, 0, 0), aimed);
    expect(first.fire).toBeDefined();

    const tooSoon = viewWith([{ id: 'p', x: 0, y: 100 }], 100 + WEAPON_COOLDOWN_TICKS - 1);
    const second = b.tick(droneAt(0, 0, 0, 0), tooSoon);
    expect(second.fire).toBeUndefined();

    const offCooldown = viewWith([{ id: 'p', x: 0, y: 100 }], 100 + WEAPON_COOLDOWN_TICKS);
    const third = b.tick(droneAt(0, 0, 0, 0), offCooldown);
    expect(third.fire).toBeDefined();
  });

  it('lead-aims a moving target (off-axis aim error when target has lateral velocity)', () => {
    // Drone at origin facing +y, perfectly aligned with a STATIONARY
    // target at (0, 200) — would fire immediately. With the same target
    // moving at +x (vx=100, vy=0), the drone should now aim slightly
    // to the right of straight, producing a non-zero bearing error
    // and (with that error > tolerance) NOT firing this tick.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const moving: AiWorldView = {
      players: [{ id: 'p', x: 0, y: 200, vx: 100, vy: 0 }],
      tick: 100,
      dtSec: 1 / 60,
    };
    const intent = b.tick(droneAt(0, 0, 0, 0), moving);
    expect(intent.torque).not.toBe(0);
  });

  it('boosts forward thrust when the hostile target is far', () => {
    // Engagement-distance threshold is 1.5 × DRONE_FIRE_RANGE = 450.
    // Drone facing +y; target along +y at 600 (boosted) vs 200 (no boost).
    const b1 = new HostileDroneBehaviour();
    b1.markHostile('p', 0);
    const farIntent = b1.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 600 }]));

    const b2 = new HostileDroneBehaviour();
    b2.markHostile('p', 0);
    const nearIntent = b2.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 200 }]));

    expect(farIntent.fy).toBeGreaterThan(nearIntent.fy);
  });

  it('uses the wider point-blank fire arc when the target is very close', () => {
    // Point-blank threshold is 0.4 × DRONE_FIRE_RANGE = 120. At normal
    // distance and a 0.3 rad bearing error the drone would be off-cone
    // (tolerance 0.25); at point-blank (tolerance 0.45) it fires.
    // Drone at (0,0,0): forward = +y. Player at distance 80 along an
    // angle ~0.3 off the nose.
    const b = new HostileDroneBehaviour();
    b.markHostile('p', 0);
    const angle = 0.3; // bearing error
    const dist = 80;
    const px = -Math.sin(angle) * dist;  // mirrors the forward derivation
    const py = Math.cos(angle) * dist;
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: px, y: py }], 100));
    expect(intent.fire).toBeDefined();
  });
});
