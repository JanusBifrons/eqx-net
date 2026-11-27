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
import {
  getStructureKind, isStructureQuarterTurnOnly, normaliseStructureQuarterTurn, normaliseStructureRotation,
  playerStructureRotationStep, snapPlayerStructureRotation, type StructureKindId,
} from '../../shared-types/structureKinds.js';
import { useUIStore } from '../state/store.js';

/** Phase V — the placement ghost's rotation in degrees, cycled with R: quarter
 *  turns, or 30° steps on a `deck` room (base platforms). Module state (a
 *  discrete selection; renderer reads it through the placement preview's
 *  `angle`). */
let placementRotationDeg = 0;
export function getPlacementRotationDeg(): number {
  return placementRotationDeg;
}
export function setPlacementRotationDeg(deg: number): void {
  placementRotationDeg = normaliseStructureRotation(deg);
}
/** Rotate the ghost one step (R / the strip's Rotate): a quarter turn, or 30°
 *  when the room's `deck` flag is on, except for a quarter-turn-only kind
 *  (gates, teleporters: `isStructureQuarterTurnOnly`). The server snaps by
 *  the same rule (`snapPlayerStructureRotation`). Returns the new rotation. */
export function cyclePlacementRotation(
  deck: boolean = useUIStore.getState().deck,
  kind: string | null = useUIStore.getState().placementKind,
): number {
  placementRotationDeg = snapPlayerStructureRotation(
    placementRotationRaw(kind) + playerStructureRotationStep(deck, kind), deck, kind,
  );
  return placementRotationDeg;
}
/** The turn a `kind` ghost is drawn and sent at: the held rotation, snapped
 *  to a quarter for a quarter-turn-only kind (a 30° turn held from another
 *  kind never reaches a gate). Matches the server's per-kind snap. */
export function placementRotationFor(kind: string | null | undefined): number {
  return placementRotationRaw(kind);
}
function placementRotationRaw(kind: string | null | undefined): number {
  return isStructureQuarterTurnOnly(kind) ? normaliseStructureQuarterTurn(placementRotationDeg) : placementRotationDeg;
}
/** Build mirror (base loop 4B): place the next building left-right flipped.
 *  Module state beside the rotation (a discrete choice the renderer reads
 *  through the preview's `mirror`); rides `place_structure.mirror`. */
let placementMirror = false;
export function getPlacementMirror(): boolean {
  return placementMirror;
}
export function setPlacementMirror(on: boolean): void {
  placementMirror = on;
}
/** Flip the ghost left-right (F / the banner's Mirror button). Returns the new choice. */
export function togglePlacementMirror(): boolean {
  placementMirror = !placementMirror;
  return placementMirror;
}
/** Desktop placement keys (main-thread `App.tsx` keydown, only while placing):
 *  R rotates one step (a quarter turn; 30° on a deck room), F mirrors. True when the key was handled. */
export function handlePlacementKey(key: string): boolean {
  const k = key.toLowerCase();
  if (k === 'r') cyclePlacementRotation();
  else if (k === 'f') togglePlacementMirror();
  else return false;
  return true;
}
const DEG = Math.PI / 180;
import { getGameClient } from '../net/clientSingleton.js';
import { writePreviewRun } from './pendingPlacementRun.js';
import { placementChosen, setPlacementHeld } from './placementChosen.js';
import { addPlannedPlacement, plannedPlacementHitIndex, writePreviewPlan, type PlannedPlacement } from './placementPlan.js';
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
  /** Build mirror: draw (and link) the ghost left-right flipped. */
  mirror?: boolean;
  /** True ⇒ this is the dim "sent, awaiting the server entity" ghost shown
   *  AFTER Confirm (playtest 2026-06-10 Issue 7), not the live positioning
   *  ghost. The renderer dims it and stops capturing pointers for it. */
  pending?: boolean;
  /** Live ghost only: true while it still sits on the placement just sent
   *  (`isHeldOnSent`). Drawn dim with no verdict; never sets `pending`, so
   *  pointer capture stays on. */
  held?: boolean;
  /** Room flag `deck` (base platforms): the live ghost snaps to its deck slot. */
  deck?: boolean;
  /** Deck rooms only: the local player (whose deck the ghost must stand on)… */
  deckOwner?: string;
  /** …and their plates, flat (i, j) pairs ({@link writePreviewDeck}). */
  deckPlates?: number[];
  /** Fence run: the sent posts not yet landed (`PendingPlacement.run`), flat
   *  (x, y) corners, a NaN pair between clicks. Empty when none. */
  run?: number[];
  /** Fence run hover (`fenceRunHover.ts`): the corners a click at the hovered
   *  corner would reach, flat (x, y) in path order. Never in `run` (the click
   *  reads `run` as built). Empty when none. */
  runHover?: number[];
  /** One per `runHover` corner: 0 = a post is there (beam only), 1 = a post
   *  the click would place, 2 = the one it would place but the server refuses. */
  runHoverMark?: number[];
  /** Plan then Build: the planned buildings, flat stride 5 (`writePreviewPlan`).
   *  Empty when none. */
  plan?: number[];
}

