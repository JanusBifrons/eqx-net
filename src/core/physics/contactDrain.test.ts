/**
 * Stage 2 cycle 1 of the network-feel roadmap. Pure-function unit tests for
 * the worker's contact-event drain logic.
 *
 * The function is the bridge between Rapier's `EventQueue` (populated during
 * `world.step()` on dynamic-body colliders that have CONTACT_FORCE_EVENTS
 * enabled) and the discrete `CONTACT` message variant the worker posts to
 * the main thread. By extracting it to a pure function, we get unit-test
 * coverage of the impulse-floor filter and the body-id resolution without
 * needing to spawn a real worker_threads instance.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from './World.js';
import { drainContacts } from './contactDrain.js';

beforeAll(async () => {
  await RAPIER.init();
});

describe('drainContacts', () => {
  it('returns one contact for a known two-body collision above the force floor', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    world.spawnShip('a', -20, 0);
    world.spawnShip('b', 20, 0);
    // Steer the two ships into each other at ~80 u/s combined closing speed.
    world.setShipState('a', { x: -20, y: 0, angle: 0, vx: 40, vy: 0 });
    world.setShipState('b', { x: 20, y: 0, angle: 0, vx: -40, vy: 0 });

    // Run the world forward until they collide. The ship body radius is the
    // default `kind.radius` (~14 u), and the gap is 40 u, so contact lands
    // somewhere around tick 12 at this closing speed.
    for (let i = 0; i < 60; i++) world.tick(1 / 60, eventQueue);

    const contacts = drainContacts(eventQueue, world, 50);

    expect(contacts.length).toBeGreaterThan(0);
    const c = contacts[0]!;
    const ids = [c.aId, c.bId].sort();
    expect(ids).toEqual(['a', 'b']);
    expect(c.forceMagnitude).toBeGreaterThan(50);

    // After the collision, both ships should have non-trivial vPost values.
    expect(Math.abs(c.vAxPost) + Math.abs(c.vAyPost)).toBeGreaterThan(0);
    expect(Math.abs(c.vBxPost) + Math.abs(c.vByPost)).toBeGreaterThan(0);

    world.dispose();
  });

  it('returns empty when no contacts occur', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    world.spawnShip('a', 0, 0);
    world.spawnShip('b', 200, 0);

    // Bodies far apart, no closing velocity; they never collide.
    for (let i = 0; i < 30; i++) world.tick(1 / 60, eventQueue);

    expect(drainContacts(eventQueue, world, 50)).toEqual([]);

    world.dispose();
  });

  it('tags each contact with impactSpeed = |relative pre-step velocity| from preVel', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    world.spawnShip('a', -20, 0);
    world.spawnShip('b', 20, 0);
    world.setShipState('a', { x: -20, y: 0, angle: 0, vx: 40, vy: 0 });
    world.setShipState('b', { x: 20, y: 0, angle: 0, vx: -40, vy: 0 });
    for (let i = 0; i < 60; i++) world.tick(1 / 60, eventQueue);

    // The caller supplies the PRE-step (approach) velocities. The closing speed
    // is the magnitude of their relative velocity, independent of the noisy
    // post-collision velocities the world now holds.
    const preVel = new Map<string, { vx: number; vy: number }>([
      ['a', { vx: 40, vy: 0 }],
      ['b', { vx: -40, vy: 0 }],
    ]);
    const contacts = drainContacts(eventQueue, world, 50, preVel);
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0]!.impactSpeed).toBeCloseTo(80, 6); // |40 - (-40)|

    world.dispose();
  });

  it('treats an entity missing from preVel as at rest (correct for a static structure)', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    world.spawnShip('a', -20, 0);
    world.spawnShip('b', 20, 0);
    world.setShipState('a', { x: -20, y: 0, angle: 0, vx: 40, vy: 0 });
    world.setShipState('b', { x: 20, y: 0, angle: 0, vx: -40, vy: 0 });
    for (let i = 0; i < 60; i++) world.tick(1 / 60, eventQueue);

    // Only 'a' has a recorded pre-velocity; 'b' (a stand-in static structure)
    // is absent ⇒ treated as 0 ⇒ impactSpeed = |a's approach speed|.
    const preVel = new Map<string, { vx: number; vy: number }>([['a', { vx: 40, vy: 30 }]]);
    const contacts = drainContacts(eventQueue, world, 50, preVel);
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0]!.impactSpeed).toBeCloseTo(50, 6); // hypot(40, 30)

    world.dispose();
  });

  it('omits impactSpeed when no preVel is supplied (force-fallback path)', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    world.spawnShip('a', -20, 0);
    world.spawnShip('b', 20, 0);
    world.setShipState('a', { x: -20, y: 0, angle: 0, vx: 40, vy: 0 });
    world.setShipState('b', { x: 20, y: 0, angle: 0, vx: -40, vy: 0 });
    for (let i = 0; i < 60; i++) world.tick(1 / 60, eventQueue);

    const contacts = drainContacts(eventQueue, world, 50);
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts[0]!.impactSpeed).toBeUndefined();

    world.dispose();
  });

  it('filters out contacts whose force is below the floor', async () => {
    const world = await PhysicsWorld.create();
    const eventQueue = new RAPIER.EventQueue(true);
    world.spawnShip('a', -20, 0);
    world.spawnShip('b', 20, 0);
    // Slow closing speed — the resulting contact force is small.
    world.setShipState('a', { x: -20, y: 0, angle: 0, vx: 5, vy: 0 });
    world.setShipState('b', { x: 20, y: 0, angle: 0, vx: -5, vy: 0 });

    for (let i = 0; i < 120; i++) world.tick(1 / 60, eventQueue);

    // Force floor much higher than the slow tap — should drop the event.
    const contacts = drainContacts(eventQueue, world, 1_000_000);
    expect(contacts).toEqual([]);

    world.dispose();
  });
});
