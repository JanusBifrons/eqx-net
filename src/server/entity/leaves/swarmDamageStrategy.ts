/**
 * The shared SWARM damage strategy — the composed `{ health, perHit, death }`
 * that the three pose-core swarm leaves (`DroneEntity`, `AsteroidEntity`,
 * `StructureEntity`) hold. Factored out because all three ride the same
 * swarm-registry damage path (a drone, a static structure, and an immune
 * asteroid all resolve through `swarmHealthBinding`); the per-kind difference
 * is identity + sync/render, not the damage body.
 *
 * The bodies are lifted VERBATIM from the former `DamageRouter.strategies.swarm`
 * (perHit = `damage_applied` diag + `markHostile`; death = `evictSwarmEntity`),
 * so routing a swarm leaf through `applyInteraction` is byte-identical to the
 * old table (locked by `DamageRouter.dispatch.test.ts`). Allocation-free: the
 * strategy is built once per leaf at construction (invariant #14).
 */

import { swarmHealthBinding } from '../healthBindings.js';
import type { HealthBinding, InteractionResultMut } from '../../../core/contracts/IDamageable.js';
import type { ShieldHullRouter } from '../../rooms/ShieldHullRouter.js';
import type { LeafDeps, PerHitEffect, DeathPolicy, SwarmLeafTarget } from './entityLeaf.js';

/** Layered shield→hull binding for a swarm record (asteroid → `applied:false`
 *  because it has no `swarmHealth` entry). One per kind, stateless. */
export function createSwarmHealth(router: ShieldHullRouter): HealthBinding {
  return swarmHealthBinding(router);
}

/** Per-applied-hit swarm side-effect: the swarm-only `damage_applied` diag (the
 *  missile-vs-drone smoke class polls `/dev/events` for this) + the
 *  hit-flips-to-COMBAT `markHostile`. Never fires for an immune asteroid
 *  (`applyInteraction` returns on `!out.applied` before this is read). */
export function createSwarmPerHit(deps: LeafDeps): PerHitEffect {
  return {
    onApplied(target, _targetId, wireTargetId, sourceId, amount, out, atTick) {
      const rec = target as SwarmLeafTarget;
      deps.serverLogEvent('damage_applied', {
        targetId: rec.id,
        wireTargetId,
        shooterId: sourceId,
        damage: amount,
        newHealth: out.newHealth,
        newShield: out.newShield,
        hitLayer: out.hitLayer,
        kind: 'swarm',
        swarmKind: rec.kind,
      });
      // A hit flips the entity to COMBAT + adds the shooter; the client mirrors
      // this from its damage-event handler (no wire bump).
      //
      // Gate on kind === 1 (drone): ONLY drones have an `AiController`
      // registration + a `HostileDroneBehaviour` to receive the mark. A
      // structure (kind 2) or asteroid (kind 0) is never registered, so
      // `markHostile(structureId, …)` would buffer a `(structureId, shooterId)`
      // entry in `AiController.pendingHostile` that NEVER drains (no register /
      // unregister for non-drones) — a slow leak in long-lived galaxy rooms,
      // amplified once drones actively shoot structures (wave system Phase 2).
      // Faction escalation when a structure is attacked is handled separately
      // by the FactionLedger seam, not by marking the structure "hostile".
      if (sourceId && rec.kind === 1) {
        deps.aiController.markHostile(rec.id, sourceId, atTick);
        // Wave-system reactive escalation (req #5): if the shooter belongs to a
        // faction (player / owned structure), the room flips that faction
        // hostile + marks this drone hostile to the whole faction. Gated to
        // drones here; a drone-on-drone hit resolves to no faction in the room.
        deps.onDroneDamaged?.(rec.id, sourceId, atTick);
      }
    },
  };
}

/** Teardown on a swarm hull 0-cross: quiet despawn through the existing
 *  `evictSwarmEntity` (which owns the destroy broadcast + ENTITY_DESTROYED). */
export function createSwarmDeath(deps: LeafDeps): DeathPolicy {
  return {
    onDestroyed(target, _targetId, _wireTargetId, sourceId) {
      deps.evictSwarmEntity(target as SwarmLeafTarget, {
        broadcast: true,
        emitDestroyed: true,
        shooterId: sourceId,
      });
    },
  };
}

/** Convenience: the full composed swarm strategy a leaf holds. */
export interface SwarmStrategy {
  readonly health: HealthBinding;
  readonly perHit: PerHitEffect;
  readonly death: DeathPolicy;
}

export function createSwarmStrategy(router: ShieldHullRouter, deps: LeafDeps): SwarmStrategy {
  return {
    health: createSwarmHealth(router),
    perHit: createSwarmPerHit(deps),
    death: createSwarmDeath(deps),
  };
}

/** Re-export the result shape so leaves can type their reused result scratch. */
export type { InteractionResultMut };
