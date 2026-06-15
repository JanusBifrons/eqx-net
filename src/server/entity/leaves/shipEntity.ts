/**
 * `ShipEntity` — the leaf for a player hull. ONE class, two configurations
 * (HC#1): an ACTIVE ship (the hull a connected player is piloting) and a
 * LINGERING hull (a disconnected / fresh-spawn-displaced ship, `isActive=false`).
 * They share layered shield→hull damage but differ in identity (playerId vs
 * shipInstanceId), per-hit effect (active emits PLAYER_DAMAGED), and death
 * teardown (lingering frees its slot + DESPAWNs the `linger-<id>` worker body),
 * so the two are distinct flyweights of the same class — exactly the
 * "active + lingering distinguished by isActive" split the dispatch tree keyed
 * on a target-id shape today.
 *
 * The whole ship-as-world-object story lives here: how it identifies, how it
 * reads its pose, how it takes damage (`activeShipHealthBinding` /
 * `lingeringHealthBinding`), what fires per hit, what tears down on death, and
 * how it networks + renders. Add a new hull behaviour and you edit this file,
 * not four dispatch sites.
 */

import type { PoseOut } from '../../../core/entity/Entity.js';
import type { EntityKindTag } from '../../../core/entity/Entity.js';
import type { EntityKindDescriptor } from '../../../core/entity/EntityKindRegistry.js';
import { getEntityKind } from '../../../core/entity/EntityKindRegistry.js';
import type { SyncProfile } from '../../../core/contracts/INetworkSynced.js';
import type { RenderContribution } from '../../../core/contracts/IRenderContributor.js';
import type { HealthBinding } from '../../../core/contracts/IDamageable.js';
import { activeShipHealthBinding, lingeringHealthBinding } from '../healthBindings.js';
import type { ShipState } from '../../rooms/schema/SectorState.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipKindId } from '../../../shared-types/shipKinds.js';
import type { ShieldHullRouter } from '../../rooms/ShieldHullRouter.js';
import type { DamageableLeaf, PerHitEffect, DeathPolicy, LeafDeps } from './entityLeaf.js';

export class ShipEntity implements DamageableLeaf {
  // Hot fields first, fixed order (HC#5 — stable hidden-class shape for the
  // monomorphic `applyInteraction` reader).
  target: ShipState = null as unknown as ShipState;
  readonly health: HealthBinding;
  readonly perHit: PerHitEffect | null;
  readonly death: DeathPolicy;

  readonly entityKind: EntityKindTag;
  private readonly descriptor: EntityKindDescriptor;

  constructor(
    entityKind: 'active-ship' | 'lingering-hull',
    health: HealthBinding,
    perHit: PerHitEffect | null,
    death: DeathPolicy,
    /** Per-tick pose mirror keyed by this leaf's id (shipPoseCache for active,
     *  lingeringPoseCache for lingering). */
    private readonly poseCache: Map<string, ShipPhysicsState>,
    /** Derives the leaf's stable id from the live ShipState (playerId for
     *  active, shipInstanceId for lingering). */
    private readonly idOf: (ship: ShipState) => string,
  ) {
    this.entityKind = entityKind;
    this.descriptor = getEntityKind(entityKind);
    this.health = health;
    this.perHit = perHit;
    this.death = death;
  }

  get entityId(): string {
    return this.idOf(this.target);
  }

  pose(out: PoseOut): PoseOut {
    const p = this.poseCache.get(this.entityId);
    out.x = p?.x ?? 0;
    out.y = p?.y ?? 0;
    out.vx = p?.vx ?? 0;
    out.vy = p?.vy ?? 0;
    out.angle = p?.angle ?? 0;
    out.angvel = p?.angvel ?? 0;
    return out;
  }

  syncProfile(): SyncProfile {
    return this.descriptor.sync;
  }

  renderContribution(): RenderContribution {
    return this.descriptor.render;
  }
}

/**
 * The ACTIVE player-hull leaf (former DamageRouter branch 3): layered damage
 * keyed by playerId, PLAYER_DAMAGED per hit, SHIP_DESTROYED on death.
 */
export function createActiveShipEntity(
  router: ShieldHullRouter,
  deps: LeafDeps,
  shipPoseCache: Map<string, ShipPhysicsState>,
): ShipEntity {
  const perHit: PerHitEffect = {
    onApplied(_target, targetId, _wireTargetId, _sourceId, amount, out) {
      deps.bus.emit('PLAYER_DAMAGED', {
        type: 'PLAYER_DAMAGED',
        targetId,
        damage: amount,
        newHealth: out.newHealth,
      });
    },
  };
  const death: DeathPolicy = {
    onDestroyed(target, targetId, _wireTargetId, sourceId) {
      const ship = target as ShipState;
      ship.alive = false;
      deps.broadcastDestroy({ type: 'destroy', targetId, shooterId: sourceId });
      deps.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId: sourceId });
      deps.logger.info({ targetId, shooterId: sourceId }, 'ship destroyed');
    },
  };
  return new ShipEntity(
    'active-ship',
    activeShipHealthBinding(router),
    perHit,
    death,
    shipPoseCache,
    (ship) => ship.playerId,
  );
}

/**
 * The LINGERING-hull leaf (former DamageRouter branch 2): layered damage with
 * no SET_HULL_EXPOSED (workerBodyId=null), no per-hit effect, and a death that
 * frees the slot, deletes the schema entry, and DESPAWNs the `linger-<id>`
 * worker body.
 */
export function createLingeringHullEntity(
  router: ShieldHullRouter,
  deps: LeafDeps,
  lingeringPoseCache: Map<string, ShipPhysicsState>,
): ShipEntity {
  const death: DeathPolicy = {
    onDestroyed(target, targetId, _wireTargetId, sourceId) {
      const ship = target as ShipState;
      ship.alive = false;
      deps.broadcastDestroy({ type: 'destroy', targetId, shooterId: sourceId });
      // P6.3 (Equinox Phase 6) — a COMPOSITE lingering hull breaks into floating
      // scrap like an active ship/drone. Read the dying pose from
      // `lingeringPoseCache` BEFORE the teardown below deletes it; the room hook
      // guards polygon kinds (no scrap groups) + calls ScrapSpawner.spawnFromDeath.
      const scrapPose = deps.lingeringPoseCache.get(targetId);
      if (scrapPose !== undefined) {
        deps.spawnScrapFromLingeringHull?.(ship.kind as ShipKindId, scrapPose, targetId);
      }
      const slot = deps.lingeringSlots.get(targetId);
      if (slot !== undefined) {
        deps.lingeringSlots.delete(targetId);
        deps.lingeringPoseCache.delete(targetId);
        deps.freeSlots.push(slot);
        // The worker body for a displaced lingering hull is keyed
        // `linger-${shipInstanceId}`, NOT playerId. Despawn that body.
        deps.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${targetId}` });
      }
      deps.shipsMap.delete(targetId);
      deps.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId: sourceId });
      deps.logger.info({ shipInstanceId: targetId, shooterId: sourceId }, 'lingering hull destroyed');
    },
  };
  return new ShipEntity(
    'lingering-hull',
    lingeringHealthBinding(router),
    null,
    death,
    lingeringPoseCache,
    (ship) => ship.shipInstanceId,
  );
}
