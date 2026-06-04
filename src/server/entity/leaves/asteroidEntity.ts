/**
 * `AsteroidEntity` — the leaf for a static asteroid (pose-core kind 0).
 * NON-damageable (no `HealthBinding`): an asteroid is never a damage target —
 * the resolver returns `null` for kind 0, so a hit on an asteroid produces no
 * event (byte-identical to the old swarm branch's asteroid-immune path, which
 * resolved to `swarm` and then short-circuited on `applied:false`; locked by the
 * dispatch golden-master's branch-5 case). It still rides the pose-core wire +
 * render path like any swarm body — hence `SwarmLeafBase`, not a damageable one.
 */

import { SwarmLeafBase } from './swarmLeafBase.js';

export class AsteroidEntity extends SwarmLeafBase {
  constructor(sabF32: Float32Array) {
    super('asteroid', sabF32);
  }
}
