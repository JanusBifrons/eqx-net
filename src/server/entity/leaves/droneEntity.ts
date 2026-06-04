/**
 * `DroneEntity` — the leaf for a hostile/neutral AI drone (pose-core kind 1,
 * interpolated on the client). Damageable: it composes the swarm strategy —
 * layered shield→hull via `swarmHealthBinding` (HP lives in the parallel
 * `CombatSubsystem.swarmHealth` map — HC#3), the `damage_applied` diag +
 * `markHostile` flip per hit, and `evictSwarmEntity` on death.
 */

import { DamageableSwarmLeaf } from './swarmLeafBase.js';
import { createSwarmStrategy } from './swarmDamageStrategy.js';
import type { ShieldHullRouter } from '../../rooms/ShieldHullRouter.js';
import type { LeafDeps } from './entityLeaf.js';

export class DroneEntity extends DamageableSwarmLeaf {
  constructor(router: ShieldHullRouter, deps: LeafDeps, sabF32: Float32Array) {
    super('drone', createSwarmStrategy(router, deps), sabF32);
  }
}