/** The plate source the preview copies from (`ColyseusClient.plates`). */
export interface PreviewPlateSource {
  platesInto(owner: string, out: number[]): number[];
}

/**
 * Base platforms: stamp the room's deck flag and, on a deck room, the local
 * player's plates onto the preview, so the (possibly worker) renderer's ghost
 * runs the same `off-deck` rule as the server. Reuses the preview's array (#14).
 */
export function writePreviewDeck(out: PlacementPreview, deck: boolean, plates: PreviewPlateSource | null, owner: string | null): void {
  out.deck = deck;
  if (!deck || plates === null) {
    out.deckOwner = undefined;
    if (out.deckPlates) out.deckPlates.length = 0;
    return;
  }
  out.deckOwner = owner ?? '';
  out.deckPlates = plates.platesInto(out.deckOwner, out.deckPlates ?? []);
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
  /** Rotation (degrees) the structure was sent with. */
  rot?: number;
  /** Build mirror the structure was sent with. */
  mirror?: boolean;
  /** `Date.now()` when `place_structure` was sent. */
  sentAtMs: number;
  /** `mirror.structures.size` at send time — the dim ghost clears once it grows
   *  (a new structure appeared) without needing the assigned entityId back. */
  baselineStructureCount: number;
  /** Fence run (`fenceRun.ts`): places sent since the baseline (absent = 1);
   *  the record resolves once that many structures landed. */
  sent?: number;
  /** Fence run: the run's corners to draw (`PlacementPreview.run`). */
  run?: number[];
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
  if (currentStructureCount >= pending.baselineStructureCount + (pending.sent ?? 1) && allStructuresRenderable) return true;
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
  chosenX: number | null = null,
  chosenY: number | null = null,
): PlacementPreviewStatus {
  if (placementKind && localShip) {
    const pos = computePlacementPose(localShip, placementKind);
    out.kind = placementKind;
    out.x = pos.x;
    out.y = pos.y;
    out.angle = placementRotationFor(placementKind) * DEG;
    out.mirror = placementMirror;
    out.pending = false;
    out.held = isHeldOnSent(placementKind, pending, chosenX, chosenY) || isHeldOnPlanned(placementKind, chosenX, chosenY);
    const live = pending !== null && !pendingPlacementResolved(pending, nowMs, currentStructureCount, allStructuresRenderable);
    writePreviewRun(out, live ? pending : null);
    writePreviewPlan(out); // plan then Build: the planned ghosts + their verdict footprints
    return 'active';
  }
  planHold.active = false; // not placing: the hold on the last planned spot ends
  if (pending) {
    if (pendingPlacementResolved(pending, nowMs, currentStructureCount, allStructuresRenderable)) {
      return 'cleared';
    }
    out.kind = pending.kind;
    out.x = pending.x;
    out.y = pending.y;
    out.angle = (pending.rot ?? 0) * DEG;
    out.mirror = pending.mirror === true;
    out.pending = true;
    out.held = false;
    writePreviewRun(out, pending);
    writePreviewPlan(out);
    return 'pending';
  }
  return 'none';
}

/**
 * True when the live ghost still sits on the placement just sent: same chosen
 * point (exact: both come from the same renderer feedback value), kind,
 * rotation and mirror. Placing keeps going after Place, so without this the
 * next ghost reads red "too close" on its own new structure. Any pointer move,
 * rotate, mirror or kind change frees it. The ahead-of-ship fallback has no
 * chosen point, so it is never held.
 */
export function isHeldOnSent(
  kind: StructureKindId,
  sent: PendingPlacement | null,
  chosenX: number | null,
  chosenY: number | null,
): boolean {
  return sent !== null && chosenX !== null && chosenY !== null
    && sent.kind === kind && sent.x === chosenX && sent.y === chosenY
    && (sent.rot ?? 0) === placementRotationFor(kind) && (sent.mirror === true) === placementMirror;
}

/** Plan then Build: the spot just planned (the chosen point, turn and
 *  mirror at the Place), held like a sent one until the ghost leaves it. */
const planHold: PendingPlacement & { active: boolean; built: boolean } = {
  kind: 'connector', x: 0, y: 0, rot: 0, mirror: false, sentAtMs: 0, baselineStructureCount: 0, active: false, built: false,
};

/**
 * Plan then Build: is the live ghost still on the spot just PLANNED? The
 * same rule as {@link isHeldOnSent} (dim, no verdict, Place refused), so the
 * ghost never reads red on its own new planned building and a second Place
 * (a double-click) does nothing. Once the ghost leaves the spot the hold
 * ends for good: coming back is a Place ON a planned building (it removes it).
 */
