/**
 * Asteroid (pose-core kind 0): a deterministic convex-polygon collider, LOCKED
 * in predWorld and posed straight from the binary packet (it is static
 * server-side and only moves on collision events, where the authoritative snap
 * is correct). No AI, no shield. Vertices are generated from the entityId so the
 * client polygon is byte-for-byte the server's (both seed from the same id).
 */
import { generateAsteroidVertices } from '@core/swarm/asteroidShape';
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';

/** Asteroid predWorld mass — matches the pre-refactor hardcoded `3`. Asteroids
 *  use a convexHull + area-density collider server-side, so this pin is not
 *  load-bearing the way the drone's catalogue mass is. */
const ASTEROID_MASS = 3;

export class AsteroidClientLeaf extends ClientEntityLeafBase {
  constructor() {
    super('asteroid');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      ASTEROID_MASS,
      generateAsteroidVertices(ctx.entityId, ctx.entry.radius),
    );
    ctx.predWorld.lockBody(ctx.key); // static server-side
  }

  onSync(ctx: ClientSyncCtx): void {
    this.repose(ctx); // locked / static — the authoritative packet pose is correct
  }
}
