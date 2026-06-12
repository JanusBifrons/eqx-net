import RAPIER from '@dimforge/rapier2d-compat';

/**
 * Pure hitscan helper — extracted from `World.hitscan` so the
 * RAPIER.castRay-API surface lives in one place. Exclude semantics
 * match the original method: `excludeBody` is the rigid body of the
 * shooter; collider sensors are excluded; the first non-shooter
 * collider hit returns its `(hitId, dist)`.
 *
 * Returns `null` when no body is along the ray within `maxDist` OR
 * when the hit collider's parent body has no entry in `handleToId`
 * (stale despawn race — silently no-op rather than throw).
 *
 * Rapier's `castRay` API specifics — see src/core/CLAUDE.md "Rapier
 * castRay API" — the exclude param is a `RigidBody` object (not a
 * handle number); `hit.collider` is already a `Collider`; the toi
 * field is `timeOfImpact`.
 */
export function castHitscan(
  world: RAPIER.World,
  handleToId: ReadonlyMap<number, string>,
  fromX: number,
  fromY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  excludeBody: RAPIER.RigidBody | undefined,
  /** Optional wall-body handle → `wall-${id}` sentinel map. Shield-wall span
   *  bodies are deliberately kept OUT of `handleToId` (they are static,
   *  slot-less, pose-broadcast-free — see World.ts) but a beam must still
   *  TERMINATE at an up wall (R2.28). When `handleToId` misses, this map
   *  resolves a wall hit to its sentinel id. A DISABLED (down) wall is excluded
   *  from `castRay` by Rapier, so it is naturally passable. */
  wallHandleToId?: ReadonlyMap<number, string>,
): { hitId: string; dist: number } | null {
  const ray = new RAPIER.Ray({ x: fromX, y: fromY }, { x: dirX, y: dirY });
  const hit = world.castRay(
    ray,
    maxDist,
    true,
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    undefined,
    excludeBody,
  );
  if (!hit) return null;
  const parentBody = hit.collider.parent();
  if (!parentBody) return null;
  const hitId = handleToId.get(parentBody.handle) ?? wallHandleToId?.get(parentBody.handle);
  if (!hitId) return null;
  return { hitId, dist: hit.timeOfImpact };
}
