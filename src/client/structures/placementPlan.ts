/**
 * Plan then Build: the PLANNED list. In build mode every Place (✓, the
 * desktop click: `commitPlacement`) adds the building here instead of sending
 * it; Build (`buildPlacementPlan`, placementCancel.ts) sends the whole list as
 * one `place_structures` (all or nothing). ✕ and leaving build mode clear it.
 *
 * Storage only: the items and a refused flag each. Each item holds the pose
 * the SERVER will place it at (the same snap its `place_structures` handler
 * runs: `snapPlacementToDeck` on a deck room, else the turn snap), so the
 * batch check, the planned ghosts and the wire all read one pose. An item has
 * exactly the wire item's keys (`PlaceStructuresSchema` is strict), so the
 * list itself is the message's `items`.
 *
 * Module state (never Zustand: the poses are spatial, invariant #2). Flat and
 * pre-allocated to `PLACE_STRUCTURES_MAX` (#14). The count has the
 * `useSyncExternalStore` pair `placementChosen.ts` uses (listeners hear only
 * a change).
 */
import { snapPlacementToDeck } from '../../core/structures/deckPlacement.js';
import type { DeckSnap } from '../../core/hex/deckSnap.js';
import {
  snapPlayerStructureRotation, structureHalfExtentsInto, structureKindToIndex, type StructureKindId,
} from '../../shared-types/structureKinds.js';
import { PLACE_STRUCTURES_MAX } from '../../shared-types/messages.js';

/** One planned building: the `place_structures` wire item, pose snapped. */
export interface PlannedPlacement {
  kind: StructureKindId;
  x: number;
  y: number;
  /** Degrees, snapped as the server snaps it. */
  rot: number;
  mirror: boolean;
}

const pool: PlannedPlacement[] = [];
const refused: boolean[] = [];
for (let i = 0; i < PLACE_STRUCTURES_MAX; i++) {
  pool.push({ kind: 'connector', x: 0, y: 0, rot: 0, mirror: false });
  refused.push(false);
}
/** pool[0..count): the planned list, in order (reused, #14). */
const list: PlannedPlacement[] = [];
const snap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

/**
 * Add `kind` at the player's point and turn (`rotDeg`), snapped as the
 * server will snap it (`deck`: the room's deck flag). Refused (false) when
 * the list is full or the same building is already planned at that pose.
 */
export function addPlannedPlacement(kind: StructureKindId, x: number, y: number, rotDeg: number, mirror: boolean, deck: boolean): boolean {
  if (list.length >= PLACE_STRUCTURES_MAX) return false;
  let px = x, py = y;
  let rot: number = snapPlayerStructureRotation(rotDeg, false, kind);
  if (deck) {
    snapPlacementToDeck(kind, x, y, snap, rotDeg);
    px = snap.x; py = snap.y; rot = snap.rot;
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    if (p.kind === kind && p.x === px && p.y === py && p.rot === rot && p.mirror === mirror) return false;
  }
  const it = pool[list.length]!;
  it.kind = kind; it.x = px; it.y = py; it.rot = rot; it.mirror = mirror;
  refused[list.length] = false;
  list.push(it);
  notify();
  return true;
}

/**
 * Remove planned item `index` (a tap on its ghost while placing). Later items
 * move up one, keeping their refused flags; the pool stays the list's prefix
 * so the next add reuses the freed record (#14). False when out of range.
 */
export function removePlannedPlacement(index: number): boolean {
  const n = list.length;
  if (index < 0 || index >= n) return false;
  const freed = pool[index]!;
  for (let k = index; k < n - 1; k++) {
    pool[k] = pool[k + 1]!;
    list[k] = pool[k]!;
    refused[k] = refused[k + 1]!;
  }
  pool[n - 1] = freed;
  refused[n - 1] = false;
  list.length = n - 1;
  notify();
  return true;
}

const EXT = { hw: 0, hh: 0 };

/**
 * Plan then Build, the tap decision: which of `items` a Place at (x, y)
 * lands on (its footprint box at its turn), or -1. A Place ON a planned
 * building removes it from the plan instead of adding one (that spot is red
 * anyway: it overlaps the planned building). The LAST item wins where two
 * overlap (it draws on top). Null point (no chosen point yet) = -1. Pure,
 * allocation-free.
 */
export function planTapHitIndex(items: readonly PlannedPlacement[], x: number | null, y: number | null): number {
  if (x === null || y === null) return -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const p = items[i]!;
    structureHalfExtentsInto(p.kind, p.rot, EXT);
    if (Math.abs(x - p.x) <= EXT.hw && Math.abs(y - p.y) <= EXT.hh) return i;
  }
  return -1;
}

/** {@link planTapHitIndex} over the planned list. */
export function plannedPlacementHitIndex(x: number | null, y: number | null): number {
  return planTapHitIndex(list, x, y);
}

/** Floats per planned item on the render preview (`writePreviewPlan`). */
export const PREVIEW_PLAN_STRIDE = 5;
/** `PREVIEW_PLAN_STRIDE` flag bits (slot 4): mirrored, refused. */
export const PREVIEW_PLAN_MIRROR = 1;
export const PREVIEW_PLAN_REFUSED = 2;

/**
 * Copy the planned list onto the render preview (`out.plan`, reused, #14), so
 * the (possibly worker) renderer draws the planned ghosts and its live ghost
 * verdict sees them as placed. Flat, stride {@link PREVIEW_PLAN_STRIDE}:
 * x, y, rot (degrees), kind index (`structureKindToIndex`), flags
 * ({@link PREVIEW_PLAN_MIRROR} | {@link PREVIEW_PLAN_REFUSED}). Structured-cloneable.
 */
export function writePreviewPlan(out: { plan?: number[] }): void {
  if (list.length === 0) {
    if (out.plan !== undefined) out.plan.length = 0;
    return;
  }
  const dst = out.plan ?? (out.plan = []);
  dst.length = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    dst.push(p.x, p.y, p.rot, structureKindToIndex(p.kind),
      (p.mirror ? PREVIEW_PLAN_MIRROR : 0) | (refused[i] === true ? PREVIEW_PLAN_REFUSED : 0));
  }
}

/** Empty the list (✕, leaving build mode, the batch landed). */
export function clearPlacementPlan(): void {
  if (list.length === 0) return;
  for (let i = 0; i < list.length; i++) refused[i] = false;
  list.length = 0;
  notify();
}

/** The planned list in order (the `place_structures` items). Read-only view. */
export function plannedPlacements(): readonly PlannedPlacement[] {
  return list;
}

/** Planned item `i` (0 ≤ i < count). */
export function plannedPlacementAt(i: number): Readonly<PlannedPlacement> {
  return list[i]!;
}

/** Was planned item `i` refused (by the batch check or the server's reply)? */
export function isPlannedPlacementRefused(i: number): boolean {
  return i < list.length && refused[i] === true;
}

/** How many `kind` buildings are planned (the crate cap counts them). */
export function plannedCountOfKind(kind: string): number {
  let c = 0;
  for (let i = 0; i < list.length; i++) if (list[i]!.kind === kind) c++;
  return c;
}

/** Clear every refused flag (a fresh verdict follows). */
export function clearPlanRefused(): void {
  for (let i = 0; i < list.length; i++) refused[i] = false;
}

/** Flag planned item `index` refused (out of range is ignored). */
export function markPlannedRefused(index: number): void {
  if (index >= 0 && index < list.length) refused[index] = true;
}

/** `useSyncExternalStore` pair for the planned count (the Build button). */
export function subscribePlacementPlan(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function getPlacementPlanCount(): number {
  return list.length;
}
