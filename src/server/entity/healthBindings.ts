/**
 * Server-side `HealthBinding` singletons — the concrete answer to HC#3, now
 * STATELESS + per-kind (created once, never per hit → zero hot-loop allocation,
 * invariant #14).
 *
 * Each factory closes over only the stable `ShieldHullRouter` and returns ONE
 * binding that handles every entity of its kind; the entity-specific state is
 * the `target` argument. The output is byte-identical to the matching
 * DamageRouter branch's health computation (DamageRouter.ts branches 1/2/3/4),
 * locked by `healthBindings.test.ts` + the dispatch golden-master.
 *
 * Server zone: imports the Colyseus schema types + ShieldHullRouter. The
 * contract (`HealthBinding`) is the zone-pure abstraction in src/core.
 */

import type { HealthBinding, InteractionResultMut } from '../../core/contracts/IDamageable.js';
import type { ShipState, WreckState } from '../rooms/schema/SectorState.js';
import type { ShieldHullRouter, SwarmDamageTarget } from '../rooms/ShieldHullRouter.js';

/** Shared ship-layered binding; `workerBodyIdFor` differs active vs lingering. */
function shipBinding(
  router: ShieldHullRouter,
  workerBodyIdFor: (ship: ShipState) => string | null,
): HealthBinding {
  return {
    applyLayered(target: unknown, amount: number, _atTick: number, out: InteractionResultMut): void {
      const ship = target as ShipState;
      const r = router.damageShipLayered(ship, amount, workerBodyIdFor(ship));
      out.applied = true;
      out.newHealth = ship.health;
      out.newShield = r.newShield;
      out.shieldMax = r.shieldMax;
      out.hullMax = r.hullMax;
      out.hitLayer = r.hitLayer;
      out.destroyed = ship.health <= 0;
    },
  };
}

/** Active player ship (branch 3): worker body keyed by playerId → SET_HULL_EXPOSED
 *  on the active body when the shield breaks. */
export function activeShipHealthBinding(router: ShieldHullRouter): HealthBinding {
  return shipBinding(router, (ship) => ship.playerId);
}

/** Lingering hull (branch 2): `workerBodyId = null` → no SET_HULL_EXPOSED post
 *  (matches the original branch, which passes null). */
export function lingeringHealthBinding(router: ShieldHullRouter): HealthBinding {
  return shipBinding(router, () => null);
}

/** Ownerless wreck (branch 1): flat hull damage, no shield layer. */
export function wreckHealthBinding(): HealthBinding {
  return {
    applyLayered(target: unknown, amount: number, _atTick: number, out: InteractionResultMut): void {
      const wreck = target as WreckState;
      wreck.health = Math.max(0, wreck.health - amount);
      out.applied = true;
      out.newHealth = wreck.health;
      out.newShield = 0;
      out.shieldMax = 0;
      out.hullMax = wreck.maxHealth;
      out.hitLayer = 'hull';
      out.destroyed = wreck.health <= 0;
    },
  };
}

/**
 * Swarm entity (branch 4): drone OR asteroid. `damageSwarmLayered` returns
 * `null` for an asteroid (no `swarmHealth` entry) → `out.applied = false`
 * (immune, store untouched). For a drone it mutates the parallel `swarmHealth`
 * / `swarmShield` maps the router owns (HC#3) and reads `swarmHealth.get(id)`.
 */
export function swarmHealthBinding(router: ShieldHullRouter): HealthBinding {
  return {
    applyLayered(target: unknown, amount: number, _atTick: number, out: InteractionResultMut): void {
      const rec = target as SwarmDamageTarget;
      const r = router.damageSwarmLayered(rec, amount);
      if (r === null) {
        out.applied = false; // asteroid — immune, store untouched
        return;
      }
      const newHealth = router.swarmHealth.get(rec.id) ?? 0;
      out.applied = true;
      out.newHealth = newHealth;
      out.newShield = r.newShield;
      out.shieldMax = r.shieldMax;
      out.hullMax = r.hullMax;
      out.hitLayer = r.hitLayer;
      out.destroyed = newHealth <= 0;
    },
  };
}
