/**
 * Structure (pose-core kind 2): a static, damageable world object. Client-side
 * it is asteroid-like — a POLYGON (convexHull) collider built from the SAME
 * `structureHullPoints` the renderer draws (unified-hull plan), LOCKED in
 * predWorld and posed from the packet, so the client collision hull matches the
 * rendered silhouette AND the server collider (which is built from the same
 * points). No AI, no client shield layer. Damage is server-authoritative
 * through the existing swarm path (EntityResolver → StructureEntity), so there
 * is nothing damage-specific here — the "structure for free" payoff (B5).
 */
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';
import { structureHullPoints } from '../../../../shared-types/structureKinds.js';
import { gateColliderPolygons } from '../../../../core/structures/gateGeometry.js';

/** Structure predWorld mass — matches the pre-refactor hardcoded `3` for any
 *  non-drone kind. */
const STRUCTURE_MASS = 3;

export class StructureClientLeaf extends ClientEntityLeafBase {
  constructor() {
    super('structure');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    // Polygon hull from the single hull-points source — a convexHull collider
    // matching the silhouette (and the server collider built from the same
    // points), replacing the old circular collider.
    const vertices = structureHullPoints(ctx.entry.shipKind, ctx.entry.radius);
    // Gates: the posts (and airlock walls) as separate parts, matching the
    // server body, so the local ship can fly through the gap (#15).
    const parts = gateColliderPolygons(ctx.entry.shipKind) ?? undefined;
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      STRUCTURE_MASS,
      vertices,
      0,
      undefined,
      parts,
    );
    ctx.predWorld.lockBody(ctx.key); // static server-side
  }

  onSync(ctx: ClientSyncCtx): void {
    this.repose(ctx);
  }
}
