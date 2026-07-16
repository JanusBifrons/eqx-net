/**
 * Campaign PR 1.2 (anti-patterns review 2026-07, A10 / Part D #3) — the
 * SERVER half of the 0-damage guard.
 *
 * The RAM path rounds-before-emit (P3.3), but that guard landed on one path
 * only (invariant #15): missile splash (`damage × falloff`) and mining chip
 * damage reach `DamageRouter.applyInteraction` FRACTIONAL, so the wire could
 * carry `damage: 0.4` — which the client rounds to a "0" floating number
 * with sparks (the playtest "it just now shows 0s" report).
 *
 * Contract locked here (failing-first, invariant #13), at the SINGLE wire
 * emit site (`applyInteraction`):
 *  - the wire `damage` is an INTEGER (Math.round of the applied damage);
 *  - an event whose rounded damage is 0 is NOT broadcast — unless it carries
 *    a state edge the client needs: a shield 0-cross (the collider swap keys
 *    off `newShield === 0`) or a destruction;
 *  - internal application is untouched: fractional chips still subtract HP
 *    server-side (mining DPS keeps working), only the broadcast is gated.
 *
 * Harness: trimmed clone of the DamageRouter.dispatch.test.ts hand-rolled
 * mock pattern, capturing full DamageEvents (the golden-master's recorder
 * only logs a string digest without the damage field).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { MapSchema } from '@colyseus/schema';
import { DamageRouter, type SwarmDmgRecord } from './DamageRouter.js';
import { ShieldHullRouter } from './ShieldHullRouter.js';
import type { ShipState } from './schema/SectorState.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import type { DamageEvent } from '../../shared-types/messages.js';
import type { Bus } from '../../core/events/Bus.js';

const TICK = 500;

function shipStub(over: Partial<ShipState> = {}): ShipState {
  return {
    playerId: 'p1',
    shipInstanceId: 'p1',
    kind: DEFAULT_SHIP_KIND,
    health: 80,
    maxHealth: 80,
    shield: 0,
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
  activeShips: Map<string, ShipState>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  swarm: Map<string, SwarmDmgRecord>;
  damageEvents: DamageEvent[];
}

function makeHarness(): Harness {
  const shipsMap = new Map<string, ShipState>();
  const activeShips = new Map<string, ShipState>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const swarm = new Map<string, SwarmDmgRecord>();
  const damageEvents: DamageEvent[] = [];
  const noop = (): void => {};
  const bus = { emit: noop } as unknown as Bus;

  const shieldHull = new ShieldHullRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    bus,
    serverLogEvent: noop,
    postToWorker: noop,
    broadcast: noop,
  });

  const router = new DamageRouter({
    serverTick: () => TICK,
    shipsMap: shipsMap as unknown as MapSchema<ShipState>,
    shipPoseCache,
    lingeringSlots: new Map(),
    lingeringPoseCache: new Map(),
    freeSlots: [],
    shieldHullRouter: shieldHull,
    getActiveShip: (pid) => activeShips.get(pid),
    sabF32: new Float32Array(4096),
    swarmRegistry: { get: (id) => swarm.get(id) ?? null },
    evictSwarmEntity: noop,
    aiController: { markHostile: noop },
    bus,
    broadcastDamage: (msg) => damageEvents.push(msg),
    broadcastDestroy: noop,
    postToWorker: noop,
    logger: { info: noop } as never,
    serverLogEvent: noop,
  });

  return { router, shipsMap, activeShips, shipPoseCache, swarm, damageEvents };
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});

function addActiveShip(over: Partial<ShipState> = {}): ShipState {
  const ship = shipStub(over);
  h.shipsMap.set('p1', ship);
  h.activeShips.set('p1', ship);
  h.shipPoseCache.set('p1', { x: 1, y: 2, vx: 0, vy: 0, angle: 0, angvel: 0 } as unknown as ShipPhysicsState);
  return ship;
}

describe('DamageRouter — 0-damage wire guard (campaign 1.2)', () => {
  it('a fractional sub-0.5 hull hit applies HP internally but broadcasts NO damage event', () => {
    const ship = addActiveShip({ shield: 0, health: 80 });
    h.router.apply('p1', 'shooter', 0.4, 1, 2);
    expect(ship.health).toBeCloseTo(79.6, 5); // internal application untouched
    expect(h.damageEvents).toHaveLength(0); // wire stays silent
  });

  it('a fractional hit that BREAKS the shield still broadcasts (collider-swap state edge), with integer damage', () => {
    addActiveShip({ shield: 0.2, health: 80 });
    h.router.apply('p1', 'shooter', 0.4, 1, 2);
    expect(h.damageEvents).toHaveLength(1);
    const evt = h.damageEvents[0]!;
    expect(evt.newShield).toBe(0);
    expect(evt.hitLayer).toBe('shield');
    expect(Number.isInteger(evt.damage)).toBe(true);
  });

  it('a destroying fractional hit still broadcasts', () => {
    addActiveShip({ shield: 0, health: 0.3 });
    h.router.apply('p1', 'shooter', 0.4, 1, 2);
    expect(h.damageEvents).toHaveLength(1);
  });

  it('the wire damage is rounded to an integer for normal hits', () => {
    addActiveShip({ shield: 0, health: 80 });
    h.router.apply('p1', 'shooter', 2.6, 1, 2);
    expect(h.damageEvents).toHaveLength(1);
    expect(h.damageEvents[0]!.damage).toBe(3);
  });
});
