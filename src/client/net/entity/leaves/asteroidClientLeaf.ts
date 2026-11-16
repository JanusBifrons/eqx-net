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
    // An awake cut-field rock (macro terrain C2) collides as its cut outline,
    // the same verts the server's body has (#15); a client that has not cut
    // that chunk yet falls back to a generated rock of the same radius.
    const fk = ctx.entry.fieldKey;
    const field = fk !== undefined ? ctx.fieldRocks?.wakeFieldRock(fk) ?? null : null;
    const verts = field?.verts ?? generateAsteroidVertices(ctx.entry.shapeSeed ?? 0, ctx.entry.radius);
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      ASTEROID_MASS,
      verts,
      undefined,
      undefined,
      field?.parts ?? undefined, // its convex parts (plan C1), like the server's body
    );
    ctx.predWorld.lockBody(ctx.key); // static server-side
  }

  onSync(ctx: ClientSyncCtx): void {
    // Keeps the rock's fixed cut-field body away while it is on the wire.
    const fk = ctx.entry.fieldKey;
    if (fk !== undefined) ctx.fieldRocks?.wakeFieldRock(fk);
    this.repose(ctx); // locked / static — the authoritative packet pose is correct
  }
}
