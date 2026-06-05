/**
 * `StructureEntity` — the leaf for a static, damageable world structure
 * (pose-core kind 2; the Generic Entity Pipeline "structure for free" proof,
 * re-proven through the generic layer in B5). Static like an asteroid (not
 * AI/interpolated) but damageable like a drone: it composes the same swarm
 * strategy (layered hull via `swarmHealthBinding` once the server seeds
 * `swarmHealth` on spawn; `evictSwarmEntity` on death), so a structure takes
 * damage with ZERO new dispatch branch — exactly the payoff the pipeline exists
 * to deliver. The static-vs-AI difference is the registry descriptor
 * (`interpolated: false`, kind byte 2), not the damage body.
 */

import { DamageableSwarmLeaf } from './swarmLeafBase.js';
import { createSwarmStrategy } from './swarmDamageStrategy.js';
import type { ShieldHullRouter } from '../../rooms/ShieldHullRouter.js';
import type { LeafDeps } from './entityLeaf.js';

export class StructureEntity extends DamageableSwarmLeaf {
  constructor(router: ShieldHullRouter, deps: LeafDeps, sabF32: Float32Array) {
    super('structure', createSwarmStrategy(router, deps), sabF32);
  }
}
