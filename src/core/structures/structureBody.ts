/**
 * Hologram pass-through (base loop 3F / 3F2): is a structure's physics body
 * solid? The ONE rule the server physics, the client prediction world and the
 * navigation obstacles all read, so a ship flies through a hologram on every
 * side or on none.
 *
 * A placed blueprint spawns as a ghost body (`BLUEPRINT_COLLISION_GROUPS`,
 * collides with nothing). It turns solid only once it is built AND no ship is
 * inside its footprint (`server/structures/blueprintBody.ts`). The server
 * record carries that as `ghostBody`; the client reads the same fact from the
 * room-state row (`STRUCTURE_FLAG_GHOST_BODY` → `StructureRenderState.ghostBody`).
 * `isConstructed` alone is NOT the signal: a finished blueprint waits as a
 * ghost while a ship is inside, and a structure mid-upgrade is unbuilt but
 * solid.
 */
import { BLUEPRINT_COLLISION_GROUPS, DEFAULT_COLLISION_GROUPS } from '../physics/collisionGroups.js';

/** The one fact the rule reads (a server `StructureRecord` or a client row). */
export interface StructureBodyFacts {
  /** True while the body is still a blueprint ghost. Absent ⇒ solid. */
  ghostBody?: boolean;
}

/** True when the structure's body collides (ships, rocks, scrap bounce off it
 *  and routes go round it); false while it is a hologram. */
export function isStructureBodySolid(s: StructureBodyFacts): boolean {
  return s.ghostBody !== true;
}

/** The collider groups a structure's body has under the rule. */
export function structureBodyCollisionGroups(s: StructureBodyFacts): number {
  return isStructureBodySolid(s) ? DEFAULT_COLLISION_GROUPS : BLUEPRINT_COLLISION_GROUPS;
}
