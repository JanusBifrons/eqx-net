/**
 * Phase 1 lock (Generic Entity Pipeline): the server `HealthBinding` shims
 * are byte-identical to the existing layered-damage primitives, and the
 * concrete `DamageableEntity` composes binding + DeathPolicy with the
 * monomorphic call site.
 *
 * Why these assertions: Phase 2 routes DamageRouter through these bindings;
 * if a binding diverged from `damageShipLayered` / `damageSwarmLayered` /
 * the wreck branch math, the if-tree collapse would silently change damage
 * outcomes. HC#3: the drone binding must mutate the parallel `swarmHealth`
 * map (a reference), not a copied value — asserted by reading the router's
 * map after applying through the binding.
 */

import { describe, it, expect } from 'vitest';
import type { MapSchema } from '@colyseus/schema';
// Type-only: the real ShipState/WreckState are @colyseus/schema classes whose
// v3 decorators need a Symbol.metadata runtime the plain unit env lacks (they
// are only *instantiated* in the integration suite). The bindings touch only
// plain fields, so structural stubs cast to the schema types exercise the same
// code paths without loading the decorator module.
import type { ShipState, WreckState } from '../rooms/schema/SectorState.js';
import { ShieldHullRouter, type SwarmDamageTarget } from '../rooms/ShieldHullRouter.js';
import { getDroneMaxHealth } from '../rooms/droneKindHelpers.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import type { Bus } from '../../core/events/Bus.js';
import {
  DamageableEntity,
  resetInteractionResult,
  type DeathPolicy,
  type HealthBinding,
  type InteractionResultMut,
} from '../../core/contracts/IDamageable.js';
import { shipHealthBinding, wreckHealthBinding, swarmHealthBinding } from './healthBindings.js';

const TICK = 100;

function makeRouter(): ShieldHullRouter {
  return new ShieldHullRouter({
    serverTick: () => TICK,
    // A plain Map supports the `for (const [, ship] of shipsMap)` iteration in
    // tickShieldRegen (never called here); the layered-damage methods under
    // test do not touch shipsMap at all.
    shipsMap: new Map() as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: () => null },
    bus: { emit() {} } as unknown as Bus,
    serverLogEvent: () => {},
    postToWorker: () => {},
    broadcast: () => {},
  });
}

/** Structural ShipState stub — only the fields the layered-damage primitive
 *  reads/writes. Cast to ShipState; no @colyseus/schema instantiation. */
function makeShipStub(): ShipState {
  return {
    playerId: 'p1',
    shipInstanceId: 's1',
    kind: DEFAULT_SHIP_KIND,
    health: 80,
    maxHealth: 80,
    shield: 30,
    shieldLastDamageTick: 0,
    isActive: true,
    alive: true,
  } as unknown as ShipState;
}

function freshResult(): InteractionResultMut {
  return resetInteractionResult({
    applied: false,
    newHealth: 0,
    newShield: 0,
    shieldMax: 0,
    hullMax: 0,
    hitLayer: 'hull',
    destroyed: false,
  });
}

function makeDrone(id: string): SwarmDamageTarget {
  return { id, entityId: Number(id.replace(/\D/g, '')) || 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: false };
}

