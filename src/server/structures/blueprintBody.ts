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
 * A pre-built kind (the Capital) placed round a ship starts the same way:
 * built, but a hologram until the space is clear, and the parked hulls inside
 * are ordered out (`moveParkedHullsClear`), so nothing is left inside a hull.
 *
 * The rule is the shared `isStructureBodySolid` (core): the room-state row
 * carries it to the client prediction world (`STRUCTURE_FLAG_GHOST_BODY`) and
 * navigation reads it too (`RoomNav`), so all three agree.
 */
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { isStructureBodySolid } from '../../core/structures/structureBody.js';
import { isFlatDeckKind } from '../../shared-types/structureKinds.js';

/** A ship hull as a circle (`SectorObstacles.hullCircles`). */
export interface HullCircle { x: number; y: number; r: number }

export interface BlueprintBodyHooks {
  /** Every ship hull in the sector (AI ships, pilots' ships, parked hulls). */
  shipHulls?(): readonly HullCircle[];
  /** Swap the body to solid collider groups (and attach its rig). */
  solidify?(id: string): void;
  /** Told when a body turns solid (navigation adds it as an obstacle). */
  registry?: Pick<StructureRegistry, 'bodyChanged'>;
}

/** The footprint fields the overlap test reads. */
export type FootprintBox = Pick<StructureRecord, 'x' | 'y' | 'radius' | 'halfW' | 'halfH'>;

/** True when a circle overlaps the structure's footprint box (conservative:
 *  a teleporter pad or gate gap counts as covered). */
export function hullOverlapsFootprint(rec: FootprintBox, c: HullCircle): boolean {
  const hw = rec.halfW ?? rec.radius;
  const hh = rec.halfH ?? rec.radius;
  const dx = Math.max(Math.abs(c.x - rec.x) - hw, 0);
  const dy = Math.max(Math.abs(c.y - rec.y) - hh, 0);
  return dx * dx + dy * dy < c.r * c.r;
}

/** True while any ship hull overlaps `rec`'s footprint. */
export function shipInsideFootprint(rec: FootprintBox, hooks: Pick<BlueprintBodyHooks, 'shipHulls'>): boolean {
  const hulls = hooks.shipHulls?.();
  if (!hulls) return false;
  for (let i = 0; i < hulls.length; i++) if (hullOverlapsFootprint(rec, hulls[i]!)) return true;
  return false;
}

/**
 * Turn `rec`'s blueprint body solid if no ship is inside it. Returns true when
 * the body is solid (already was, or just turned), false while it must wait.
 * A flat deck tile (road) never turns solid: ships fly over it for good, so it
 * counts as settled while its body stays a hologram.
 */
export function settleBlueprintBody(rec: StructureRecord, hooks: BlueprintBodyHooks): boolean {
  if (isStructureBodySolid(rec) || isFlatDeckKind(rec.kind)) return true;
  if (shipInsideFootprint(rec, hooks)) return false;
  rec.ghostBody = false;
  hooks.solidify?.(rec.id);
  hooks.registry?.bodyChanged(rec);
  return true;
}

/** What {@link moveParkedHullsClear} reads from the room. */
export interface ParkedHullClearHost {
  /** Parked (lingering) hulls' live poses, by shipInstanceId. */
  lingeringPoses: ReadonlyMap<string, { x: number; y: number }>;
  /** The hull's owner and kind (room-state ship row). */
  ship(shipId: string): { playerId: string; kind: string } | undefined;
  /** A ship kind's hull extent (the `hullCircles` radius). */
  extentOf(kind: string): number | undefined;
  /** The room's `landingPoint` (the owner's other ships count as obstacles). */
  landingPoint(playerId: string, x: number, y: number, kind: string, onlySkipShipId: string): { x: number; y: number };
  /** The owner's ordinary fleet order (`FleetCommandSubsystem.applyOrder`). */
  applyOrder(ownerId: string, shipIds: readonly string[], order: { kind: 'move'; x: number; y: number }): readonly string[];
}

/**
 * A structure placed round parked hulls (base loop: a Capital unpacked over
 * the Fighter parked in Command view): each parked hull inside the footprint
 * gets its owner's Move order to the nearest clear spot, the same order a
 * player gives. It flies out through the hologram; the grid pulse then turns
 * the structure solid (`settleBuiltGhosts` / `settleBlueprintBody`).
 * Returns how many hulls took the order. Discrete (a placement), not per tick.
 */
export function moveParkedHullsClear(rec: FootprintBox, host: ParkedHullClearHost): number {
  let moved = 0;
  for (const [shipId, pose] of host.lingeringPoses) {
    const ship = host.ship(shipId);
    if (ship === undefined || !ship.playerId || !ship.kind) continue;
    const r = host.extentOf(ship.kind);
    if (r === undefined || !hullOverlapsFootprint(rec, { x: pose.x, y: pose.y, r })) continue;
    const to = host.landingPoint(ship.playerId, pose.x, pose.y, ship.kind, shipId);
    if (host.applyOrder(ship.playerId, [shipId], { kind: 'move', x: to.x, y: to.y }).length > 0) moved++;
  }
  return moved;
}

/** Settle every record that is built but still has a blueprint body (built
 *  outside the grid pulse: a restored save, a seeded base or scenario). */
export function settleBuiltGhosts(records: Iterable<StructureRecord>, hooks: BlueprintBodyHooks): void {
  for (const rec of records) if (rec.isConstructed && !isStructureBodySolid(rec)) settleBlueprintBody(rec, hooks);
}
