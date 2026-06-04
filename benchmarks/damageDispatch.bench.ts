/**
 * Generic Entity Pipeline B2 perf lock — damage dispatch under mixed-kind load.
 *
 * Run: pnpm bench
 *
 * HC#5 (megamorphism guard) made observable. `DamageRouter.apply` resolves a
 * `targetId` to one of N leaf classes and runs ONE monomorphic `applyInteraction`
 * over its composed `{ health, perHit, death }`. The risk the guard exists for:
 * if the per-hit work were a virtual `leaf.receiveInteraction()` dispatched
 * across the leaf classes, hitting MANY kinds in quick succession (exactly what
 * ramming + projectile sweeps do) would megamorphic-deopt in V8 and the
 * mixed-kind path would fall off a cliff vs a single-kind one.
 *
 * The benches make that profile visible:
 *   - `single-kind (active ship)` — the monomorphic baseline (one leaf class).
 *   - `mixed-kind (ship/drone/wreck)` — three leaf classes per iteration, the
 *     megamorphic-risk pattern. With the monomorphic call site this stays close
 *     to the baseline; a regression into virtual dispatch would show a cliff.
 *
 * Targets are seeded with huge HP + damage 1 so nothing dies/evicts across a
 * bench window (repeatable, no store churn). All side-effect seams are no-ops.
 */

import { bench, describe } from 'vitest';
import type { MapSchema } from '@colyseus/schema';
import { DamageRouter, type SwarmDmgRecord } from '../src/server/rooms/DamageRouter.js';
import { ShieldHullRouter } from '../src/server/rooms/ShieldHullRouter.js';
import type { ShipState, WreckState } from '../src/server/rooms/schema/SectorState.js';
import type { ShipPhysicsState } from '../src/core/physics/World.js';
import type { Bus } from '../src/core/events/Bus.js';
import { DEFAULT_SHIP_KIND } from '../src/shared-types/shipKinds.js';

const TICK = 1000;
const HUGE = 1e12;

function pose(): ShipPhysicsState {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 } as unknown as ShipPhysicsState;
}

function makeRouter(): DamageRouter {
  const shipsMap = new Map<string, ShipState>();
  const wrecksMap = new Map<string, WreckState>();
  const swarm = new Map<string, SwarmDmgRecord>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const wreckPoseCache = new Map<string, ShipPhysicsState>();

  // Active ship.
  shipsMap.set('p1', {
    playerId: 'p1', shipInstanceId: 'p1', kind: DEFAULT_SHIP_KIND,
    health: HUGE, maxHealth: HUGE, shield: 0, shieldLastDamageTick: 0,
    isActive: true, alive: true, displayName: '',
  } as unknown as ShipState);
  shipPoseCache.set('p1', pose());

  // Wreck.
  wrecksMap.set('w1', { shipInstanceId: 'w1', health: HUGE, maxHealth: HUGE } as unknown as WreckState);
  wreckPoseCache.set('w1', pose());

  // Drone (kind 1).
  swarm.set('swarm-9', { id: 'swarm-9', slot: 1, entityId: 9, kind: 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: true });

  const noopBus = { emit: () => {} } as unknown as Bus;
  const noop = () => {};

  const shieldHull = new ShieldHullRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    bus: noopBus,
    serverLogEvent: noop,
    postToWorker: noop as never,
    broadcast: noop,
  });
  shieldHull.swarmHealth.set('swarm-9', HUGE);
  shieldHull.swarmShield.set('swarm-9', 0);

  return new DamageRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    wrecksMap: wrecksMap as unknown as MapSchema<WreckState>,
    shipPoseCache,
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    wreckPoseCache,
    destroyWreck: noop,
    freeSlots: [],
    shieldHullRouter: shieldHull,
    getActiveShip: (pid) => shipsMap.get(pid),
    sabF32: new Float32Array(4096),
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    evictSwarmEntity: noop,
    aiController: { markHostile: noop },
    bus: noopBus,
    broadcastDamage: noop,
    broadcastDestroy: noop,
    postToWorker: noop as never,
    logger: { info: noop } as never,
    serverLogEvent: noop,
  });
}

describe('damage dispatch (HC#5 monomorphism)', () => {
  const router = makeRouter();

  bench('single-kind apply (active ship — monomorphic baseline)', () => {
    router.apply('p1', 'shooter', 1, 0, 0);
  });

  bench('mixed-kind apply (ship / drone / wreck — ramming+projectile load)', () => {
    router.apply('p1', 'shooter', 1, 0, 0);
    router.apply('swarm-9', 'shooter', 1, 0, 0);
    router.apply('wreck-w1', 'shooter', 1, 0, 0);
  });
});
