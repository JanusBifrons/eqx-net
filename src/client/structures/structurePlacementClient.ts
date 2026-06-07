/**
 * Client-side structure placement (speed-dial-resource-structures plan,
 * Phase 2). Translates a "build this kind" intent into a `place_structure`
 * message at a world position.
 *
 * Coordinate model (the plan's documented FALLBACK, shipped first): the
 * structure drops a fixed offset AHEAD of the local ship's current pose. This
 * needs no render-worker camera transform, so it works on every render path
 * (worker + main-thread) and is unit-testable. The full tap-to-position
 * blueprint ghost (with the connection-range ring + live valid/invalid tint)
 * is a follow-up that layers on top of the same `place_structure` send.
 *
 * The pure `computePlacementPose` is split out so the geometry is testable
 * without a live room.
 */
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { getGameClient } from '../net/clientSingleton.js';

/** Gap (world units) between the ship's leading edge and the new structure's
 *  edge when dropping ahead. Keeps the blueprint clear of the hull collider. */
export const PLACEMENT_AHEAD_GAP = 60;

export interface ShipPose {
  x: number;
  y: number;
  angle: number;
}

/**
 * World position a `kindId` structure should drop at, a fixed clearance ahead
 * of `ship`. Forward is `(-sin θ, cos θ)` — the same convention the thrust /
 * fire ray use across the codebase.
 */
export function computePlacementPose(ship: ShipPose, kindId: StructureKindId): { x: number; y: number } {
  const kind = getStructureKind(kindId);
  // Ship hull radius is ~12u (SHIP_HITBOX_RADIUS); clear that + the structure
  // radius + a gap so the blueprint never overlaps the ship.
  const dist = 12 + kind.radius + PLACEMENT_AHEAD_GAP;
  const fx = -Math.sin(ship.angle);
  const fy = Math.cos(ship.angle);
  return { x: ship.x + fx * dist, y: ship.y + fy * dist };
}

/** Structure placement preview — the pose + kind the render mirror carries so
 *  the renderer can draw a translucent blueprint ghost (smoke handoff
 *  2026-06-06, Issue 5). Pure data shape, structured-cloneable for the worker. */
export interface PlacementPreview {
  kind: StructureKindId;
  x: number;
  y: number;
  angle: number;
}

/**
 * Build the placement preview for `kindId` at the ahead-of-ship pose, or `null`
 * when there's nothing to preview (`kindId` is null). Split out pure so the
 * geometry + null-gating is unit-testable without a renderer. `angle` is 0:
 * structures render as regular polygons (no meaningful facing), matching the
 * static structure sprite. Reuses `computePlacementPose` so the ghost lands at
 * EXACTLY the spot `placeStructureAhead` will send (no preview/commit drift).
 */
export function computePlacementPreview(
  ship: ShipPose,
  kindId: StructureKindId | null,
): PlacementPreview | null {
  if (!kindId) return null;
  const pos = computePlacementPose(ship, kindId);
  return { kind: kindId, x: pos.x, y: pos.y, angle: 0 };
}

/**
 * Place a structure of `kindId` ahead of the local ship. Returns true if the
 * message was sent (false when there's no live room / local ship yet).
 */
export function placeStructureAhead(kindId: StructureKindId): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  const localId = client.mirror.localPlayerId;
  if (!localId) return false;
  const ship = client.mirror.ships.get(localId);
  if (!ship) return false;

  const pos = computePlacementPose({ x: ship.x, y: ship.y, angle: ship.angle }, kindId);
  room.send('place_structure', { type: 'place_structure', kind: kindId, x: pos.x, y: pos.y });
  return true;
}
