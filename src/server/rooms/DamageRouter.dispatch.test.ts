/**
 * GOLDEN-MASTER for DamageRouter.apply — the Phase-2 regression lock for the
 * Generic Entity Pipeline dispatch collapse (HC#1).
 *
 * DamageRouter.apply is a 4-branch if-tree keyed on target-id SHAPE
 * (wreck- prefix / lingering `!isActive` / active playerId / swarm registry),
 * and the branch ORDER + each branch's side-effects are LOAD-BEARING and
 * asymmetric (broadcast, bus PLAYER_DAMAGED / SHIP_DESTROYED, worker DESPAWN
 * `linger-<id>`, slot free-list push, evictSwarmEntity, destroyWreck, the
 * swarm-only `damage_applied` diag + markHostile).
 *
 * This test records the FULL ordered observable effect of `apply()` for each
 * target kind, against the UNMODIFIED if-tree. Phase 2 then routes apply()
 * through an EntityResolver + the monomorphic DamageableEntity; the recorded
 * sequences MUST stay byte-identical (the collapse is behaviour-preserving).
 * Written BEFORE the collapse (test-first, invariant #13) — it is GREEN on the
 * current code and becomes the lock that re-fails if the collapse drifts.
 *
 * Hand-rolled mocks (the repo's endorsed pattern for orchestrator-shaped logic
 * over state — see src/server/CLAUDE.md "Testing patterns"). A REAL
 * ShieldHullRouter provides the layered-damage maths; its own side-effects
 * (SHIELD_BROKEN / SET_HULL_EXPOSED) share the same recorder so the full
 * ordered flow is captured. Structural stubs avoid instantiating
 * @colyseus/schema classes (their v3 decorators need a runtime the unit env
 * lacks).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { MapSchema } from '@colyseus/schema';
import { DamageRouter, type SwarmDmgRecord } from './DamageRouter.js';
import { ShieldHullRouter } from './ShieldHullRouter.js';
import type { ShipState, WreckState } from './schema/SectorState.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import { getDroneMaxHealth } from './droneKindHelpers.js';
import type { Bus } from '../../core/events/Bus.js';

const TICK = 500;

/** Ordered, compact record of every observable side-effect of apply(). */
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
    shield: 0, // shield down so a single hit lands on the hull (deterministic)
    shieldLastDamageTick: 0,
    isActive: true,
    alive: true,
    displayName: '',
    ...over,
  } as unknown as ShipState;
}

interface Harness {
  router: DamageRouter;
  shipsMap: Map<string, ShipState>;
  wrecksMap: Map<string, WreckState>;
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  wreckPoseCache: Map<string, ShipPhysicsState>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  freeSlots: number[];
  swarm: Map<string, SwarmDmgRecord>;
  shieldHull: ShieldHullRouter;
  activeShips: Map<string, ShipState>;
}

function makeHarness(): Harness {
  const shipsMap = new Map<string, ShipState>();
  const wrecksMap = new Map<string, WreckState>();
  const lingeringSlots = new Map<string, number>();
  const lingeringPoseCache = new Map<string, ShipPhysicsState>();
  const wreckPoseCache = new Map<string, ShipPhysicsState>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const freeSlots: number[] = [];
  const swarm = new Map<string, SwarmDmgRecord>();
  const activeShips = new Map<string, ShipState>();

  // Shared recorder bus — captures DamageRouter AND ShieldHullRouter bus emits.
  const bus = {
    emit: (type: string, payload: { targetId?: string; entityId?: string; newHealth?: number }) =>
      log.push(`bus:${type}:${payload.targetId ?? payload.entityId ?? ''}${payload.newHealth !== undefined ? `:hp=${payload.newHealth}` : ''}`),
  } as unknown as Bus;

  const serverLogEvent = (tag: string, data: Record<string, unknown>) =>
    log.push(`diag:${tag}:${String(data.targetId ?? data.wireTargetId ?? data.entityId ?? '')}`);
  const postToWorker = (cmd: { type: string; id?: string; playerId?: string; slot?: number; exposed?: boolean }) =>
    log.push(`worker:${cmd.type}:${cmd.id ?? cmd.playerId ?? ''}${cmd.slot !== undefined ? `:slot=${cmd.slot}` : ''}${cmd.exposed !== undefined ? `:exposed=${cmd.exposed}` : ''}`);

  const shieldHull = new ShieldHullRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    bus,
    serverLogEvent,
    postToWorker,
    broadcast: (type, msg) => log.push(`broadcast:${type}:${(msg as { targetId?: string }).targetId ?? ''}`),
  });

  const router = new DamageRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    wrecksMap: wrecksMap as unknown as MapSchema<WreckState>,
    shipPoseCache,
    lingeringSlots,
    lingeringPoseCache,
    wreckPoseCache,
    destroyWreck: (id) => log.push(`destroyWreck:${id}`),
    freeSlots,
    shieldHullRouter: shieldHull,
    getActiveShip: (pid) => activeShips.get(pid),
    sabF32: new Float32Array(4096),
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    evictSwarmEntity: (rec, opts) =>
      log.push(`evictSwarm:${rec.id}:broadcast=${opts.broadcast}:emitDestroyed=${opts.emitDestroyed}`),
    aiController: { markHostile: (droneId, playerId) => log.push(`markHostile:${droneId}<-${playerId}`) },
    bus,
    broadcastDamage: (msg) => log.push(`damage:${msg.targetId}:hp=${msg.newHealth}:layer=${msg.hitLayer}:shooter=${msg.shooterId}`),
    broadcastDestroy: (msg) => log.push(`destroy:${msg.targetId}:shooter=${msg.shooterId}`),
    postToWorker,
    logger: { info: () => {} } as never,
    serverLogEvent,
  });

  return { router, shipsMap, wrecksMap, lingeringSlots, lingeringPoseCache, wreckPoseCache, shipPoseCache, freeSlots, swarm, shieldHull, activeShips };
}

