/**
 * `WreckEntity` — the leaf for an abandoned ship hull that has become a wreck
 * (former DamageRouter branch 1). Flat hull damage (no shield layer), no
 * per-hit effect, and a death that broadcasts the destroy on the `wreck-<id>`
 * wire id and tears the wreck down via `destroyWreck`.
 *
 * Identity note: the leaf's `entityId` is the bare `shipInstanceId` (the
 * namespace existing code uses), but the damage wire id is the `wreck-<id>`
 * prefixed form (resolved + passed in as `wireTargetId`) — the death policy
 * broadcasts/buses on `wireTargetId` and reaps via `shipInstanceId`, exactly as
 * the original branch did.
 */

import type { PoseOut } from '../../../core/entity/Entity.js';
import type { EntityKindTag } from '../../../core/entity/Entity.js';
import type { EntityKindDescriptor } from '../../../core/entity/EntityKindRegistry.js';
import { getEntityKind } from '../../../core/entity/EntityKindRegistry.js';
import type { SyncProfile } from '../../../core/contracts/INetworkSynced.js';
import type { RenderContribution } from '../../../core/contracts/IRenderContributor.js';
import type { HealthBinding } from '../../../core/contracts/IDamageable.js';
import { wreckHealthBinding } from '../healthBindings.js';
import type { WreckState } from '../../rooms/schema/SectorState.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { DamageableLeaf, PerHitEffect, DeathPolicy, LeafDeps } from './entityLeaf.js';

export class WreckEntity implements DamageableLeaf {
  // Hot fields first, fixed order (HC#5).
  target: WreckState = null as unknown as WreckState;
  readonly health: HealthBinding;
  readonly perHit: PerHitEffect | null = null;
  readonly death: DeathPolicy;

  readonly entityKind: EntityKindTag = 'wreck';
  private readonly descriptor: EntityKindDescriptor = getEntityKind('wreck');

  constructor(
    deps: LeafDeps,
    private readonly wreckPoseCache: Map<string, ShipPhysicsState>,
  ) {
    this.health = wreckHealthBinding();
    this.death = {
      onDestroyed(target, _targetId, wireTargetId, sourceId) {
        const wreck = target as WreckState;
        deps.broadcastDestroy({ type: 'destroy', targetId: wireTargetId, shooterId: sourceId });
        deps.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: wireTargetId, shooterId: sourceId });
        deps.destroyWreck(wreck.shipInstanceId);
        deps.logger.info({ shipInstanceId: wreck.shipInstanceId, shooterId: sourceId }, 'wreck destroyed');
      },
    };
  }

  get entityId(): string {
    return this.target.shipInstanceId;
  }

  pose(out: PoseOut): PoseOut {
    const p = this.wreckPoseCache.get(this.entityId);
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

/** The wreck leaf (former DamageRouter branch 1). */
export function createWreckEntity(
  deps: LeafDeps,
  wreckPoseCache: Map<string, ShipPhysicsState>,
): WreckEntity {
  return new WreckEntity(deps, wreckPoseCache);
}
