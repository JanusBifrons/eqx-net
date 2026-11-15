/**
 * Ship stats belong to the ship, never the pilot (owner's rule, 2026-11-13:
 * "Ships turning, acceleration, weapons, everything is related to the ship,
 * regardless of pilot").
 *
 * The bug this locks: a kind with no authored `mass` spawned at mass 1 as a
 * player ship (`World.spawnShip`, `massOf(kind, 1)`), at mass 2 as a server
 * drone (`SwarmSpawner`, `NPC_MASS_FALLBACK`) and at mass 3 in the client
 * predWorld (`DroneClientLeaf`, `DRONE_FALLBACK_MASS`). The same fighter was
 * twice as heavy, turned half as fast under torque and accelerated half as
 * hard when an NPC flew it, and a player-vs-NPC ram of two identical hulls
 * dealt mass-differential damage. A drone body also had angular damping 0
 * until its first AI input.
 *
 * For EVERY kind in the catalogue (unauthored-mass kinds and capitals
 * included) a pilot ship (`spawnShip`) and an NPC ship spawned the way the
 * server spawns one (SwarmSpawner -> worker SPAWN_OBSTACLE -> World) must
 * have the same mass, angular inertia, linear and angular damping, and move
 * identically under the same control keys. The client predWorld drone body
 * (`DroneClientLeaf`) must carry the same mass and inertia (#15).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { getShipKind, SHIP_KINDS_LIST, shipKindFromIndex } from '../../src/shared-types/shipKinds.js';
import { SwarmSpawner } from '../../src/server/spawn/SwarmSpawner.js';
import { SwarmEntityRegistry } from '../../src/server/net/SwarmEntityRegistry.js';
import { SAB_TOTAL_BYTES } from '../../src/shared-types/sabLayout.js';
import { DroneClientLeaf } from '../../src/client/net/entity/leaves/droneClientLeaf.js';
import type {
  AiLedgerHandle,
  ClientSpawnCtx,
  PredWorldHandle,
  SwarmRenderState,
} from '../../src/client/net/entity/IClientEntityLeaf.js';

interface Dyn { mass: number; inertia: number; linDamp: number; angDamp: number }

function dyn(world: PhysicsWorld, id: string): Dyn {
  const b = (world as unknown as { bodies: Map<string, { body: RAPIER.RigidBody }> }).bodies.get(id)!.body;
  return { mass: b.mass(), inertia: b.principalInertia(), linDamp: b.linearDamping(), angDamp: b.angularDamping() };
}

/** Server path: what SwarmSpawner posts, replayed through the worker's
 *  SPAWN_OBSTACLE handler (worker.ts). */
function serverDrone(world: PhysicsWorld, kindId: string, x: number): string {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  let posted: unknown[] | null = null;
  const slots = [10];
  const spawner = new SwarmSpawner(new SwarmEntityRegistry(), {
    takeSlot: () => slots.pop(),
    postSpawnObstacle: (...args: unknown[]) => { posted = args; },
    sabF32: new Float32Array(sab),
    sabU32: new Uint32Array(sab),
  });
  spawner.spawnDrone({ id: `npc-${kindId}`, x, y: 0, kind: kindId as never });
  expect(posted).not.toBeNull();
  const [, id, , , , , radius, mass, vertices, linearDamping, , collisionGroups, , parts, shieldKindId, spin, shipKindId] =
    posted as unknown as [number, string, number, number, number, number, number, number, never, number, boolean, number, number, never, string | undefined, { angvel: number; angularDamping: number } | undefined, number | undefined];
  world.spawnObstacle(id, x, 0, radius, mass, vertices, linearDamping, collisionGroups, parts, shieldKindId ? getShipKind(shieldKindId) : undefined);
  if (spin) world.setAngularDamping(id, spin.angularDamping);
  if (shipKindId !== undefined) world.setPilotKind(id, getShipKind(shipKindFromIndex(shipKindId)));
  return id;
}

function clientCtx(world: PhysicsWorld, kindId: string): ClientSpawnCtx {
  const ai = { register: () => {}, unregister: () => {} } as unknown as AiLedgerHandle;
  return {
    predWorld: world as unknown as PredWorldHandle,
    aiController: ai,
    entityId: 7,
    key: 'swarm-7',
    entry: {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      radius: getShipKind(kindId).radius, kind: 1, shipKind: kindId, shieldDown: false,
    } as unknown as SwarmRenderState,
    registeredAiId: null,
  };
}

function expectSameDyn(a: Dyn, b: Dyn): void {
  expect(a.mass).toBeCloseTo(b.mass, 6);
  expect(a.inertia / b.inertia).toBeCloseTo(1, 6);
  expect(a.linDamp).toBeCloseTo(b.linDamp, 6);
  expect(a.angDamp).toBeCloseTo(b.angDamp, 6);
}

const KINDS = SHIP_KINDS_LIST.map((k) => k.id);

describe('ship stats are the ship\'s, not the pilot\'s', () => {
  beforeAll(async () => { await RAPIER.init(); });

  it('the catalogue covers an unauthored-mass kind and a capital', () => {
    expect(SHIP_KINDS_LIST.some((k) => k.mass === undefined)).toBe(true);
    expect(SHIP_KINDS_LIST.some((k) => k.sizeClass === 'capital')).toBe(true);
  });

  for (const kindId of KINDS) {
    it(`${kindId}: NPC body == pilot body (mass, inertia, damping) at spawn, server and client`, async () => {
      const world = await PhysicsWorld.create();
      world.spawnShip('pilot', -1_000_000, 0, kindId as never);
      const npc = serverDrone(world, kindId, 1_000_000);
      const p = dyn(world, 'pilot');
      expectSameDyn(dyn(world, npc), p);

      const cw = await PhysicsWorld.create();
      new DroneClientLeaf().spawnBody(clientCtx(cw, kindId));
      const c = dyn(cw, 'swarm-7');
      expect(c.mass).toBeCloseTo(p.mass, 6);
      expect(c.inertia / p.inertia).toBeCloseTo(1, 6);
    });

    it(`${kindId}: NPC moves exactly like a pilot under the same keys`, async () => {
      const world = await PhysicsWorld.create();
      world.spawnShip('pilot', -1_000_000, 0, kindId as never);
      const npc = serverDrone(world, kindId, 1_000_000);
      const seq: Array<[boolean, boolean, boolean, boolean, boolean, number]> = [
        [true, false, false, false, true, 60],
        [true, false, true, false, false, 40],
        [false, false, false, false, false, 30],
        [false, true, false, true, false, 30],
      ];
      for (const [thrust, reverse, turnLeft, turnRight, boost, n] of seq) {
        const keys = { thrust, reverse, turnLeft, turnRight, boost };
        for (let i = 0; i < n; i++) {
          world.applyInput('pilot', keys);
          world.applyAiInput(npc, keys);
          world.tick(1 / 60);
        }
        const p = world.getShipState('pilot')!;
        const s = world.getShipState(npc)!;
        expect(s.vx).toBeCloseTo(p.vx, 3);
        expect(s.vy).toBeCloseTo(p.vy, 3);
        expect(s.angle).toBeCloseTo(p.angle, 4);
        expect(s.angvel ?? 0).toBeCloseTo(p.angvel ?? 0, 4);
      }
    });
  }
});
