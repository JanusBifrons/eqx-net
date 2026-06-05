/**
 * `ProjectileEntity` — the leaf for an in-flight projectile (bolt). NON-
 * damageable: a projectile is a damage SOURCE, never a target in any of the
 * four dispatch sites, so it has no `health`/`perHit`/`death`. It exists so the
 * B4 sync-router + client factory construct + network every kind uniformly
 * (its sync profile routes it onto the `projectiles` json-slice).
 *
 * Id namespace: the `p-<n>` key the `CombatSubsystem.liveProjectiles` map uses
 * (provided on the target view by the B4 factory — the raw record has no id of
 * its own). A projectile carries no angle (it renders oriented by velocity), so
 * `pose()` reports angle/angvel as 0.
 */

import type { PoseOut } from '../../../core/entity/Entity.js';
import type { EntityKindTag } from '../../../core/entity/Entity.js';
import type { EntityKindDescriptor } from '../../../core/entity/EntityKindRegistry.js';
import { getEntityKind } from '../../../core/entity/EntityKindRegistry.js';
import type { SyncProfile } from '../../../core/contracts/INetworkSynced.js';
import type { RenderContribution } from '../../../core/contracts/IRenderContributor.js';
import type { SyncedLeaf } from './entityLeaf.js';

/** The fields a projectile leaf adapts over (its map-key id + linear pose). */
export interface ProjectileLeafTarget {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export class ProjectileEntity implements SyncedLeaf {
  target: ProjectileLeafTarget = null as unknown as ProjectileLeafTarget;

  readonly entityKind: EntityKindTag = 'projectile';
  private readonly descriptor: EntityKindDescriptor = getEntityKind('projectile');

  get entityId(): string {
    return this.target.id;
  }

  pose(out: PoseOut): PoseOut {
    const t = this.target;
    out.x = t.x;
    out.y = t.y;
    out.vx = t.vx;
    out.vy = t.vy;
    out.angle = 0;
    out.angvel = 0;
    return out;
  }

  syncProfile(): SyncProfile {
    return this.descriptor.sync;
  }

  renderContribution(): RenderContribution {
    return this.descriptor.render;
  }
}
