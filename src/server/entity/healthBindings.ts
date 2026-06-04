/**
 * Server-side `HealthBinding` factories — the concrete answer to HC#3.
 *
 * Each factory returns a thin shim that, when asked to apply damage, calls
 * the EXISTING layered-damage primitive against the REAL live store and fills
 * the reused `InteractionResultMut`. There is no data migration and no value
 * copy: the binding closes over the live `ShipState` / `WreckState` /
 * `ShieldHullRouter` (whose `swarmHealth` / `swarmShield` maps own drone HP),
 * so the single source of truth is unchanged.
 *
 * The output is intentionally byte-identical to the matching DamageRouter
 * branch's health computation (DamageRouter.ts branches 1/2/3/4). Phase 1
 * locks that parity in `healthBindings.test.ts`; Phase 2 routes
 * DamageRouter.apply through these so the if-tree collapses with zero
 * behaviour change.
 *
 * Server zone: imports the Colyseus schema + ShieldHullRouter. The contract
 * (`HealthBinding`) is the zone-pure abstraction in src/core.
 */

import type { HealthBinding, InteractionResultMut } from '../../core/contracts/IDamageable.js';
import type { ShipState, WreckState } from '../rooms/schema/SectorState.js';
import type { ShieldHullRouter, SwarmDamageTarget } from '../rooms/ShieldHullRouter.js';

/**
 * Active or lingering player ship. Matches DamageRouter branch 3 (active,
 * `workerBodyId = playerId`) and branch 2 (lingering, `workerBodyId = null`).
 * `damageShipLayered` mutates `ship.health` / `ship.shield` in place.
 */
export function shipHealthBinding(
  ship: ShipState,
  router: ShieldHullRouter,
  workerBodyId: string | null,
): HealthBinding {
  return {
    applyLayered(amount: number, _atTick: number, out: InteractionResultMut): void {
      const r = router.damageShipLayered(ship, amount, workerBodyId);
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

/**
 * Ownerless wreck. Matches DamageRouter branch 1: flat hull damage, no
 * shield layer, `hullMax = wreck.maxHealth`.
 */
export function wreckHealthBinding(wreck: WreckState): HealthBinding {
  return {
    applyLayered(amount: number, _atTick: number, out: InteractionResultMut): void {
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
 * Swarm entity (drone OR asteroid). Matches DamageRouter branch 4:
 * `damageSwarmLayered` returns `null` for an asteroid (no `swarmHealth`
 * entry) → the binding reports `applied = false` (immune), leaving the store
 * untouched. For a drone it mutates the parallel `swarmHealth` /
 * `swarmShield` maps the router owns (HC#3) and reads `swarmHealth.get(id)`
 * for the resulting hull — exactly as the branch does.
 */
export function swarmHealthBinding(
  rec: SwarmDamageTarget,
  router: ShieldHullRouter,
): HealthBinding {
  return {
    applyLayered(amount: number, _atTick: number, out: InteractionResultMut): void {
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
