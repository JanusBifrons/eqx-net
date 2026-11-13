/**
 * Capital wreck crack hold: `applyRigidGroupImpulse` pushes a group of bodies
 * as ONE rigid body (owner review 2026-11-13: the rest of a salvo landing
 * during the hold bent the hull). After the impulse every body spins at the
 * same rate and moves at v_com + ω × r, the group's linear momentum grows by
 * exactly J, and an off-centre impulse turns the group the way it pushes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PhysicsWorld } from './World.js';

let world: PhysicsWorld;
beforeAll(async () => {
  world = await PhysicsWorld.create();
});

const box = (h: number) => [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];

describe('PhysicsWorld.applyRigidGroupImpulse', () => {
  it('moves the group as one rigid body and adds exactly J to its momentum', () => {
    const ids = ['g-a', 'g-b', 'g-c'];
    world.spawnObstacle('g-a', -300, 0, 60, 100, undefined, 0, undefined, [box(40)]);
    world.spawnObstacle('g-b', 0, 0, 60, 200, undefined, 0, undefined, [box(40)]);
    world.spawnObstacle('g-c', 250, 40, 60, 300, undefined, 0, undefined, [box(40)]);
    const mass = (id: string): number => world.getBodyMass(id)!;
    const p0x = ids.reduce((s, id) => s + mass(id) * world.getShipState(id)!.vx, 0);
    const p0y = ids.reduce((s, id) => s + mass(id) * world.getShipState(id)!.vy, 0);

    const jx = 0, jy = 5000;
    // A gone id ('gone') is skipped.
    world.applyRigidGroupImpulse([...ids, 'gone'], jx, jy, 250, 40);

    const st = ids.map((id) => world.getShipState(id)!);
    // One spin for all, and the far-right hit turns the group anticlockwise.
    expect(st[0]!.angvel).toBeGreaterThan(0);
    for (const s of st) expect(s.angvel).toBeCloseTo(st[0]!.angvel!, 9);
    // Rigid: v_b − v_a = ω × (p_b − p_a) for every pair.
    const w = st[0]!.angvel!;
    for (let i = 0; i < st.length; i++) {
      for (let k = i + 1; k < st.length; k++) {
        const a = st[i]!, b = st[k]!;
        expect(b.vx - a.vx).toBeCloseTo(-w * (b.y - a.y), 6);
        expect(b.vy - a.vy).toBeCloseTo(w * (b.x - a.x), 6);
      }
    }
    // Linear momentum grows by exactly J.
    const p1x = ids.reduce((s, id, i) => s + mass(id) * st[i]!.vx, 0);
    const p1y = ids.reduce((s, id, i) => s + mass(id) * st[i]!.vy, 0);
    expect(p1x - p0x).toBeCloseTo(jx, 3);
    expect(p1y - p0y).toBeCloseTo(jy, 3);
  });
});