describe('healthBindings — parity with the existing primitives', () => {
  it('swarm binding (drone) is byte-identical to damageSwarmLayered + swarmHealth read', () => {
    const dmg = 9999; // big enough to punch through shield and kill in one hit
    const maxHp = getDroneMaxHealth(DEFAULT_SHIP_KIND) ?? 40;

    // Direct primitive path.
    const rDirect = makeRouter();
    const recDirect = makeDrone('swarm-1');
    rDirect.swarmHealth.set(recDirect.id, maxHp);
    const direct = rDirect.damageSwarmLayered(recDirect, dmg);
    const directHealth = rDirect.swarmHealth.get(recDirect.id) ?? 0;

    // Binding path (identical seed).
    const rBind = makeRouter();
    const recBind = makeDrone('swarm-1');
    rBind.swarmHealth.set(recBind.id, maxHp);
    const out = freshResult();
    swarmHealthBinding(recBind, rBind).applyLayered(dmg, TICK, out);

    expect(direct).not.toBeNull();
    expect(out.applied).toBe(true);
    expect(out.newHealth).toBe(directHealth);
    expect(out.newShield).toBe(direct!.newShield);
    expect(out.shieldMax).toBe(direct!.shieldMax);
    expect(out.hullMax).toBe(direct!.hullMax);
    expect(out.hitLayer).toBe(direct!.hitLayer);
    expect(out.destroyed).toBe(directHealth <= 0);
    // HC#3: the binding mutated the router's real swarmHealth map (a reference).
    expect(rBind.swarmHealth.get(recBind.id)).toBe(out.newHealth);
  });

  it('swarm binding (asteroid — no swarmHealth entry) reports applied=false and leaves the store untouched', () => {
    const r = makeRouter();
    const asteroid = makeDrone('swarm-7'); // never seeded into swarmHealth
    const out = freshResult();
    out.newHealth = 12345; // sentinel — must NOT be overwritten
    swarmHealthBinding(asteroid, r).applyLayered(50, TICK, out);
    expect(out.applied).toBe(false);
    expect(out.newHealth).toBe(12345);
    expect(r.swarmHealth.has(asteroid.id)).toBe(false);
  });

  it('ship binding is byte-identical to damageShipLayered (active: workerBodyId = playerId)', () => {
    const dmg = 25;

    const rDirect = makeRouter();
    const sDirect = makeShipStub();
    const direct = rDirect.damageShipLayered(sDirect, dmg, 'p1');

    const rBind = makeRouter();
    const sBind = makeShipStub();
    const out = freshResult();
    shipHealthBinding(sBind, rBind, 'p1').applyLayered(dmg, TICK, out);

    expect(out.applied).toBe(true);
    expect(out.newHealth).toBe(sDirect.health);
    expect(out.newShield).toBe(direct.newShield);
    expect(out.shieldMax).toBe(direct.shieldMax);
    expect(out.hullMax).toBe(direct.hullMax);
    expect(out.hitLayer).toBe(direct.hitLayer);
    expect(sBind.health).toBe(sDirect.health);
    expect(sBind.shield).toBe(sDirect.shield);
  });

  it('ship binding reports destroyed when an overkill hit drops hull to 0 (parity with branch 3 `ship.health <= 0`)', () => {
    const r = makeRouter();
    const s = makeShipStub();
    s.shield = 0; // shield already down — the hit lands on the hull (no-spillover
    //              means a shielded ship would absorb the overkill instead).
    const out = freshResult();
    shipHealthBinding(s, r, 'p1').applyLayered(9999, TICK, out);
    expect(out.applied).toBe(true);
    expect(s.health).toBe(0);
    expect(out.newHealth).toBe(0);
    expect(out.hitLayer).toBe('hull');
    expect(out.destroyed).toBe(true);
  });

  it('wreck binding matches the branch-1 flat-hull math and destroyed flag', () => {
    const w = { shipInstanceId: 'ship-abc', health: 10, maxHealth: 50 } as unknown as WreckState;
    const out = freshResult();
    wreckHealthBinding(w).applyLayered(30, TICK, out); // overkill

    expect(out.applied).toBe(true);
    expect(out.newHealth).toBe(0); // Math.max(0, 10 - 30)
    expect(w.health).toBe(0);
    expect(out.hullMax).toBe(50);
    expect(out.hitLayer).toBe('hull');
    expect(out.newShield).toBe(0);
    expect(out.destroyed).toBe(true);
  });
});

describe('DamageableEntity — monomorphic compose of binding + DeathPolicy', () => {
  function spyDeath() {
    const calls: Array<{ id: string; src: string; tick: number }> = [];
    const policy: DeathPolicy = { onDestroyed: (id, src, tick) => calls.push({ id, src, tick }) };
    return { policy, calls };
  }
  const bindWith = (mutate: (out: InteractionResultMut) => void): HealthBinding => ({
    applyLayered: (_a, _t, out) => mutate(out),
  });

  it('fires onDestroyed exactly once when the hit destroys', () => {
    const { policy, calls } = spyDeath();
    const e = new DamageableEntity('e1', bindWith((o) => { o.applied = true; o.destroyed = true; }), policy);
    e.receiveInteraction({ kind: 'damage', amount: 5, sourceId: 'shooter', atTick: TICK }, freshResult());
    expect(calls).toEqual([{ id: 'e1', src: 'shooter', tick: TICK }]);
  });

  it('does not fire onDestroyed on a non-fatal hit', () => {
    const { policy, calls } = spyDeath();
    const e = new DamageableEntity('e1', bindWith((o) => { o.applied = true; o.destroyed = false; }), policy);
    e.receiveInteraction({ kind: 'damage', amount: 5, sourceId: 's', atTick: TICK }, freshResult());
    expect(calls).toEqual([]);
  });

  it('does not fire onDestroyed when the target is immune (applied=false)', () => {
    const { policy, calls } = spyDeath();
    const e = new DamageableEntity('e1', bindWith((o) => { o.applied = false; o.destroyed = true; }), policy);
    e.receiveInteraction({ kind: 'damage', amount: 5, sourceId: 's', atTick: TICK }, freshResult());
    expect(calls).toEqual([]);
  });
});
