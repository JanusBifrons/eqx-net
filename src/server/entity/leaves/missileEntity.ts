/**
 * `MissileEntity` — the leaf for an in-flight homing missile. NON-damageable: a
 * missile is a damage SOURCE (its splash routes through the swarm/ship leaves),
 * never a target, so it has no `health`/`perHit`/`death`. It exists so the B4
 * sync-router + client factory handle every kind uniformly (its sync profile
 * routes it onto the `missiles` json-slice).
 *
 * Id namespace: the missile's numeric `id` as a string (matches
 * `MissileFiredEvent.missileId` / `SnapshotMessage.missiles[].id`).
 */

import type { PoseOut } from '../../../core/entity/Entity.js';
import type { EntityKindTag } from '../../../core/entity/Entity.js';
import type { EntityKindDescriptor } from '../../../core/entity/EntityKindRegistry.js';
import { getEntityKind } from '../../../core/entity/EntityKindRegistry.js';
import type { SyncProfile } from '../../../core/contracts/INetworkSynced.js';
import type { RenderContribution } from '../../../core/contracts/IRenderContributor.js';
import type { SyncedLeaf } from './entityLeaf.js';

/** The fields a missile leaf adapts over (numeric id + pose incl. heading). */
export interface MissileLeafTarget {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export class MissileEntity implements SyncedLeaf {
  target: MissileLeafTarget = null as unknown as MissileLeafTarget;

  readonly entityKind: EntityKindTag = 'missile';
  private readonly descriptor: EntityKindDescriptor = getEntityKind('missile');

  get entityId(): string {
    return String(this.target.id);
  }

  pose(out: PoseOut): PoseOut {
    const t = this.target;
    out.x = t.x;
    out.y = t.y;
    out.vx = t.vx;
    out.vy = t.vy;
    out.angle = t.angle;
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
