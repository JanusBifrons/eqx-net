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
import { placementChosen } from './placementChosen.js';
import { logEvent } from '../debug/ClientLogger.js';

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
  /** True ⇒ this is the dim "sent, awaiting the server entity" ghost shown
   *  AFTER Confirm (playtest 2026-06-10 Issue 7), not the live positioning
   *  ghost. The renderer dims it and stops capturing pointers for it. */
  pending?: boolean;
}

/**
 * A confirmed-but-not-yet-visible placement (playtest 2026-06-10 Issue 7 — "when
 * you place a structure it just kinda vanishes then appears after a second or
 * two"). The client used to clear the ghost the instant Confirm sent
 * `place_structure`, leaving a gap (RTT + snapshot cadence) where neither the
 * ghost nor the real structure was visible. We keep a DIM ghost at the sent
 * point until the structure lands (the structures-slice count grows) or a
 * timeout elapses.
 */
export interface PendingPlacement {
  kind: StructureKindId;
  x: number;
  y: number;
  /** `Date.now()` when `place_structure` was sent. */
  sentAtMs: number;
  /** `mirror.structures.size` at send time — the dim ghost clears once it grows
   *  (a new structure appeared) without needing the assigned entityId back. */
  baselineStructureCount: number;
}

/** Window to hold the dim "sent, awaiting server" ghost before giving up.
 *  Covers RTT + snapshot cadence with margin; clears earlier the moment the
 *  structure actually lands. */
export const PENDING_PLACEMENT_TIMEOUT_MS = 3000;

/**
 * True when the confirmed placement ghost should stop showing: the structure is
 * now actually RENDERABLE (the slice count grew past baseline AND every
 * structure in the slice has a swarm pose) OR the timeout elapsed.
 *
 * `allStructuresRenderable` is the load-bearing addition (R2.1): a structure
 * sprite is drawn ONLY when its entityId is present in the binary swarm channel
 * (`mirror.swarm`, kind 2), but the JSON structures slice (`mirror.structures`)
 * that grows the count arrives on a SEPARATE channel with independent timing.
 * Clearing on count-grew alone left a window where the slice had grown but the
 * swarm pose hadn't landed yet — neither ghost nor sprite drawn → the
 * "vanishes then reappears after a second or two" bug. Gating on renderability
 * makes the clear-gate the SAME condition as the render-gate. The timeout
 * remains an upper bound so a rejected / AOI-evicted placement never strands the
 * ghost forever.
 */
export function pendingPlacementResolved(
  pending: PendingPlacement,
  nowMs: number,
  currentStructureCount: number,
  allStructuresRenderable: boolean,
): boolean {
  if (currentStructureCount > pending.baselineStructureCount && allStructuresRenderable) return true;
  return nowMs - pending.sentAtMs >= PENDING_PLACEMENT_TIMEOUT_MS;
}

/** Outcome of {@link resolvePlacementPreviewStatus}. `active` = live positioning
 *  ghost; `pending` = dim post-Confirm ghost (both mutate the `out` scratch);
 *  `cleared` = a pending ghost just resolved, caller drops its record + the
 *  mirror preview; `none` = nothing to show. */
export type PlacementPreviewStatus = 'active' | 'pending' | 'cleared' | 'none';

/**
 * Decide this frame's placement-preview ghost, mutating `out` in place when one
 * should show (alloc-free per frame — invariant #14). Priority: a live
 * `placementKind` (positioning) beats a `pending` (sent-awaiting) ghost. Pure so
 * the active/pending/clear branches + the timeout/count logic are unit-locked
 * without a renderer or live room (the level the Issue-7 gap bug lives at).
 */
export function resolvePlacementPreviewStatus(
  placementKind: StructureKindId | null,
  localShip: ShipPose | null,
  pending: PendingPlacement | null,
  nowMs: number,
  currentStructureCount: number,
  allStructuresRenderable: boolean,
  out: PlacementPreview,
): PlacementPreviewStatus {
  if (placementKind && localShip) {
    const pos = computePlacementPose(localShip, placementKind);
    out.kind = placementKind;
    out.x = pos.x;
    out.y = pos.y;
    out.angle = 0;
    out.pending = false;
    return 'active';
  }
  if (pending) {
    if (pendingPlacementResolved(pending, nowMs, currentStructureCount, allStructuresRenderable)) {
      return 'cleared';
    }
    out.kind = pending.kind;
    out.x = pending.x;
    out.y = pending.y;
    out.angle = 0;
    out.pending = true;
    return 'pending';
  }
  return 'none';
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
  const localId = client.mirror.localPlayerId;
  if (!localId) return false;
  const ship = client.mirror.ships.get(localId);
  if (!ship) return false;
  const pos = computePlacementPose({ x: ship.x, y: ship.y, angle: ship.angle }, kindId);
  return placeStructureAt(kindId, pos.x, pos.y);
}

/**
 * Place a structure of `kindId` at an EXPLICIT world position (the tap/drag-
 * positioned blueprint ghost — 2026-06-07). Returns true if the message was
 * sent (false when there's no live room yet).
 */
export function placeStructureAt(kindId: StructureKindId, x: number, y: number): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('place_structure', { type: 'place_structure', kind: kindId, x, y });
  // Keep a dim ghost at the sent point until the structure lands, so the
  // blueprint doesn't vanish for ~1 s (playtest 2026-06-10 Issue 7).
  client.notePendingPlacement(kindId, x, y);
  return true;
}

/**
 * Commit a placement at the player's currently-CHOSEN world point (the
 * production `placementChosen` channel gameRafLoop writes every frame while the
 * ghost is up), falling back to the ahead-of-ship pose if the player confirmed
 * before positioning. The SINGLE commit path shared by BOTH the touch Confirm
 * banner AND the WS-10 (R2.5) desktop one-click place — so the log + send +
 * pending-ghost behaviour is identical regardless of how the player committed.
 * Does NOT clear `placementKind` (Zustand) — the caller owns that, since the
 * banner reads it via a hook and gameRafLoop via `getState()`.
 */
export function commitChosenPlacement(kindId: StructureKindId): void {
  const cx = placementChosen.worldX;
  const cy = placementChosen.worldY;
  const hasChosen = cx !== null && cy !== null;
  logEvent('structure_place_confirm', {
    kind: kindId,
    hasChosen,
    x: cx,
    y: cy,
    stuck: placementChosen.stuck,
  });
  if (hasChosen) {
    placeStructureAt(kindId, cx, cy);
  } else {
    placeStructureAhead(kindId);
  }
}
