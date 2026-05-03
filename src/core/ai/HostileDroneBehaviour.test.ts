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

describe('HostileDroneBehaviour', () => {
  it('returns zero intent with no players', () => {
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(0, 0), viewWith([]));
    expect(intent.fx).toBe(0);
    expect(intent.fy).toBe(0);
    expect(intent.torque).toBe(0);
    expect(intent.fire).toBeUndefined();
  });

  it('picks the nearest player when multiple are present', () => {
    // Drone at origin facing +y (angle=0 → forward = (-sin0, cos0) = (0,1)).
    // Far player along +x, near player along +y. Drone should seek (0, 50).
    const b = new HostileDroneBehaviour();
    const intent = b.tick(
      droneAt(0, 0, 0, 0),
      viewWith([{ id: 'far', x: 200, y: 0 }, { id: 'near', x: 0, y: 50 }]),
    );
    // Already aimed at near (forward is +y, target is +y) → torque small, thrust forward.
    expect(Math.abs(intent.torque)).toBeLessThan(0.1);
    expect(intent.fy).toBeGreaterThan(0);
  });

  it('produces nonzero torque when target is off-bearing', () => {
    // Drone facing +y but target is +x → bearing error = -π/2.
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 100, y: 0 }]));
    expect(intent.torque).not.toBe(0);
  });

  it('thrust is along the drone\'s current forward, not toward the target', () => {
    // Drone at angle=π/2 → forward = (-sin(π/2), cos(π/2)) = (-1, 0).
    // Target at (+100, 0). Drone is mis-aimed; thrust should still be along forward (-x).
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(0, 0, Math.PI / 2, 0), viewWith([{ id: 'p', x: 100, y: 0 }]));
    expect(intent.fx).toBeLessThan(0);
    expect(intent.fy).toBeCloseTo(0, 5);
  });

  it('fires when in range, aimed, and off cooldown', () => {
    // Drone at origin facing +y, player directly ahead at distance 100 (within 0.6 * HITSCAN_RANGE = 300).
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 100 }], 100));
    expect(intent.fire).toBeDefined();
    expect(intent.fire!.dirX).toBeCloseTo(0, 5);
    expect(intent.fire!.dirY).toBeCloseTo(1, 5);
  });

  it('does not fire when out of range', () => {
    // 500 units > DRONE_FIRE_RANGE (300).
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 0, y: 500 }], 100));
    expect(intent.fire).toBeUndefined();
  });

  it('does not fire when off-bearing', () => {
    // Drone facing +y, target along +x (90° off) — outside DRONE_AIM_TOLERANCE.
    const b = new HostileDroneBehaviour();
    const intent = b.tick(droneAt(0, 0, 0, 0), viewWith([{ id: 'p', x: 100, y: 0 }], 100));
    expect(intent.fire).toBeUndefined();
  });

  it('respects cooldown (no fire on second call within WEAPON_COOLDOWN_TICKS)', () => {
    const b = new HostileDroneBehaviour();
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
});
