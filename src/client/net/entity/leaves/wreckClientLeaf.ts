/**
 * Capital wreck piece (pose-core kind 4, capital destruction S2b): one solid
 * piece of a dead capital. Client-side it is SCRAP-like: an UNLOCKED dynamic
 * body whose pose the per-snapshot remote-entity anchor owns (#12: one
 * paradigm for every remote moving entity — the body is anchored to the
 * latest server state and stepped on the prediction timeline, never re-posed
 * per frame), so the local ship's predicted ram matches the server's.
 *
 * The body is built from the SAME geometry the server's body is: the convex
 * parts and mass from `wreckPieceGeometry`, rebuilt off the wreck's `wrecks[]`
 * descriptor by the client's `WreckGeometryStore` (#15, no vertex on the
 * wire), with the server's linear and angular damping and the default
 * collision groups. The caller (`syncSwarmIntoPredWorld`) only spawns a piece
 * once its wreck's descriptor is known.
 *
 * Wreck pieces have no health: shots stop on them server-side and do nothing.
 */
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';
import { WRECK_ANGULAR_DAMPING, WRECK_LINEAR_DAMPING } from '@core/destruction/wreckPieces';

export class WreckClientLeaf extends ClientEntityLeafBase {
  constructor() {
    super('wreck');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    const e = ctx.entry;
    const g = ctx.wrecks !== undefined && e.wreckId !== undefined
      ? ctx.wrecks.piece(e.wreckId, e.componentIndex ?? 0)
      : null;
    if (g === null) return; // no geometry yet: the caller retries next sync
    ctx.predWorld.spawnObstacle(ctx.key, e.x, e.y, g.radius, g.mass, undefined, WRECK_LINEAR_DAMPING, undefined, g.parts);
    ctx.predWorld.setAngularDamping(ctx.key, WRECK_ANGULAR_DAMPING);
  }

  onSync(_ctx: ClientSyncCtx): void {
    // No-op: the remote-entity anchor is the only pose writer (as for scrap).
  }
}