export function isHeldOnPlanned(kind: StructureKindId, chosenX: number | null, chosenY: number | null): boolean {
  if (!planHold.active) return false;
  // While that building is still planned (a cleared plan ends it), or once
  // Build sent it: then it is held like a sent Place, on its own new building.
  if (isHeldOnSent(kind, planHold, chosenX, chosenY) && (planHold.built || plannedPlacementHitIndex(chosenX, chosenY) >= 0)) return true;
  planHold.active = false;
  return false;
}

/** Hold the live ghost on the spot just planned (`commitChosenPlacement`;
 *  a fence run's `commitFenceRun`, on its last planned post or gate). */
export function holdOnPlanned(kind: StructureKindId, x: number, y: number): void {
  planHold.kind = kind; planHold.x = x; planHold.y = y;
  planHold.rot = placementRotationFor(kind); planHold.mirror = placementMirror;
  planHold.active = true;
  planHold.built = false;
}

/** Build sent the plan: the hold on the last planned spot stays until the
 *  ghost leaves it, as after a sent Place (never red on its own building). */
export function holdPlanSent(): void {
  planHold.built = true;
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
  return { kind: kindId, x: pos.x, y: pos.y, angle: placementRotationFor(kindId) * DEG, mirror: placementMirror };
}

/**
 * Plan a structure of `kindId` ahead of the local ship (the commit path with
 * no chosen point yet). Returns true if it was planned (false when there's no
 * local ship yet, or the plan refused it).
 */
export function planStructureAhead(kindId: StructureKindId): boolean {
  const client = getGameClient();
  if (!client) return false;
  const localId = client.mirror.localPlayerId;
  if (!localId) return false;
  const ship = client.mirror.ships.get(localId);
  if (!ship) return false;
  const pos = computePlacementPose({ x: ship.x, y: ship.y, angle: ship.angle }, kindId);
  return planStructureAt(kindId, pos.x, pos.y);
}

/** Plan then Build: add `kindId` at (x, y) with the held turn and mirror to
 *  the planned list (`placementPlan.ts`), snapped as the server will place it. */
export function planStructureAt(kindId: StructureKindId, x: number, y: number): boolean {
  return addPlannedPlacement(kindId, x, y, placementRotationFor(kindId), placementMirror, useUIStore.getState().deck);
}

/** Reused `place_structures` message (Colyseus encodes it on send, #14). */
const placeStructuresMsg: { type: 'place_structures'; batchId: number; items: readonly PlannedPlacement[] } = { type: 'place_structures', batchId: 0, items: [] };

/**
 * Plan then Build: send every planned building as ONE `place_structures`
 * (all or nothing on the server; it replies `place_structures_refused` or
 * `place_structures_placed`, each echoing `batchId`). `items` are already
 * snapped wire items (`placementPlan.ts`). Returns whether
 * it was sent (false with no live room or nothing to send).
 */
export function sendPlaceStructures(items: readonly PlannedPlacement[], batchId: number): boolean {
  if (items.length === 0) return false;
  const room = getGameClient()?.getRoom();
  if (!room) return false;
  placeStructuresMsg.batchId = batchId;
  placeStructuresMsg.items = items;
  room.send('place_structures', placeStructuresMsg);
  return true;
}

/**
 * Commit a placement at the player's currently-CHOSEN world point (the
 * production `placementChosen` channel gameRafLoop writes every frame while the
 * ghost is up), falling back to the ahead-of-ship pose if the player confirmed
 * before positioning. The SINGLE commit path shared by BOTH the touch Confirm
 * banner AND the WS-10 (R2.5) desktop one-click place — so the log + plan
 * behaviour is identical regardless of how the player committed. Plan then
 * Build: it ADDS the building to the planned list (`placementPlan.ts`); the
 * strip's Build sends the list. Does NOT clear `placementKind` (Zustand) — the caller owns that, since the
 * banner reads it via a hook and gameRafLoop via `getState()`.
 *
 * Plans nothing while the ghost is blocked (`placementChosen.rejection`, the
 * server's own `placementRejection` at the drawn pose): the server would
 * refuse it (#15). Returns whether a placement was planned.
 */
export function commitChosenPlacement(kindId: StructureKindId): boolean {
  if (placementChosen.held) {
    // The ghost still sits on the placement just sent: a second Place there
    // would only be refused (the desktop click re-sets the same point).
    logEvent('structure_place_blocked', { kind: kindId, reason: 'held' });
    return false;
  }
  if (placementChosen.rejection !== null) {
    logEvent('structure_place_blocked', { kind: kindId, reason: placementChosen.rejection });
    return false;
  }
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
  if (!hasChosen) return planStructureAhead(kindId);
  const planned = planStructureAt(kindId, cx, cy);
  // Hold at once so a second click in the same frame cannot re-plan (the plan
  // also refuses the same pose twice).
  if (planned) { holdOnPlanned(kindId, cx, cy); setPlacementHeld(true); }
  return planned;
}
