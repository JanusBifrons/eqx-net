import { describe, it, expect, beforeEach } from 'vitest';
import { AiController, type AiIntentSink } from './AiController.js';
import { HostileDroneBehaviour } from './HostileDroneBehaviour.js';
import { DriftingAsteroidBehaviour } from './DriftingAsteroidBehaviour.js';
import type { AiEntity, AiPlayerView } from '../contracts/IAiBehaviour.js';
import { WEAPON_COOLDOWN_TICKS } from '../combat/Weapons.js';

interface PostedIntent { slot: number; fx: number; fy: number; torque: number }

class CapturingSink implements AiIntentSink {
  posted: PostedIntent[] = [];
  postIntent(slot: number, fx: number, fy: number, torque: number): void {
    this.posted.push({ slot, fx, fy, torque });
  }
}

const playerAt = (id: string, x: number, y: number): AiPlayerView => ({ id, x, y, vx: 0, vy: 0 });
const entityAt = (id: string, x: number, y: number, angle = 0, angvel = 0): AiEntity => ({
  id, x, y, vx: 0, vy: 0, angle, angvel,
});

describe('AiController', () => {
  let sink: CapturingSink;
  let ctrl: AiController;

  beforeEach(() => {
    sink = new CapturingSink();
    ctrl = new AiController(sink);
  });

  it('starts empty and ticks no-op', () => {
    expect(ctrl.size()).toBe(0);
    ctrl.tick(0, 1 / 60, [], () => null);
    expect(sink.posted).toHaveLength(0);
    expect(ctrl.drainFireRequests()).toHaveLength(0);
  });

  it('register / unregister / has / size', () => {
    ctrl.register('drone-1', 7, new HostileDroneBehaviour());
    expect(ctrl.has('drone-1')).toBe(true);
    expect(ctrl.size()).toBe(1);
    ctrl.unregister('drone-1');
    expect(ctrl.has('drone-1')).toBe(false);
    expect(ctrl.size()).toBe(0);
  });

  it('drone produces a nonzero impulse toward the nearest player', () => {
    ctrl.register('drone-1', 5, new HostileDroneBehaviour());
    // Drone at origin facing +y, player at (0, 100). Drone is aimed → forward thrust along +y.
    ctrl.tick(0, 1 / 60, [playerAt('p1', 0, 100)], (id) =>
      id === 'drone-1' ? entityAt(id, 0, 0, 0, 0) : null,
    );
    expect(sink.posted).toHaveLength(1);
    const intent = sink.posted[0]!;
    expect(intent.slot).toBe(5);
    expect(intent.fy).toBeGreaterThan(0);
  });

  it('skips entities whose snapshot is unavailable', () => {
    ctrl.register('drone-ghost', 9, new HostileDroneBehaviour());
    ctrl.tick(0, 1 / 60, [playerAt('p1', 0, 100)], () => null);
    expect(sink.posted).toHaveLength(0);
  });

  it('does not post a zero-intent (asteroid) entry to the worker', () => {
    ctrl.register('rock-1', 3, new DriftingAsteroidBehaviour());
    ctrl.tick(0, 1 / 60, [playerAt('p1', 100, 100)], (id) =>
      id === 'rock-1' ? entityAt(id, 0, 0) : null,
    );
    expect(sink.posted).toHaveLength(0);
  });

  it('drainFireRequests returns and clears queued fires; cooldown enforced', () => {
    ctrl.register('drone-1', 4, new HostileDroneBehaviour());
    // Aimed, in range: drone fires.
    ctrl.tick(100, 1 / 60, [playerAt('p1', 0, 100)], () => entityAt('drone-1', 0, 0, 0, 0));
    let fires = ctrl.drainFireRequests();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.shooterId).toBe('drone-1');
    expect(fires[0]!.tick).toBe(100);

    // Drain clears the queue.
    expect(ctrl.drainFireRequests()).toHaveLength(0);

    // Within cooldown — no new fire.
    ctrl.tick(100 + WEAPON_COOLDOWN_TICKS - 1, 1 / 60, [playerAt('p1', 0, 100)], () => entityAt('drone-1', 0, 0, 0, 0));
    expect(ctrl.drainFireRequests()).toHaveLength(0);

    // Off cooldown — fires again.
    ctrl.tick(100 + WEAPON_COOLDOWN_TICKS, 1 / 60, [playerAt('p1', 0, 100)], () => entityAt('drone-1', 0, 0, 0, 0));
    fires = ctrl.drainFireRequests();
    expect(fires).toHaveLength(1);
  });

  it('multiple entities tick independently each call', () => {
    ctrl.register('drone-a', 1, new HostileDroneBehaviour());
    ctrl.register('drone-b', 2, new HostileDroneBehaviour());
    ctrl.tick(0, 1 / 60, [playerAt('p1', 0, 100)], (id) => {
      if (id === 'drone-a') return entityAt(id, 0, 0, 0, 0);
      if (id === 'drone-b') return entityAt(id, 50, 0, 0, 0);
      return null;
    });
    expect(sink.posted).toHaveLength(2);
    const slots = sink.posted.map((p) => p.slot).sort();
    expect(slots).toEqual([1, 2]);
  });
});
