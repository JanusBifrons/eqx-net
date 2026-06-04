/**
 * Bases for the three pose-core swarm leaves (`DroneEntity`, `AsteroidEntity`,
 * `StructureEntity`). All swarm leaves live in the swarm registry, carry their
 * pose in the SAB at a slot, and identify on the wire as `swarm-<entityId>`;
 * that machinery lives once in `SwarmLeafBase`. Two of the three (drone,
 * structure) ALSO take damage — they extend `DamageableSwarmLeaf`, which adds
 * the composed `{ health, perHit, death }` strategy. The asteroid is
 * non-damageable (no HealthBinding) and uses `SwarmLeafBase` directly; the
 * resolver simply never routes a hit to it (immune).
 *
 * Sharing a base keeps the swarm leaves on one hidden-class lineage, which helps
 * the monomorphic `applyInteraction` reader (HC#5).
 */

import type { PoseOut } from '../../../core/entity/Entity.js';
import type { EntityKindTag } from '../../../core/entity/Entity.js';
import type { EntityKindDescriptor } from '../../../core/entity/EntityKindRegistry.js';
import { getEntityKind } from '../../../core/entity/EntityKindRegistry.js';
import type { SyncProfile } from '../../../core/contracts/INetworkSynced.js';
import type { RenderContribution } from '../../../core/contracts/IRenderContributor.js';
import type { HealthBinding } from '../../../core/contracts/IDamageable.js';
import {
  slotBase,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
} from '../../../shared-types/sabLayout.js';
import type { DamageableLeaf, SyncedLeaf, PerHitEffect, DeathPolicy, SwarmLeafTarget } from './entityLeaf.js';
import type { SwarmStrategy } from './swarmDamageStrategy.js';

/**
 * Pose / identity / sync / render machinery shared by every swarm leaf.
 * NON-damageable on its own — `AsteroidEntity` uses this directly; the
 * damageable swarm leaves extend `DamageableSwarmLeaf`.
 */
export abstract class SwarmLeafBase implements SyncedLeaf {
  /** Live swarm record this leaf currently adapts (set by the resolver). */
  target: SwarmLeafTarget = null as unknown as SwarmLeafTarget;

  readonly entityKind: EntityKindTag;
  private readonly descriptor: EntityKindDescriptor;

  constructor(
    entityKind: EntityKindTag,
    /** Live SAB Float32 view — the swarm body's pose lives at `slotBase(slot)`. */
    private readonly sabF32: Float32Array,
  ) {
    this.entityKind = entityKind;
    this.descriptor = getEntityKind(entityKind);
  }

  /** The wire id `swarm-<entityId>` — the namespace existing broadcast / sprite
   *  keying uses. NOTE (B4): a per-tick sync sweep that reads this must avoid
   *  re-deriving the string per entity (cache the wire id on the record); the
   *  damage path computes `wireTargetId` in the resolver, not here. */
  get entityId(): string {
    return `swarm-${this.target.entityId}`;
  }

  pose(out: PoseOut): PoseOut {
    const b = slotBase(this.target.slot);
    const f = this.sabF32;
    out.x = f[b + SLOT_X_OFF] ?? 0;
    out.y = f[b + SLOT_Y_OFF] ?? 0;
    out.vx = f[b + SLOT_VX_OFF] ?? 0;
    out.vy = f[b + SLOT_VY_OFF] ?? 0;
    out.angle = f[b + SLOT_ANGLE_OFF] ?? 0;
    out.angvel = f[b + SLOT_ANGVEL_OFF] ?? 0;
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
 * A swarm leaf that ALSO takes damage (drone, structure). Holds the composed
 * swarm `{ health, perHit, death }` strategy as data; the monomorphic
 * `applyInteraction` reads these fields (no per-class virtual dispatch — HC#5).
 */
export abstract class DamageableSwarmLeaf extends SwarmLeafBase implements DamageableLeaf {
  readonly health: HealthBinding;
  readonly perHit: PerHitEffect | null;
  readonly death: DeathPolicy;

  constructor(entityKind: EntityKindTag, strategy: SwarmStrategy, sabF32: Float32Array) {
    super(entityKind, sabF32);
    this.health = strategy.health;
    this.perHit = strategy.perHit;
    this.death = strategy.death;
  }
}
