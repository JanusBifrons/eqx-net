/**
 * PARITY LOCK for the Generic Entity Pipeline B1 leaf classes.
 *
 * Each damageable leaf COMPOSES its `{ health, perHit, death }` strategy out of
 * the same `healthBindings` + side-effect seams the former
 * `DamageRouter.strategies` table held. This test drives each leaf through the
 * SAME monomorphic sequence B2's `applyInteraction` will use
 * (resetResult → health.applyLayered → [!applied ⇒ stop] → damage broadcast →
 * perHit → [destroyed ⇒ death]) and asserts the ordered observable effect is
 * BYTE-IDENTICAL to the matching `DamageRouter.dispatch.test.ts` golden-master
 * sequence. Proving parity at the leaf level BEFORE B2 re-routes DamageRouter
 * means the dispatch collapse starts from a known-good OOP path.
 *
 * The recorder mocks mirror the golden-master's verbatim so the two suites'
 * expected log strings line up character-for-character. A REAL ShieldHullRouter
 * supplies the layered-damage maths (shields pre-dropped so a single hit lands
 * hull, deterministically), and shares the recorder so any shield side-effect
 * would surface in-order.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { MapSchema } from '@colyseus/schema';
import { ShieldHullRouter } from '../../rooms/ShieldHullRouter.js';
import type { ShipState, WreckState } from '../../rooms/schema/SectorState.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { Bus } from '../../../core/events/Bus.js';
import {
  resetInteractionResult,
  type InteractionResultMut,
} from '../../../core/contracts/IDamageable.js';
import { DEFAULT_SHIP_KIND } from '../../../shared-types/shipKinds.js';
import { getDroneMaxHealth } from '../../rooms/droneKindHelpers.js';
import {
  createActiveShipEntity,
  createLingeringHullEntity,
  createWreckEntity,
  DroneEntity,
  AsteroidEntity,
  StructureEntity,
  ProjectileEntity,
  MissileEntity,
  type DamageableLeaf,
  type LeafDeps,
  type SwarmLeafTarget,
} from './index.js';

const TICK = 500;

/** Ordered, compact record of every observable side-effect (mirrors the
 *  golden-master's recorder format verbatim). */
let log: string[];

function pose(x = 1, y = 2): ShipPhysicsState {
  return { x, y, vx: 0, vy: 0, angle: 0, angvel: 0 } as unknown as ShipPhysicsState;
}

function shipStub(over: Partial<ShipState> = {}): ShipState {
  return {
    playerId: 'p1',
    shipInstanceId: 'p1',
    kind: DEFAULT_SHIP_KIND,
    health: 80,
    maxHealth: 80,
    shield: 0, // shield down so a single hit lands hull (deterministic)
    shieldLastDamageTick: 0,
    isActive: true,
    alive: true,
    displayName: '',
    ...over,
  } as unknown as ShipState;
}

interface Harness {
  shieldHull: ShieldHullRouter;
  deps: LeafDeps;
  shipsMap: Map<string, ShipState>;
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  wreckPoseCache: Map<string, ShipPhysicsState>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  freeSlots: number[];
  swarm: Map<string, SwarmLeafTarget>;
  sabF32: Float32Array;
}

