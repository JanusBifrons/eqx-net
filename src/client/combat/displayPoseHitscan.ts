/**
 * The local beam / hit-prediction ray, with remote drones and scrap tested
 * at their DRAWN pose (remote-entity paradigm, 2026-11-08).
 *
 * Since the remote-entity paradigm, a drone's or scrap piece's predWorld
 * body runs on the local prediction's timeline (anchored to the latest
 * server state each snapshot, stepped with the replay and `tickPhysics`).
 * It leads the sprite, which is drawn at the display-delayed interpolated
 * pose. The local turrets AIM at the drawn pose (`buildLocalAimTargets`),
 * and the server aims its own copy of those mounts at the real drone, so:
 *
 *   - "the turret is on the drawn drone" is the client's best predictor of
 *     "the server's beam hits it";
 *   - a beam that ends on the drawn sprite is what the player expects to see.
 *
 * So this ray skips the moving swarm BODIES in predWorld (`World.hitscan`'s
 * `skipId`) and tests those entities analytically at the drawn
 * `entry.x/y/angle` (the single per-frame pose `updateMirror` wrote),
 * using the same shapes as their colliders: the shield circle (hull for a
 * capital) while the shield is up, the hull parts once it is down, the
 * scrap component polygon. Everything else (remote ships, asteroids,
 * structures, walls) is still the predWorld ray. The closest hit wins.
 *
 * The server stays hit-authoritative; this only drives the drawn beam end
 * and the optimistic hit number/flash.
 *
 * Allocation-free per call (#14): one reused result object (callers read it
 * before the next call), bound skip predicate, cached scrap colliders.
 */
import type { PhysicsWorld } from '@core/physics/World';
import type { SwarmRenderState } from '@core/contracts/IRenderer';
import type { Vec2 } from '@core/swarm/asteroidShape';
import { rayHitsSphere, rayHitsConvexPolygon } from '@core/combat/Weapons';
import { shipRayHit } from '@core/combat/shipHitShape';
import { scrapColliderFor } from '@core/geometry/scrapCollider';
import { SWARM_KIND_DRONE, SWARM_KIND_SCRAP, SWARM_KIND_WRECK } from '@shared-types/swarmWireFormat';
import { wreckRayHit } from '@core/destruction/wreckHits';
import type { WreckGeometrySource } from '../net/entity/IClientEntityLeaf.js';
import type { ShipKindId } from '@shared-types/shipKinds';
import type { PredHitscanWorld } from './HitPrediction.client.js';

/** Scrap collider per (parent kind, component), built on first use. */
const scrapColliders = new Map<string, (Vec2[] | null)[]>();

function scrapVertices(parentKind: string, componentIndex: number): Vec2[] | null {
  let byIndex = scrapColliders.get(parentKind);
  if (byIndex === undefined) {
    byIndex = []; // once per parent kind
    scrapColliders.set(parentKind, byIndex);
  }
  let v = byIndex[componentIndex];
  if (v === undefined) {
    v = scrapColliderFor(parentKind as ShipKindId, componentIndex)?.vertices ?? null; // once per component
    byIndex[componentIndex] = v;
  }
  return v;
}

/**
 * Distance along the ray to a drone/scrap at its drawn pose, or null.
 * Shapes mirror the predWorld colliders (`setHullExposed`,
 * `shipShieldColliderDesc`, `scrapClientLeaf`).
 */
export function rayHitsDrawnSwarmEntity(
  e: SwarmRenderState,
  fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number,
  wrecks?: WreckGeometrySource,
): number | null {
  if (e.kind === SWARM_KIND_DRONE) {
    // The SAME hit shape the server uses for this ship, player or NPC
    // (`shipHitShape.ts`, #15): bubble while the shield is up, hull once it
    // is down, a capital's hull either way.
    if (e.shipKind) return shipRayHit(e.shipKind, e.shieldDown !== true, fromX, fromY, dirX, dirY, maxDist, e.x, e.y, e.angle);
    return rayHitsSphere(fromX, fromY, dirX, dirY, maxDist, e.x, e.y, e.radius);
  }
  if (e.kind === SWARM_KIND_SCRAP) {
    const c = rayHitsSphere(fromX, fromY, dirX, dirY, maxDist, e.x, e.y, e.radius);
    if (c === null || !e.shipKind) return c;
    const v = scrapVertices(e.shipKind, e.componentIndex ?? 0);
    if (v === null) return c;
    return rayHitsConvexPolygon(fromX, fromY, dirX, dirY, maxDist, e.x, e.y, e.angle, v);
  }
  if (e.kind === SWARM_KIND_WRECK) {
    // Capital wreck piece (S2b): the same circle-then-convex-parts test the
    // server's weapons use (`wreckRayHit`, #15), on the rebuilt geometry.
    const g = wrecks !== undefined && e.wreckId !== undefined ? wrecks.piece(e.wreckId, e.componentIndex ?? 0) : null;
    if (g === null) return null;
    return wreckRayHit(g.parts, g.radius, fromX, fromY, dirX, dirY, maxDist, e.x, e.y, e.angle);
  }
  return null;
}

export class DisplayPoseHitscan implements PredHitscanWorld {
  /** Set by the owner before use (the predWorld is created after join). */
  world: PhysicsWorld | null = null;
  swarm: ReadonlyMap<number, SwarmRenderState> | undefined = undefined;
  /** Capital wreck geometry (S2b), for wreck pieces' drawn-pose test. */
  wrecks: WreckGeometrySource | undefined = undefined;

  private readonly result = { hitId: '', dist: 0 };
  private readonly skip = (id: string): boolean => this.movingKeys.has(id);

  constructor(
    /** Body keys of the moving swarm entities that have a predWorld body. */
    private readonly movingKeys: ReadonlySet<string>,
    /** entityId → `swarm-${id}` (the same cache the bodies are keyed by). */
    private readonly keyCache: ReadonlyMap<number, string>,
  ) {}

  hitscan(
    fromX: number, fromY: number, dirX: number, dirY: number,
    maxDist: number, excludeId: string,
  ): { hitId: string; dist: number } | null {
    const world = this.world;
    if (world === null) return null;
    const h = world.hitscan(fromX, fromY, dirX, dirY, maxDist, excludeId, this.skip);
    let bestId: string | null = null;
    let bestDist = maxDist;
    if (h !== null) {
      bestId = h.hitId;
      bestDist = h.dist;
    }
    const swarm = this.swarm;
    if (swarm !== undefined && this.movingKeys.size > 0) {
      for (const [entityId, e] of swarm) {
        if (e.kind !== SWARM_KIND_DRONE && e.kind !== SWARM_KIND_SCRAP && e.kind !== SWARM_KIND_WRECK) continue;
        const key = this.keyCache.get(entityId);
        // Only entities that have a collision body count (as before).
        if (key === undefined || key === excludeId || !this.movingKeys.has(key)) continue;
        const d = rayHitsDrawnSwarmEntity(e, fromX, fromY, dirX, dirY, bestDist, this.wrecks);
        if (d !== null && (bestId === null || d < bestDist)) {
          bestDist = d;
          bestId = key;
        }
      }
    }
    if (bestId === null) return null;
    this.result.hitId = bestId;
    this.result.dist = bestDist;
    return this.result;
  }
}
