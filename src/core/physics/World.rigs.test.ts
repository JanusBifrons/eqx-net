/**
 * Structure-restyle 2d: solid (`plane`-layer) rig parts are kinematic bodies
 * in the physics world (`PhysicsWorld.attachRig` / `setRigClip` /
 * `stepRigs`). A clip moves the collider; a closed door blocks a ship and an
 * open one lets it through; a moving part pushes what it meets.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from './World.js';
import { buildRig, type Rig } from '../articulation/rig.js';
import { rigById } from '../articulation/rigCatalogue.js';

/** A wide slab "door" 200 u in front (+y) of its host, sliding 1000 u along
 *  +x when opened (fully open at tick 20). */
function slabDoorRig(): Rig {
  return buildRig({
    id: 'test-slab-door',
    parts: [
      {
        id: 'slab', parent: null, anchorX: 0, anchorY: 200,
        joint: { type: 'slide', axisX: 1, axisY: 0, min: 0, max: 1000 },
        rest: 0, layer: 'plane', kind: 'physical',
        outline: [-300, -10, 300, -10, 300, 10, -300, 10],
      },
      {
        // Over-layer decoration: never a body.
        id: 'lamp', parent: 'slab', anchorX: 0, anchorY: 0,
        joint: { type: 'hinge', min: -1, max: 1 },
        rest: 0, layer: 'over', kind: 'physical',
        outline: [-5, -5, 5, -5, 5, 5, -5, 5],
      },
    ],
    clips: [
      { id: 'open', tracks: [{ part: 'slab', keys: [{ tick: 20, value: 1000 }] }] },
    ],
  });
}

/** A tiny locked host body at the origin (a structure stands in for it). */
function spawnHost(w: PhysicsWorld, id = 'host'): void {
  w.spawnObstacle(id, 0, 0, 5, 1000);
  w.lockBody(id);
}

