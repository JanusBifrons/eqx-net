/**
 * Phase 1/2 lock (Generic Entity Pipeline): the per-kind `HealthBinding`
 * singletons are byte-identical to the existing layered-damage primitives, are
 * stateless (one instance handles many targets), and report the right
 * `applied`/`destroyed` flags.
 *
 * Why: Phase 2 routes DamageRouter through these bindings; a divergence from
 * `damageShipLayered` / `damageSwarmLayered` math would
 * silently change damage outcomes. HC#3: the swarm binding mutates the parallel
 * `swarmHealth` map (a reference) — asserted by reading the router's map after
 * applying. The full dispatch ORDER is locked separately by
 * DamageRouter.dispatch.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { MapSchema } from '@colyseus/schema';
// Type-only: the real ShipState is a @colyseus/schema class whose
// v3 decorators need a Symbol.metadata runtime the plain unit env lacks (it
// is only *instantiated* in the integration suite). The bindings touch only
// plain fields, so structural stubs cast to the schema types exercise the same
// code paths without loading the decorator module.
import type { ShipState } from '../rooms/schema/SectorState.js';
import { ShieldHullRouter, type SwarmDamageTarget } from '../rooms/ShieldHullRouter.js';
import { getDroneMaxHealth } from '../rooms/droneKindHelpers.js';
import { DEFAULT_SHIP_KIND } from '../../shared-types/shipKinds.js';
import type { Bus } from '../../core/events/Bus.js';
import { resetInteractionResult, type InteractionResultMut } from '../../core/contracts/IDamageable.js';
import {
  activeShipHealthBinding,
  lingeringHealthBinding,
  swarmHealthBinding,
} from './healthBindings.js';

const TICK = 100;

function makeRouter(): ShieldHullRouter {
  return new ShieldHullRouter({
    serverTick: () => TICK,
    shipsMap: new Map() as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: () => null },
    bus: { emit() {} } as unknown as Bus,
    serverLogEvent: () => {},
    postToWorker: () => {},
    broadcast: () => {},
  });
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

function makeDrone(id: string): SwarmDamageTarget {
  return { id, entityId: Number(id.replace(/\D/g, '')) || 1, shipKind: DEFAULT_SHIP_KIND, shieldDown: false };
}

describe('healthBindings — parity with the existing primitives', () => {
  it('swarm binding (drone) is byte-identical to damageSwarmLayered + swarmHealth read', () => {
    const dmg = 9999; // punches through shield and kills in one hit
    const maxHp = getDroneMaxHealth(DEFAULT_SHIP_KIND) ?? 40;

    const rDirect = makeRouter();
    const recDirect = makeDrone('swarm-1');
    rDirect.swarmHealth.set(recDirect.id, maxHp);
    const direct = rDirect.damageSwarmLayered(recDirect, dmg);
    const directHealth = rDirect.swarmHealth.get(recDirect.id) ?? 0;

    const rBind = makeRouter();
    const recBind = makeDrone('swarm-1');
    rBind.swarmHealth.set(recBind.id, maxHp);
    const out = freshResult();
    swarmHealthBinding(rBind).applyLayered(recBind, dmg, TICK, out);

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

  it('swarm binding is stateless — one instance handles many drones', () => {
    const r = makeRouter();
    r.swarmHealth.set('swarm-1', 40);
    r.swarmHealth.set('swarm-2', 40);
    const binding = swarmHealthBinding(r);
    const out = freshResult();
    binding.applyLayered(makeDrone('swarm-1'), 5, TICK, out);
    const h1 = out.newHealth;
    binding.applyLayered(makeDrone('swarm-2'), 9, TICK, out);
    expect(r.swarmHealth.get('swarm-1')).toBe(h1);
    expect(r.swarmHealth.get('swarm-2')).toBe(out.newHealth);
  });

  it('swarm binding (asteroid — no swarmHealth entry) reports applied=false and leaves the store untouched', () => {
    const r = makeRouter();
    const asteroid = makeDrone('swarm-7'); // never seeded into swarmHealth
    const out = freshResult();
    out.newHealth = 12345; // sentinel — must NOT be overwritten
    swarmHealthBinding(r).applyLayered(asteroid, 50, TICK, out);
    expect(out.applied).toBe(false);
    expect(out.newHealth).toBe(12345);
    expect(r.swarmHealth.has(asteroid.id)).toBe(false);
  });

  it('active-ship binding is byte-identical to damageShipLayered (workerBodyId = playerId)', () => {
    const dmg = 25;

    const rDirect = makeRouter();
    const sDirect = makeShipStub();
    const direct = rDirect.damageShipLayered(sDirect, dmg, 'p1');

    const rBind = makeRouter();
    const sBind = makeShipStub();
    const out = freshResult();
    activeShipHealthBinding(rBind).applyLayered(sBind, dmg, TICK, out);

    expect(out.applied).toBe(true);
    expect(out.newHealth).toBe(sDirect.health);
    expect(out.newShield).toBe(direct.newShield);
    expect(out.shieldMax).toBe(direct.shieldMax);
    expect(out.hullMax).toBe(direct.hullMax);
    expect(out.hitLayer).toBe(direct.hitLayer);
    expect(sBind.health).toBe(sDirect.health);
    expect(sBind.shield).toBe(sDirect.shield);
  });

  it('active-ship binding reports destroyed when an overkill hit drops hull to 0', () => {
    const r = makeRouter();
    const s = makeShipStub();
    s.shield = 0; // shield down — the hit lands on the hull (a shielded ship would absorb).
    const out = freshResult();
    activeShipHealthBinding(r).applyLayered(s, 9999, TICK, out);
    expect(out.applied).toBe(true);
    expect(s.health).toBe(0);
    expect(out.newHealth).toBe(0);
    expect(out.hitLayer).toBe('hull');
    expect(out.destroyed).toBe(true);
  });

  it('lingering binding passes workerBodyId=null (no SET_HULL_EXPOSED on shield break)', () => {
    const posted: string[] = [];
    const r = new ShieldHullRouter({
      serverTick: () => TICK,
      shipsMap: new Map() as unknown as MapSchema<ShipState>,
      swarmRegistry: { get: () => null },
      bus: { emit() {} } as unknown as Bus,
      serverLogEvent: () => {},
      postToWorker: (cmd) => posted.push(cmd.type),
      broadcast: () => {},
    });
    const s = makeShipStub(); // shield 30
    const out = freshResult();
    // A hit big enough to break the shield (30 → 0). Active would post
    // SET_HULL_EXPOSED; lingering must NOT.
    lingeringHealthBinding(r).applyLayered(s, 30, TICK, out);
    expect(out.applied).toBe(true);
    expect(posted).not.toContain('SET_HULL_EXPOSED');
  });
});
