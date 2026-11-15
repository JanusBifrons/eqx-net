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
import { getWeapon, weaponLayerMul, type WeaponDef } from '../../core/combat/WeaponCatalogue.js';

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

// Per-target damage factors (plan partitioned-chasing-lark PR 1): the room
// resolves a weapon's `targetFactor` into a per-layer multiplier
// (`weaponLayerMul`) and hands it to the ONE router call. A mining-laser-like
// weapon {shield 0, hull 0.05} does nothing to a raised shield (no event, no
// regen-timer reset) and 5 % to an exposed hull.
describe('DamageRouter — per-target damage factors', () => {
  const MINER: WeaponDef = { ...getWeapon('laser'), targetFactor: { shield: 0, hull: 0.05 } };
  const mul = (): ReturnType<typeof weaponLayerMul> => weaponLayerMul(MINER, false, { shield: 1, hull: 1 });

  it('a {shield 0} weapon does 0 to a shielded ship: no state change, no event, regen timer kept', () => {
    const ship = addActiveShip({ shield: 30, health: 80, shieldLastDamageTick: 42 });
    const destroyed = h.router.apply('p1', 'shooter', 100, 1, 2, mul());
    expect(destroyed).toBe(false);
    expect(ship.shield).toBe(30);
    expect(ship.health).toBe(80);
    expect(ship.shieldLastDamageTick).toBe(42); // regen NOT reset
    expect(h.damageEvents).toHaveLength(0);
  });

  it('a {hull 0.05} weapon does 5 % to an unshielded hull, and the wire reports the scaled damage', () => {
    const ship = addActiveShip({ shield: 0, health: 80 });
    h.router.apply('p1', 'shooter', 100, 1, 2, mul());
    expect(ship.health).toBeCloseTo(75, 10);
    expect(ship.shieldLastDamageTick).toBe(TICK);
    expect(h.damageEvents).toHaveLength(1);
    expect(h.damageEvents[0]!.damage).toBe(5);
  });

  it('a weapon without factors is untouched (weaponLayerMul is undefined)', () => {
    const ship = addActiveShip({ shield: 0, health: 80 });
    h.router.apply('p1', 'shooter', 10, 1, 2, weaponLayerMul(getWeapon('laser'), false, { shield: 1, hull: 1 }));
    expect(ship.health).toBe(70);
    expect(h.damageEvents[0]!.damage).toBe(10);
  });
});

// Mining laser (plan partitioned-chasing-lark PR 7): `effectiveDamage` reads
// the factored damage BEFORE the hit lands, for the room's side effects
// (standing / hostility / `noteHit`): a hit it zeroes is not an attack.
describe('DamageRouter.effectiveDamage — the mining laser', () => {
  const laser = getWeapon('mining_laser');
  const mul = (): ReturnType<typeof weaponLayerMul> => weaponLayerMul(laser, false, { shield: 1, hull: 1 });

  it('a raised shield: 0 effective, and the hit changes nothing', () => {
    const ship = addActiveShip({ shield: 30, health: 80 });
    expect(h.router.effectiveDamage('p1', 120, mul())).toBe(0);
    h.router.apply('p1', 'shooter', 120, 1, 2, mul());
    expect(ship.shield).toBe(30);
    expect(ship.health).toBe(80);
    expect(h.damageEvents).toHaveLength(0);
  });

  it('an exposed hull: 5 %, and the hit does exactly that', () => {
    const ship = addActiveShip({ shield: 0, health: 80 });
    expect(h.router.effectiveDamage('p1', 120, mul())).toBeCloseTo(6, 10);
    h.router.apply('p1', 'shooter', 120, 1, 2, mul());
    expect(ship.health).toBeCloseTo(74, 10);
  });

  it('a lingering hull reads its own shield; no factor or an unknown target passes through', () => {
    h.shipsMap.set('linger-1', shipStub({ playerId: 'p9', shipInstanceId: 'linger-1', isActive: false, shield: 10 }));
    expect(h.router.effectiveDamage('linger-1', 120, mul())).toBe(0);
    expect(h.router.effectiveDamage('p1', 120, undefined)).toBe(120);
    expect(h.router.effectiveDamage('nobody', 120, mul())).toBeCloseTo(6, 10);
  });

  it('a shielded drone (no shield entry yet = full) takes 0', () => {
    h.swarm.set('d1', { id: 'd1', entityId: 7, slot: 0, kind: 1, shipKind: 'fighter' } as unknown as SwarmDmgRecord);
    expect(h.router.effectiveDamage('d1', 120, mul())).toBe(0);
  });
});