function makeHarness(): Harness {
  const shipsMap = new Map<string, ShipState>();
  const lingeringSlots = new Map<string, number>();
  const lingeringPoseCache = new Map<string, ShipPhysicsState>();
  const wreckPoseCache = new Map<string, ShipPhysicsState>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const freeSlots: number[] = [];
  const swarm = new Map<string, SwarmLeafTarget>();
  const sabF32 = new Float32Array(4096);

  const bus = {
    emit: (type: string, payload: { targetId?: string; entityId?: string; newHealth?: number }) =>
      log.push(
        `bus:${type}:${payload.targetId ?? payload.entityId ?? ''}${
          payload.newHealth !== undefined ? `:hp=${payload.newHealth}` : ''
        }`,
      ),
  } as unknown as Bus;

  const serverLogEvent = (tag: string, data: Record<string, unknown>) =>
    log.push(`diag:${tag}:${String(data.targetId ?? data.wireTargetId ?? data.entityId ?? '')}`);
  const postToWorker = (cmd: { type: string; id?: string; playerId?: string; slot?: number; exposed?: boolean }) =>
    log.push(
      `worker:${cmd.type}:${cmd.id ?? cmd.playerId ?? ''}${cmd.slot !== undefined ? `:slot=${cmd.slot}` : ''}${
        cmd.exposed !== undefined ? `:exposed=${cmd.exposed}` : ''
      }`,
    );

  const shieldHull = new ShieldHullRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    bus,
    serverLogEvent,
    postToWorker,
    broadcast: (type, msg) => log.push(`broadcast:${type}:${(msg as { targetId?: string }).targetId ?? ''}`),
  });

  const deps: LeafDeps = {
    bus,
    broadcastDestroy: (msg) => log.push(`destroy:${msg.targetId}:shooter=${msg.shooterId}`),
    destroyWreck: (id) => log.push(`destroyWreck:${id}`),
    logger: { info: () => {} } as never,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    lingeringSlots,
    lingeringPoseCache,
    freeSlots,
    postToWorker,
    evictSwarmEntity: (rec, opts) =>
      log.push(`evictSwarm:${rec.id}:broadcast=${opts.broadcast}:emitDestroyed=${opts.emitDestroyed}`),
    aiController: { markHostile: (droneId, playerId) => log.push(`markHostile:${droneId}<-${playerId}`) },
    serverLogEvent,
  };

  return { shieldHull, deps, shipsMap, lingeringSlots, lingeringPoseCache, wreckPoseCache, shipPoseCache, freeSlots, swarm, sabF32 };
}

/** Stand-in for B2's monomorphic `applyInteraction` — the exact sequence the
 *  re-routed DamageRouter will run, reading the leaf's composed data. */
const out: InteractionResultMut = {
  applied: false, newHealth: 0, newShield: 0, shieldMax: 0, hullMax: 0, hitLayer: 'hull', destroyed: false,
};
function runLeaf(
  leaf: DamageableLeaf,
  target: unknown,
  targetId: string,
  wireTargetId: string,
  shooterId: string,
  damage: number,
): void {
  leaf.target = target;
  resetInteractionResult(out);
  leaf.health.applyLayered(target, damage, TICK, out);
  if (!out.applied) return;
  log.push(`damage:${wireTargetId}:hp=${out.newHealth}:layer=${out.hitLayer}:shooter=${shooterId}`);
  leaf.perHit?.onApplied(target, targetId, wireTargetId, shooterId, damage, out, TICK);
  if (out.destroyed) {
    leaf.death.onDestroyed(target, targetId, wireTargetId, shooterId, TICK);
  }
}

beforeEach(() => {
  log = [];
});

