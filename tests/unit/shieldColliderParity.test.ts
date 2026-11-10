/**
 * Shield collider parity (owner's rule, 2026-11-10: "It's the shields, yes you
 * impact each other's shields"). Every ship with its shield up collides as its
 * shield bubble, and the bubble that is DRAWN is the bubble that collides.
 *
 * The bug this locks: a freshly spawned non-capital drone got `ball(kind.radius)`
 * with no shield pad (24 u for a fighter at the 2x default, smaller than its own
 * drawn hull), on BOTH the server world and the client predWorld, while the same
 * drone after a shield break + regen got `shipShieldColliderDesc(kind)`
 * (radius + shieldPad, 44 u). The drawn aura used a fixed 10 u pad
 * (`SHIELD_RADIUS_PAD`) instead of the `shipTuning` pad, so it matched neither.
 *
 * (a) fresh shield-up collider == regenerated shield-up collider ==
 *     `shipShieldColliderDesc(kind)`, on the server spawn path (SwarmSpawner ->
 *     worker -> `World.spawnObstacle`) and the client path (`DroneClientLeaf`).
 * (b) the drawn bubble radius (`shieldBubbleRadiusForEntity`, the renderer's one
 *     source) equals the shield collider radius, for players and drones.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { shipShieldColliderDesc } from '../../src/core/physics/colliderConfig.js';
import { getShipKind, SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import type { ShipKind } from '../../src/shared-types/shipKinds.js';
import { shieldBubbleRadius } from '../../src/shared-types/shipScale/tuning.js';
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
import { shieldBubbleRadiusForEntity } from '../../src/client/render/pixi/shieldBubbleRadius.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';

interface ShieldShape { type: number; radius: number; restitution: number }

/** The shield-up collider of a body in a real Rapier world. */
function bodyShape(world: PhysicsWorld, id: string): ShieldShape {
  const rec = (world as unknown as { bodies: Map<string, { body: RAPIER.RigidBody }> }).bodies.get(id)!;
  expect(rec.body.numColliders()).toBe(1);
  const c = rec.body.collider(0);
  const type = c.shapeType();
  const radius = type === RAPIER.ShapeType.Ball ? c.radius() : c.roundRadius();
  return { type, radius, restitution: c.restitution() };
}

/** What `shipShieldColliderDesc(kind)` would build. */
function descShape(kind: ShipKind): ShieldShape {
  const d = shipShieldColliderDesc(kind);
  const s = d.shape as unknown as { type: number; radius?: number; borderRadius?: number };
  return {
    type: s.type,
    radius: s.type === RAPIER.ShapeType.Ball ? s.radius! : s.borderRadius!,
    restitution: d.restitution,
  };
}

function expectSame(a: ShieldShape, b: ShieldShape): void {
  expect(a.type).toBe(b.type);
  expect(a.radius).toBeCloseTo(b.radius, 4);
  expect(a.restitution).toBeCloseTo(b.restitution, 6);
}

const DRONE_KINDS = ['fighter', 'interceptor', 'crossguard', 'scout', 'light-cruiser'];

/** Server path: what SwarmSpawner posts, replayed through the worker's call. */
function serverSpawn(world: PhysicsWorld, kindId: string): string {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  let posted: unknown[] | null = null;
  const slots = [10];
  const spawner = new SwarmSpawner(new SwarmEntityRegistry(), {
    takeSlot: () => slots.pop(),
    postSpawnObstacle: (...args: unknown[]) => { posted = args; },
    sabF32: new Float32Array(sab),
    sabU32: new Uint32Array(sab),
  });
  spawner.spawnDrone({ id: `drone-${kindId}`, x: 0, y: 0, kind: kindId as never });
  expect(posted).not.toBeNull();
  const [, id, x, y, , , radius, mass, vertices, linearDamping, , collisionGroups, , parts, shieldKindId] =
    posted as unknown as [number, string, number, number, number, number, number, number, never, number, boolean, number, number, never, string | undefined];
  // The worker's SPAWN_OBSTACLE handler, verbatim (worker.ts).
  world.spawnObstacle(id, x, y, radius, mass, vertices, linearDamping, collisionGroups, parts, shieldKindId ? getShipKind(shieldKindId) : undefined);
  return id;
}

