import { describe, it, expect } from 'vitest';
import { MapSchema } from '@colyseus/schema';
import { ShieldHullRouter } from './ShieldHullRouter.js';
import { Bus } from '../../core/events/Bus.js';
import type { ShipState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

/**
 * Regression lock for the unified-entity-hull "fly into a capital" bug class
 * (surfaced by the shield-fence plan: pylons are the first structures the AI
 * actively shoots). The swarm shield-REGEN pass iterates every `swarmShield`
 * entry; structures seed shield 0 but `getDroneShieldMax`/`getShipKind` are
 * forgiving, so a DAMAGED structure used to regen a phantom FIGHTER shield and
 * post SET_HULL_EXPOSED — corrupting its collider to a ~12u fighter hull. The
 * fix gates regen on `rec.kind === 1` (drones only).
 */
function makeRouter(recs: Record<string, { kind: number; shipKind?: string }>) {
  const posted: WorkerCmd[] = [];
  let tick = 0;
  const router = new ShieldHullRouter({
    serverTick: () => tick,
    shipsMap: new MapSchema<ShipState>(),
    swarmRegistry: { get: (id) => recs[id] ?? null },
    bus: new Bus(),
    serverLogEvent: () => {},
    postToWorker: (cmd) => posted.push(cmd),
    broadcast: () => {},
  });
  return { router, posted, setTick: (t: number) => { tick = t; } };
}

describe('ShieldHullRouter — swarm shield regen gating', () => {
  it('does NOT regen a phantom shield on a DAMAGED structure (no fighter-shield borrow)', () => {
    const { router, posted, setTick } = makeRouter({ 'struct-1': { kind: 2, shipKind: 'shield_pylon' } });
    router.swarmHealth.set('struct-1', 800);
    router.swarmShield.set('struct-1', 0); // structures seed shield 0
    router.swarmShieldLastDmg.set('struct-1', 0); // took damage at tick 0
    setTick(10_000); // far past any regen delay
    router.tickShieldRegen();
    expect(router.swarmShield.get('struct-1')).toBe(0); // stays 0 — no borrowed shield
    expect(posted.filter((c) => c.type === 'SET_HULL_EXPOSED')).toHaveLength(0); // no collider corruption
  });

  it('still regens a genuine drone shield (kind 1)', () => {
    const { router, setTick } = makeRouter({ 'swarm-1': { kind: 1, shipKind: 'fighter' } });
    router.swarmHealth.set('swarm-1', 100);
    router.swarmShield.set('swarm-1', 0);
    router.swarmShieldLastDmg.set('swarm-1', 0);
    setTick(10_000);
    router.tickShieldRegen();
    expect(router.swarmShield.get('swarm-1')!).toBeGreaterThan(0); // drone regen intact
  });
});