describe('GEP B1 leaf parity — composed strategy == old DamageRouter branch (byte-identical)', () => {
  it('WreckEntity: overkill → damage + destroy + bus + destroyWreck', () => {
    const h = makeHarness();
    const leaf = createWreckEntity(h.deps, h.wreckPoseCache);
    const wreck = { shipInstanceId: 'w1', health: 10, maxHealth: 50 } as unknown as WreckState;
    runLeaf(leaf, wreck, 'wreck-w1', 'wreck-w1', 'shooterA', 30);
    expect(log).toEqual([
      'damage:wreck-w1:hp=0:layer=hull:shooter=shooterA',
      'destroy:wreck-w1:shooter=shooterA',
      'bus:SHIP_DESTROYED:wreck-w1',
      'destroyWreck:w1',
    ]);
  });

  it('WreckEntity: non-fatal hit emits only a damage broadcast', () => {
    const h = makeHarness();
    const leaf = createWreckEntity(h.deps, h.wreckPoseCache);
    const wreck = { shipInstanceId: 'w1', health: 50, maxHealth: 50 } as unknown as WreckState;
    runLeaf(leaf, wreck, 'wreck-w1', 'wreck-w1', 'shooterA', 20);
    expect(log).toEqual(['damage:wreck-w1:hp=30:layer=hull:shooter=shooterA']);
  });

  it('ShipEntity (lingering): overkill frees slot + DESPAWN linger-<id> + schema delete', () => {
    const h = makeHarness();
    const leaf = createLingeringHullEntity(h.shieldHull, h.deps, h.lingeringPoseCache);
    const ship = shipStub({ playerId: 'owner', shipInstanceId: 'lng1', isActive: false, health: 40 });
    h.shipsMap.set('lng1', ship);
    h.lingeringSlots.set('lng1', 7);
    h.lingeringPoseCache.set('lng1', pose());
    runLeaf(leaf, ship, 'lng1', 'lng1', 'shooterB', 9999);
    expect(log).toEqual([
      'damage:lng1:hp=0:layer=hull:shooter=shooterB',
      'destroy:lng1:shooter=shooterB',
      'worker:DESPAWN:linger-lng1:slot=7',
      'bus:SHIP_DESTROYED:lng1',
    ]);
    expect(h.lingeringSlots.has('lng1')).toBe(false);
    expect(h.lingeringPoseCache.has('lng1')).toBe(false);
    expect(h.freeSlots).toEqual([7]);
    expect(h.shipsMap.has('lng1')).toBe(false);
    expect(ship.alive).toBe(false);
  });

  it('ShipEntity (active): non-fatal → damage + PLAYER_DAMAGED', () => {
    const h = makeHarness();
    const leaf = createActiveShipEntity(h.shieldHull, h.deps, h.shipPoseCache);
    const ship = shipStub({ playerId: 'p1', shipInstanceId: 'p1', health: 80 });
    runLeaf(leaf, ship, 'p1', 'p1', 'shooterC', 25);
    expect(log).toEqual([
      'damage:p1:hp=55:layer=hull:shooter=shooterC',
      'bus:PLAYER_DAMAGED:p1:hp=55',
    ]);
  });

  it('ShipEntity (active): fatal → destroy + SHIP_DESTROYED after PLAYER_DAMAGED', () => {
    const h = makeHarness();
    const leaf = createActiveShipEntity(h.shieldHull, h.deps, h.shipPoseCache);
    const ship = shipStub({ playerId: 'p1', shipInstanceId: 'p1', health: 20 });
    runLeaf(leaf, ship, 'p1', 'p1', 'shooterC', 9999);
    expect(log).toEqual([
      'damage:p1:hp=0:layer=hull:shooter=shooterC',
      'bus:PLAYER_DAMAGED:p1:hp=0',
      'destroy:p1:shooter=shooterC',
      'bus:SHIP_DESTROYED:p1',
    ]);
    expect(ship.alive).toBe(false);
  });

  it('DroneEntity: non-fatal → damage (wire id) + diag + markHostile', () => {
    const h = makeHarness();
    const leaf = new DroneEntity(h.shieldHull, h.deps, h.sabF32);
    const rec: SwarmLeafTarget = { id: 'swarm-9', slot: 1, entityId: 9, kind: 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: true };
    h.swarm.set('swarm-9', rec);
    const maxHp = getDroneMaxHealth(DEFAULT_SHIP_KIND) ?? 40;
    h.shieldHull.swarmHealth.set('swarm-9', maxHp);
    h.shieldHull.swarmShield.set('swarm-9', 0);
    runLeaf(leaf, rec, 'swarm-9', 'swarm-9', 'shooterD', 5);
    expect(log).toEqual([
      `damage:swarm-9:hp=${maxHp - 5}:layer=hull:shooter=shooterD`,
      'diag:damage_applied:swarm-9',
      'markHostile:swarm-9<-shooterD',
    ]);
  });

  it('DroneEntity: fatal hit appends evictSwarmEntity', () => {
    const h = makeHarness();
    const leaf = new DroneEntity(h.shieldHull, h.deps, h.sabF32);
    const rec: SwarmLeafTarget = { id: 'swarm-9', slot: 1, entityId: 9, kind: 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: true };
    h.swarm.set('swarm-9', rec);
    h.shieldHull.swarmHealth.set('swarm-9', 5);
    h.shieldHull.swarmShield.set('swarm-9', 0);
    runLeaf(leaf, rec, 'swarm-9', 'swarm-9', 'shooterD', 9999);
    expect(log).toEqual([
      'damage:swarm-9:hp=0:layer=hull:shooter=shooterD',
      'diag:damage_applied:swarm-9',
      'markHostile:swarm-9<-shooterD',
      'evictSwarm:swarm-9:broadcast=true:emitDestroyed=true',
    ]);
  });

  // AsteroidEntity is NON-damageable (no HealthBinding): the resolver returns
  // null for kind 0, so an asteroid hit produces no event. That immunity is a
  // resolver-level concern (locked by the dispatch golden-master branch 5 once
  // B2 re-routes) — there is nothing to run through `applyInteraction` here.

  it('StructureEntity: damageable like a drone (swarm strategy), evict on death', () => {
    const h = makeHarness();
    const leaf = new StructureEntity(h.shieldHull, h.deps, h.sabF32);
    const rec: SwarmLeafTarget = { id: 'swarm-7', slot: 3, entityId: 7, kind: 2, shipKind: null };
    h.swarm.set('swarm-7', rec);
    h.shieldHull.swarmHealth.set('swarm-7', 5);
    h.shieldHull.swarmShield.set('swarm-7', 0);
    runLeaf(leaf, rec, 'swarm-7', 'swarm-7', 'shooterF', 9999);
    expect(log).toEqual([
      'damage:swarm-7:hp=0:layer=hull:shooter=shooterF',
      'diag:damage_applied:swarm-7',
      'markHostile:swarm-7<-shooterF',
      'evictSwarm:swarm-7:broadcast=true:emitDestroyed=true',
    ]);
  });
});