/** Client path: the real DroneClientLeaf against a real predWorld. */
function clientCtx(world: PhysicsWorld, kindId: string, shieldDown: boolean): ClientSpawnCtx {
  const ai = { register: () => {}, unregister: () => {} } as unknown as AiLedgerHandle;
  return {
    predWorld: world as unknown as PredWorldHandle,
    aiController: ai,
    entityId: 7,
    key: 'swarm-7',
    entry: {
      x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      radius: getShipKind(kindId).radius, kind: 1, shipKind: kindId, shieldDown,
    } as unknown as SwarmRenderState,
    registeredAiId: null,
  };
}

describe('shield collider parity: fresh == regenerated == shipShieldColliderDesc', () => {
  beforeAll(async () => { await RAPIER.init(); });

  for (const kindId of DRONE_KINDS) {
    it(`server world: a ${kindId} drone`, async () => {
      const kind = getShipKind(kindId);
      const world = await PhysicsWorld.create();
      const id = serverSpawn(world, kindId);
      const fresh = bodyShape(world, id);
      world.setHullExposed(id, true, kind); // shield breaks
      world.setHullExposed(id, false, kind); // shield regenerates
      const regen = bodyShape(world, id);
      expectSame(fresh, descShape(kind));
      expectSame(regen, descShape(kind));
    });

    it(`client predWorld: a ${kindId} drone`, async () => {
      const kind = getShipKind(kindId);
      const world = await PhysicsWorld.create();
      const leaf = new DroneClientLeaf();
      leaf.spawnBody(clientCtx(world, kindId, false));
      leaf.onSync(clientCtx(world, kindId, false));
      const fresh = bodyShape(world, 'swarm-7');
      leaf.onSync(clientCtx(world, kindId, true));
      leaf.onSync(clientCtx(world, kindId, false));
      const regen = bodyShape(world, 'swarm-7');
      expectSame(fresh, descShape(kind));
      expectSame(regen, descShape(kind));
    });
  }

  it('the shield shape does not change a drone\'s mass (zero-density collider + pinned mass)', async () => {
    const world = await PhysicsWorld.create();
    const id = serverSpawn(world, 'fighter');
    const posted = world.getBodyMass(id);
    world.setHullExposed(id, true, getShipKind('fighter'));
    world.setHullExposed(id, false, getShipKind('fighter'));
    expect(world.getBodyMass(id)).toBeCloseTo(posted!, 6);
  });
});

describe('drawn shield bubble == shield collider radius', () => {
  beforeAll(async () => { await RAPIER.init(); });

  const ballKinds = SHIP_KINDS_LIST.filter((k) => k.sizeClass !== 'capital');

  it('shieldBubbleRadius is the shield ball radius for every non-capital kind', () => {
    for (const kind of ballKinds) {
      expect(shieldBubbleRadius(kind), kind.id).toBeCloseTo(descShape(kind).radius, 4);
    }
  });

  for (const kindId of ['fighter', 'interceptor', 'crossguard']) {
    it(`player ${kindId}: the drawn bubble is the spawnShip shield collider`, async () => {
      const world = await PhysicsWorld.create();
      world.spawnShip('p1', 0, 0, kindId as never);
      const mirror = { ships: new Map([['p1', { kind: kindId }]]) } as unknown as RenderMirror;
      expect(shieldBubbleRadiusForEntity('p1', mirror)).toBeCloseTo(bodyShape(world, 'p1').radius, 4);
    });

    it(`drone ${kindId}: the drawn bubble is the fresh drone shield collider`, async () => {
      const world = await PhysicsWorld.create();
      const id = serverSpawn(world, kindId);
      const mirror = {
        ships: new Map(),
        swarm: new Map([[7, { kind: 1, shipKind: kindId, radius: getShipKind(kindId).radius }]]),
      } as unknown as RenderMirror;
      expect(shieldBubbleRadiusForEntity('swarm-7', mirror)).toBeCloseTo(bodyShape(world, id).radius, 4);
    });
  }
});
