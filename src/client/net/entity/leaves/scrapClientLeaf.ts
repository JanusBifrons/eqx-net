/**
 * Scrap (pose-core kind 3): a free-floating ship-component fragment from a
 * death (scrap-on-death Phase 2c). Client-side it is asteroid-like — a POLYGON
 * (convexHull) collider built from the SAME component collider the server uses
 * (`shipScrapGroups(parentKind)[componentIndex].collider`, mapped catalogue
 * Pixi-up → world math-up via `x*scale, -y*scale`, matching ScrapSpawner), in
 * the scrap collision group (so it collides with ships/asteroids/structures but
 * NOT with other scrap), LOCKED in predWorld and posed from the packet (the
 * server is authoritative on its drift). The smooth render comes from
 * `interpolateSwarmPose` in the sprite updater, not from this body. Damage is
 * server-authoritative through the swarm path (EntityResolver → drone leaf), so
 * there is nothing damage-specific here.
 */
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';
import { shipScrapGroups } from '@core/geometry/shipScrapGroups';
import { shipShapeScale } from '@core/geometry/shipHullOutline';
import { SCRAP_COLLISION_GROUPS } from '@core/physics/collisionGroups';
import { SCRAP_LINEAR_DAMPING } from '@core/swarm/scrapConstants';
import { getShipKind } from '../../../../shared-types/shipKinds.js';

/** Scrap predWorld mass — light debris. Inert while the body is locked, but
 *  passed for parity with the server spawn. */
const SCRAP_MASS = 1;

export class ScrapClientLeaf extends ClientEntityLeafBase {
  constructor() {
    super('scrap');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    // Collider = the parent kind's component collider polygon, mapped to world
    // math-up EXACTLY as ScrapSpawner does on the server (so client + server
    // colliders match). `entry.shipKind` is the PARENT ship-kind; componentIndex
    // selects the component.
    const group = shipScrapGroups(ctx.entry.shipKind)[ctx.entry.componentIndex ?? 0];
    let vertices: { x: number; y: number }[] | undefined;
    if (group && ctx.entry.shipKind) {
      const scale = shipShapeScale(getShipKind(ctx.entry.shipKind));
      vertices = group.collider.map(([x, y]) => ({ x: x * scale, y: -y * scale }));
    }
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      SCRAP_MASS,
      vertices,
      SCRAP_LINEAR_DAMPING,
      SCRAP_COLLISION_GROUPS,
    );
    ctx.predWorld.lockBody(ctx.key); // server-authoritative; reposed each packet
  }

  onSync(ctx: ClientSyncCtx): void {
    this.repose(ctx);
  }
}
