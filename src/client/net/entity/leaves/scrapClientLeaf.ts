/**
 * Scrap (pose-core kind 3): a free-floating ship-component fragment from a
 * death (scrap-on-death Phase 2c). Client-side it is DRONE-like — NOT
 * asteroid-like — after the Phase-5 desync fix (2026-06-14). It is a POLYGON
 * (convexHull) collider built from the SAME component collider the server uses
 * (`shipScrapGroups(parentKind)[componentIndex].collider`, mapped catalogue
 * Pixi-up → world math-up via `x*scale, -y*scale`, matching ScrapSpawner), in
 * the scrap collision group (so it collides with ships/asteroids/structures but
 * NOT with other scrap), spawned UNLOCKED with the server's `SCRAP_DEFAULT_MASS`.
 *
 * Why drone-like, not asteroid-like: the SERVER spawns scrap as a DYNAMIC
 * mass-1 body (`SwarmSpawner` → `staticBody: false`) that drifts and is shoved
 * by ships. Locking it client-side (the old behaviour) made it an infinite-mass
 * wall — the local player bounced off it in prediction while the server let the
 * ship shove the light debris aside, so every snapshot reconciled that
 * divergence as a correction spike (the user's "huge spike in corrections").
 * The fix mirrors the DRONE leaf exactly: an unlocked dynamic body that is NOT
 * reposed here — `ColyseusClient.updateMirror` drives it KINEMATICALLY each
 * frame to the single interpolated pose (one-pose-per-frame), so render ==
 * collision and the player's predicted deflection matches the server.
 *
 * Damage is server-authoritative through the swarm path (EntityResolver →
 * drone leaf), so there is nothing damage-specific here.
 */
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';
import { shipScrapGroups } from '@core/geometry/shipScrapGroups';
import { shipShapeScale } from '@core/geometry/shipHullOutline';
import { SCRAP_COLLISION_GROUPS } from '@core/physics/collisionGroups';
import { SCRAP_LINEAR_DAMPING } from '@core/swarm/scrapConstants';
import { getShipKind } from '../../../../shared-types/shipKinds.js';

/** Scrap predWorld mass — light debris. MUST match the server's
 *  `SCRAP_DEFAULT_MASS` so the local player's predicted collision deflection
 *  against scrap equals the server's authoritative resolution (the Phase-5
 *  desync fix — the body is now dynamic, so this mass is load-bearing, not
 *  inert as it was while the body was locked). */
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
    // UNLOCKED + NOT reposed here: the body is a kinematic follower driven each
    // frame by `ColyseusClient.updateMirror` at the single interpolated pose,
    // exactly like the drone leaf. Locking it (the old behaviour) was the
    // Phase-5 desync — an infinite-mass wall the player bounced off while the
    // server let them shove it.
  }

  onSync(_ctx: ClientSyncCtx): void {
    // No-op: scrap has no shield to swap, and re-posing here would be a second,
    // fighting correction path against the `updateMirror` kinematic follower
    // (the one-pose-per-frame rule — see the drone leaf).
  }
}
