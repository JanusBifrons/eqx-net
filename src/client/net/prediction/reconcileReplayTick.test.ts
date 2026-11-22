import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from '@core/physics/World';
import { Reconciler } from '@core/prediction/Reconciler';
import { reconcileReplayTick } from './reconcileReplayTick.js';

describe('reconcileReplayTick', () => {
  it('replays up to the input tick in play, nothing while physics is paused', () => {
    expect(reconcileReplayTick(false, 27140, 27134)).toBe(27140);
    expect(reconcileReplayTick(true, 27135, 0)).toBe(0);
  });

  it('a join-curtain snapshot runs no replay steps but still snaps to the server pose (phone capture p7uotg)', async () => {
    // Behind the curtain: input tick frozen at the welcome tick, nothing acked.
    // Before the fix every snapshot replayed the capped 128 input-less ticks.
    const world = await PhysicsWorld.create();
    world.spawnShip('p', 0, 0);
    const r = new Reconciler(world, 'p');
    let steps = 0;
    const tick = world.tick.bind(world);
    world.tick = (dt: number) => { steps++; tick(dt); };
    const server = { x: 3112, y: 4126, vx: 0, vy: 0, angle: 0, angvel: 0 };

    for (let i = 0; i < 5; i++) r.reconcile(server, 27139 + i, reconcileReplayTick(true, 27135, 0), 0);
    expect(steps).toBe(0);
    const s = world.getShipState('p')!;
    expect(s.x).toBeCloseTo(3112, 3);
    expect(s.y).toBeCloseTo(4126, 3);

    // Curtain down: the same call shape replays the window as before.
    r.reconcile(server, 27150, reconcileReplayTick(false, 27135, 0), 0);
    expect(steps).toBe(128);
  });
});
