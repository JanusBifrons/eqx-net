/**
 * Hologram pass-through (base loop 3F, server side).
 *
 * A placed structure that is not built yet spawns with a body in
 * `BLUEPRINT_COLLISION_GROUPS`: ships fly through it while it fills in from
 * the bank. Its space stays reserved, because placement overlap-checks the
 * structure registry, not the physics world.
 *
 * It turns solid (default collider groups) only when no ship is inside its
 * footprint, so finishing never shoves or traps a ship. A blueprint whose
 * build is complete but whose space is occupied simply waits: the grid pulse
 * retries each beat and it finishes the moment the space is clear.
 *
 * The client still predicts the hologram as solid until job 3F2, so the local
 * ship may stutter through one; the server is authoritative.
 */
import type { StructureRecord } from './StructureRegistry.js';

/** A ship hull as a circle (`SectorObstacles.hullCircles`). */
export interface HullCircle { x: number; y: number; r: number }

export interface BlueprintBodyHooks {
  /** Every ship hull in the sector (AI ships, pilots' ships, parked hulls). */
  shipHulls?(): readonly HullCircle[];
  /** Swap the body to solid collider groups (and attach its rig). */
  solidify?(id: string): void;
}

/** True when a circle overlaps the structure's footprint box (conservative:
 *  a teleporter pad or gate gap counts as covered). */
export function hullOverlapsFootprint(rec: StructureRecord, c: HullCircle): boolean {
  const hw = rec.halfW ?? rec.radius;
  const hh = rec.halfH ?? rec.radius;
  const dx = Math.max(Math.abs(c.x - rec.x) - hw, 0);
  const dy = Math.max(Math.abs(c.y - rec.y) - hh, 0);
  return dx * dx + dy * dy < c.r * c.r;
}

/** True while any ship hull overlaps `rec`'s footprint. */
export function shipInsideFootprint(rec: StructureRecord, hooks: BlueprintBodyHooks): boolean {
  const hulls = hooks.shipHulls?.();
  if (!hulls) return false;
  for (let i = 0; i < hulls.length; i++) if (hullOverlapsFootprint(rec, hulls[i]!)) return true;
  return false;
}

/**
 * Turn `rec`'s blueprint body solid if no ship is inside it. Returns true when
 * the body is solid (already was, or just turned), false while it must wait.
 */
export function settleBlueprintBody(rec: StructureRecord, hooks: BlueprintBodyHooks): boolean {
  if (rec.ghostBody !== true) return true;
  if (shipInsideFootprint(rec, hooks)) return false;
  rec.ghostBody = false;
  hooks.solidify?.(rec.id);
  return true;
}

/** Settle every record that is built but still has a blueprint body (built
 *  outside the grid pulse: a restored save, a seeded base or scenario). */
export function settleBuiltGhosts(records: Iterable<StructureRecord>, hooks: BlueprintBodyHooks): void {
  for (const rec of records) if (rec.isConstructed && rec.ghostBody === true) settleBlueprintBody(rec, hooks);
}