beforeEach(() => {
  log = [];
});

describe('DamageRouter.apply — golden-master dispatch (HC#1 load-bearing branches)', () => {
  it('branch 1 — wreck: overkill destroys (damage → destroy → bus → destroyWreck)', () => {
    const h = makeHarness();
    h.wrecksMap.set('w1', { shipInstanceId: 'w1', health: 10, maxHealth: 50 } as unknown as WreckState);
    h.wreckPoseCache.set('w1', pose());
    h.router.apply('wreck-w1', 'shooterA', 30, undefined, undefined);
    expect(log).toEqual([
      'damage:wreck-w1:hp=0:layer=hull:shooter=shooterA',
      'destroy:wreck-w1:shooter=shooterA',
      'bus:SHIP_DESTROYED:wreck-w1',
      'destroyWreck:w1',
    ]);
  });

  it('branch 1 — wreck: non-fatal hit emits only a damage broadcast', () => {
    const h = makeHarness();
    h.wrecksMap.set('w1', { shipInstanceId: 'w1', health: 50, maxHealth: 50 } as unknown as WreckState);
    h.wreckPoseCache.set('w1', pose());
    h.router.apply('wreck-w1', 'shooterA', 20, undefined, undefined);
    expect(log).toEqual(['damage:wreck-w1:hp=30:layer=hull:shooter=shooterA']);
  });

  it('branch 1 — unknown wreck id is a silent no-op', () => {
    const h = makeHarness();
    h.router.apply('wreck-nope', 'shooterA', 20, undefined, undefined);
    expect(log).toEqual([]);
  });

  it('branch 2 — lingering hull: overkill frees slot + DESPAWN linger-<id> + schema delete', () => {
    const h = makeHarness();
    h.shipsMap.set('lng1', shipStub({ playerId: 'owner', shipInstanceId: 'lng1', isActive: false, health: 40 }));
    h.lingeringSlots.set('lng1', 7);
    h.lingeringPoseCache.set('lng1', pose());
    h.router.apply('lng1', 'shooterB', 9999, undefined, undefined);
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
  });

  it('branch 2 — lingering hull: already-dead is a silent no-op', () => {
    const h = makeHarness();
    h.shipsMap.set('lng1', shipStub({ shipInstanceId: 'lng1', isActive: false, alive: false }));
    h.router.apply('lng1', 'shooterB', 10, undefined, undefined);
    expect(log).toEqual([]);
  });

  it('branch 3 — active ship: non-fatal hit emits damage + PLAYER_DAMAGED', () => {
    const h = makeHarness();
    const ship = shipStub({ playerId: 'p1', shipInstanceId: 'p1', health: 80 });
    h.activeShips.set('p1', ship);
    h.shipPoseCache.set('p1', pose());
    h.router.apply('p1', 'shooterC', 25, undefined, undefined);
    expect(log).toEqual([
      'damage:p1:hp=55:layer=hull:shooter=shooterC',
      'bus:PLAYER_DAMAGED:p1:hp=55',
    ]);
  });

  it('branch 3 — active ship: fatal hit adds destroy + SHIP_DESTROYED after PLAYER_DAMAGED', () => {
    const h = makeHarness();
    const ship = shipStub({ playerId: 'p1', shipInstanceId: 'p1', health: 20 });
    h.activeShips.set('p1', ship);
    h.shipPoseCache.set('p1', pose());
    h.router.apply('p1', 'shooterC', 9999, undefined, undefined);
    expect(log).toEqual([
      'damage:p1:hp=0:layer=hull:shooter=shooterC',
      'bus:PLAYER_DAMAGED:p1:hp=0',
      'destroy:p1:shooter=shooterC',
      'bus:SHIP_DESTROYED:p1',
    ]);
    expect(ship.alive).toBe(false);
  });

  it('branch 3 — active ship not yet handshake-active is dropped with a diag', () => {
    const h = makeHarness();
    h.activeShips.set('p1', shipStub({ playerId: 'p1', isActive: false, alive: true }));
    h.router.apply('p1', 'shooterC', 25, undefined, undefined);
    expect(log).toEqual(['diag:damage_skipped_pending_join:p1']);
  });

  it('branch 4 — drone: non-fatal hit emits damage (wire id) + diag + markHostile', () => {
    const h = makeHarness();
    const rec: SwarmDmgRecord = { id: 'swarm-9', slot: 1, entityId: 9, kind: 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: true };
    h.swarm.set('swarm-9', rec);
    const maxHp = getDroneMaxHealth(DEFAULT_SHIP_KIND) ?? 40;
    h.shieldHull.swarmHealth.set('swarm-9', maxHp);
    h.shieldHull.swarmShield.set('swarm-9', 0); // shield already down → hull hit
    h.router.apply('swarm-9', 'shooterD', 5, 3, 4);
    expect(log).toEqual([
      `damage:swarm-9:hp=${maxHp - 5}:layer=hull:shooter=shooterD`,
      'diag:damage_applied:swarm-9',
      'markHostile:swarm-9<-shooterD',
    ]);
  });

  it('branch 4 — drone: fatal hit appends evictSwarmEntity', () => {
    const h = makeHarness();
    const rec: SwarmDmgRecord = { id: 'swarm-9', slot: 1, entityId: 9, kind: 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: true };
    h.swarm.set('swarm-9', rec);
    h.shieldHull.swarmHealth.set('swarm-9', 5);
    h.shieldHull.swarmShield.set('swarm-9', 0);
    h.router.apply('swarm-9', 'shooterD', 9999, undefined, undefined);
    expect(log).toEqual([
      'damage:swarm-9:hp=0:layer=hull:shooter=shooterD',
      'diag:damage_applied:swarm-9',
      'markHostile:swarm-9<-shooterD',
      'evictSwarm:swarm-9:broadcast=true:emitDestroyed=true',
    ]);
  });

  it('branch 4 — structure (kind 2): damage + diag but NO markHostile (no AI brain)', () => {
    // Wave-system Phase 0.5 leak-fix lock: a structure shares the swarm damage
    // strategy but is NOT registered with the AiController, so marking it
    // hostile would buffer a `pendingHostile` entry that never drains. The
    // kind-1 gate suppresses markHostile for structures (and asteroids); the
    // hit + diag still fire. Reverting the gate re-introduces the leak and
    // adds a `markHostile:swarm-7<-shooterS` line here.
    const h = makeHarness();
    const rec: SwarmDmgRecord = { id: 'swarm-7', slot: 3, entityId: 7, kind: 2, shipKind: null };
    h.swarm.set('swarm-7', rec);
    h.shieldHull.swarmHealth.set('swarm-7', 300);
    h.shieldHull.swarmShield.set('swarm-7', 0);
    h.router.apply('swarm-7', 'shooterS', 5, 1, 2);
    expect(log).toEqual([
      'damage:swarm-7:hp=295:layer=hull:shooter=shooterS',
      'diag:damage_applied:swarm-7',
    ]);
    expect(log.some((l) => l.startsWith('markHostile:'))).toBe(false);
  });

  it('branch 5 — asteroid (no swarmHealth entry): immune, silent no-op', () => {
    const h = makeHarness();
    h.swarm.set('swarm-2', { id: 'swarm-2', slot: 2, entityId: 2, kind: 0, shipKind: null });
    h.router.apply('swarm-2', 'shooterE', 50, undefined, undefined);
    expect(log).toEqual([]);
  });

  it('branch 4 — unknown swarm id is a silent no-op', () => {
    const h = makeHarness();
    h.router.apply('swarm-404', 'shooterE', 50, undefined, undefined);
    expect(log).toEqual([]);
  });
});