describe('GEP B1 leaf identity / pose / descriptors', () => {
  it('damageable leaves report their entityKind + registry descriptors', () => {
    const h = makeHarness();
    const active = createActiveShipEntity(h.shieldHull, h.deps, h.shipPoseCache);
    expect(active.entityKind).toBe('active-ship');
    expect(active.syncProfile().transport).toBe('json-slice');
    expect(active.renderContribution().bucket).toBe('ships');

    const drone = new DroneEntity(h.shieldHull, h.deps, h.sabF32);
    expect(drone.entityKind).toBe('drone');
    expect(drone.syncProfile()).toEqual({ transport: 'pose-core', poseCoreKind: 1, interpolated: true });

    const asteroid = new AsteroidEntity(h.sabF32);
    expect(asteroid.syncProfile().poseCoreKind).toBe(0);
    expect('health' in asteroid).toBe(false); // non-damageable (no HealthBinding)

    const structure = new StructureEntity(h.shieldHull, h.deps, h.sabF32);
    expect(structure.syncProfile().poseCoreKind).toBe(2);
    expect(structure.renderContribution().bucket).toBe('swarm');
  });

  it('ShipEntity active vs lingering derive distinct ids from the same store', () => {
    const h = makeHarness();
    const active = createActiveShipEntity(h.shieldHull, h.deps, h.shipPoseCache);
    const lingering = createLingeringHullEntity(h.shieldHull, h.deps, h.lingeringPoseCache);
    const ship = shipStub({ playerId: 'pid', shipInstanceId: 'sid' });
    active.target = ship;
    lingering.target = ship;
    expect(active.entityId).toBe('pid');
    expect(lingering.entityId).toBe('sid');
  });

  it('swarm leaf reads pose from the SAB slot; wire id is swarm-<entityId>', () => {
    const h = makeHarness();
    const drone = new DroneEntity(h.shieldHull, h.deps, h.sabF32);
    const rec: SwarmLeafTarget = { id: 'drone-x', slot: 4, entityId: 42, kind: 1 };
    drone.target = rec;
    // Write a known pose into slot 4.
    const base = 5 + 4 * 9; // HEADER_WORDS + slot*SLOT_WORDS
    h.sabF32[base + 1] = 100; // x
    h.sabF32[base + 2] = 200; // y
    h.sabF32[base + 5] = 1.5; // angle
    const p = drone.pose({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 });
    expect(p.x).toBe(100);
    expect(p.y).toBe(200);
    expect(p.angle).toBe(1.5);
    expect(drone.entityId).toBe('swarm-42');
  });

  it('non-damageable leaves (projectile / missile) carry identity + pose only', () => {
    const proj = new ProjectileEntity();
    proj.target = { id: 'p-7', x: 10, y: 20, vx: 1, vy: 2 };
    expect(proj.entityKind).toBe('projectile');
    expect(proj.entityId).toBe('p-7');
    expect(proj.pose({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 })).toMatchObject({ x: 10, y: 20, vx: 1, vy: 2, angle: 0 });
    expect(proj.syncProfile().jsonSliceTag).toBe('projectiles');

    const missile = new MissileEntity();
    missile.target = { id: 99, x: 5, y: 6, vx: 0, vy: 0, angle: 0.7 };
    expect(missile.entityKind).toBe('missile');
    expect(missile.entityId).toBe('99');
    expect(missile.pose({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }).angle).toBe(0.7);
    expect(missile.syncProfile().jsonSliceTag).toBe('missiles');
  });
});