describe('PhysicsWorld rig parts (structure-restyle 2d)', () => {
  it('a clip moves the part collider; over-layer parts get no body', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    expect(w.rigPartPose('host', 'slab')).toMatchObject({ x: 0, y: 200 });
    expect(w.rigPartPose('host', 'lamp')).toBeNull();
    w.setRigClip('host', 'open', 0);
    for (let t = 0; t < 30; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
    }
    const p = w.rigPartPose('host', 'slab')!;
    expect(p.x).toBeCloseTo(1000, 3);
    expect(p.y).toBeCloseTo(200, 3);
  });

  it('a closed door blocks a ship; once open the ship passes', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    w.spawnShip('ship', 0, 120); // faces +y, between host and door
    let t = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++, t++) {
        w.applyInput('ship', { thrust: true, turnLeft: false, turnRight: false });
        w.stepRigs(t + 1);
        w.tick(1 / 60);
      }
    };
    run(120);
    const blocked = w.getShipState('ship')!;
    expect(blocked.y, 'the closed door stops the ship').toBeLessThan(200);

    w.setRigClip('host', 'open', t);
    run(180);
    const passed = w.getShipState('ship')!;
    expect(passed.y, 'the open door lets the ship through').toBeGreaterThan(260);
  });

  it('a sliding part pushes a ship in its path', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    w.spawnShip('ship', 500, 200); // in the slab's path, right of it
    w.setRigClip('host', 'open', 0);
    for (let t = 0; t < 60; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
    }
    expect(w.getShipState('ship')!.x).toBeGreaterThan(700);
  });

  it('the catalogue turret rig: door-open slides each leaf 30 u out from over the socket', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w, 'turret-1');
    w.attachRig('turret-1', rigById('sandbox-door-turret')!);
    expect(w.rigPartPose('turret-1', 'door-left')!.x).toBeCloseTo(-12, 6);
    expect(w.rigPartPose('turret-1', 'door-left')!.y).toBeCloseTo(0, 6);
    w.setRigClip('turret-1', 'door-open', 10);
    for (let t = 0; t < 40; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
    }
    expect(w.rigPartPose('turret-1', 'door-left')!.x).toBeCloseTo(-42, 3);
    expect(w.rigPartPose('turret-1', 'door-right')!.x).toBeCloseTo(42, 3);
    expect(w.rigPartPose('turret-1', 'door-left')!.y).toBeCloseTo(0, 3);
  });

  it('the catalogue turret rig: the lift-only turret collider never moves through deploy and retract', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w, 'turret-1');
    w.attachRig('turret-1', rigById('sandbox-door-turret')!);
    const p0 = { ...w.rigPartPose('turret-1', 'turret-lift')! };
    w.setRigClip('turret-1', 'turret-deploy', 1);
    let t = 0;
    for (; t < 80; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
      const p = w.rigPartPose('turret-1', 'turret-lift')!;
      expect(p.x).toBeCloseTo(p0.x, 9);
      expect(p.y).toBeCloseTo(p0.y, 9);
      expect(p.angle).toBeCloseTo(p0.angle, 9);
    }
    w.setRigClip('turret-1', 'turret-retract', t);
    for (; t < 160; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
      const p = w.rigPartPose('turret-1', 'turret-lift')!;
      expect(p.x).toBeCloseTo(p0.x, 9);
      expect(p.y).toBeCloseTo(p0.y, 9);
    }
  });

  it('follows its host: a moved host re-poses the parts', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    w.setShipState('host', { x: 100, y: 0, vx: 0, vy: 0, angle: Math.PI / 2 });
    w.stepRigs(1);
    w.tick(1 / 60);
    const p = w.rigPartPose('host', 'slab')!;
    // Anchor (0, 200) rotated +90° ⇒ (-200, 0), plus the host at (100, 0).
    expect(p.x).toBeCloseTo(-100, 3);
    expect(p.y).toBeCloseTo(0, 3);
    expect(p.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('despawning the host removes its parts', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    w.despawnShip('host');
    expect(w.rigPartPose('host', 'slab')).toBeNull();
    w.stepRigs(1); // no stale entry left in the per-tick walk
    w.tick(1 / 60);
  });

  it('a finished or absent clip is posed once, then skipped', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    w.setRigClip('host', 'open', 0);
    for (let t = 0; t < 25; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
    }
    // Clip finished at tick 20: a stepRigs with any later tick changes nothing
    // (skipped), even a tick that would read differently if evaluated.
    w.stepRigs(5);
    w.tick(1 / 60);
    expect(w.rigPartPose('host', 'slab')!.x).toBeCloseTo(1000, 3);
  });

  it('2e: re-applying the playing record is a no-op (the client re-applies it every snapshot)', async () => {
    const w = await PhysicsWorld.create();
    spawnHost(w);
    w.attachRig('host', slabDoorRig());
    w.setRigClip('host', 'open', 0);
    for (let t = 0; t < 25; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
    }
    // Finished and idle: the same record again must not re-pose it at an
    // older tick (it would if it marked the rig dirty).
    w.setRigClip('host', 'open', 0);
    w.stepRigs(5);
    w.tick(1 / 60);
    expect(w.rigPartPose('host', 'slab')!.x).toBeCloseTo(1000, 3);
    // A different start tick is a new record: it re-poses.
    w.setRigClip('host', 'open', 100);
    w.stepRigs(110);
    w.tick(1 / 60);
    expect(w.rigPartPose('host', 'slab')!.x).toBeCloseTo(500, 3);
  });
});

describe('rig clip tick numbering (2e): live, late join and reconcile replay agree', () => {
  /** Step `w` over ticks [from, to) the way the client loop and the
   *  Reconciler's per-replay-tick hook both do: `stepRigs(t + 1)` then a step. */
  function run(w: PhysicsWorld, from: number, to: number): void {
    for (let t = from; t < to; t++) {
      w.stepRigs(t + 1);
      w.tick(1 / 60);
    }
  }

  it('a client that attaches mid-clip, and a replay over the window, land on the live pose', async () => {
    const START = 1000;
    // The live client: saw the clip from its start.
    const live = await PhysicsWorld.create();
    spawnHost(live);
    live.attachRig('host', slabDoorRig());
    live.setRigClip('host', 'open', START);
    run(live, START, START + 12);
    // The late joiner: attaches at START + 8 from the room-state record.
    const late = await PhysicsWorld.create();
    spawnHost(late);
    late.attachRig('host', slabDoorRig());
    late.setRigClip('host', 'open', START);
    run(late, START + 8, START + 12);
    const want = live.rigPartPose('host', 'slab')!.x;
    expect(want).toBeGreaterThan(100); // mid-clip: neither rest nor fully open
    expect(want).toBeLessThan(900);
    expect(late.rigPartPose('host', 'slab')!.x).toBeCloseTo(want, 3);
    // A reconcile replays [acked, input) with the same hook: same end pose.
    run(live, START + 6, START + 12);
    expect(live.rigPartPose('host', 'slab')!.x).toBeCloseTo(want, 3);
  });
});
