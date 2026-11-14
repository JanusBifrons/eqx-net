/**
 * Own-fleet selection (RTS stream slice 13a). Pure: no Pixi, no DOM.
 *
 * "Your ships" are the local player's active ship (`mirror.ships` keyed by
 * `localPlayerId`) plus their parked hulls (`isParkedHull`, owned by me; the
 * same `mirror.ships` since RTS Part A S3). Ids follow the
 * `pickEntityAt` / `SelectionBracket` convention: the active ship is its
 * playerId, a lingering hull is its shipInstanceId.
 *
 * All coordinates here are GAME space (y up), the space the mirror holds.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { TAP_SLOP } from './pickEntity.js';
import { isOwnedByMe, isParkedHull, isShipIAmFlying, shipOwner } from './shipOwnership.js';

export interface FleetShip {
  id: string;
  x: number;
  y: number;
  ownerPlayerId: string;
  radius: number;
}

const SHIP_FALLBACK_RADIUS = 20;

function shipRadius(kind: string | undefined): number {
  return getShipKind(kind)?.radius ?? SHIP_FALLBACK_RADIUS;
}

/**
 * Every ship in the mirror with its owner (active ships are owned by their
 * playerId key). Allocates; call on a gesture, not per frame.
 */
export function collectFleetShips(mirror: RenderMirror): FleetShip[] {
  const out: FleetShip[] = [];
  // Every ship: ACTIVE and LINGERING (#17), one list since RTS Part A S3.
  for (const [id, s] of mirror.ships) {
    out.push({ id, x: s.x, y: s.y, ownerPlayerId: shipOwner(id, s), radius: shipRadius(s.kind) });
  }
  return out;
}

/** The squad an own ship belongs to (slice 15a), or null/undefined when none. */
export type SquadOf = (id: string) => string | null | undefined;

/**
 * `hits` plus every own ship (in `ships`) that shares a squad with any hit.
 * Hits keep their order; squad mates follow in `ships` order; no duplicates.
 * Without `squadOf`, or when no hit is in a squad, returns `hits` itself.
 */
export function expandToSquads(
  hits: readonly string[],
  ships: Iterable<FleetShip>,
  localPlayerId: string | null,
  squadOf?: SquadOf,
): readonly string[] {
  if (squadOf === undefined || localPlayerId === null || hits.length === 0) return hits;
  let squads: Set<string> | null = null;
  for (const id of hits) {
    const sq = squadOf(id);
    if (sq !== null && sq !== undefined) (squads ??= new Set()).add(sq);
  }
  if (squads === null) return hits;
  const out = hits.slice();
  const seen = new Set(hits);
  for (const s of ships) {
    if (s.ownerPlayerId !== localPlayerId || seen.has(s.id)) continue;
    const sq = squadOf(s.id);
    if (sq !== null && sq !== undefined && squads.has(sq)) {
      out.push(s.id);
      seen.add(s.id);
    }
  }
  return out;
}

/**
 * A tap on own ship `hit` (slice 15a owner rules):
 *  - plain tap selects the hit's WHOLE squad; tapping a member of a squad
 *    that is already EXACTLY the selection narrows it to just that ship;
 *  - shift on a ship not selected adds its whole squad; shift on a selected
 *    ship removes just that ship (the 13a toggle, so a squad can be trimmed).
 * A ship in no squad behaves as before (`applySelection`). Returns a new Set.
 */
export function tapSelectOwn(
  current: ReadonlySet<string>,
  hit: string,
  additive: boolean,
  ships: Iterable<FleetShip>,
  localPlayerId: string | null,
  squadOf?: SquadOf,
): Set<string> {
  const group = expandToSquads([hit], ships, localPlayerId, squadOf);
  if (additive) {
    if (current.has(hit)) return applySelection(current, [hit], true);
    return applySelection(current, group, true);
  }
  if (group.length > 1 && current.size === group.length && group.every((id) => current.has(id))) {
    return new Set([hit]);
  }
  return new Set(group);
}

/**
 * Ids of own ships whose centre lies inside the box (corners in any order),
 * expanded to the whole squad of every ship it touches when `squadOf` is given.
 */
export function boxSelectOwn(
  x0: number, y0: number, x1: number, y1: number,
  ships: Iterable<FleetShip>,
  localPlayerId: string | null,
  squadOf?: SquadOf,
): string[] {
  if (localPlayerId === null) return [];
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const hits: string[] = [];
  for (const s of ships) {
    if (s.ownerPlayerId !== localPlayerId) continue;
    if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) hits.push(s.id);
  }
  return expandToSquads(hits, ships, localPlayerId, squadOf) as string[];
}

/** The nearest own ship under a tap (radius + TAP_SLOP), or null. */
export function pickOwnShipAt(
  x: number, y: number,
  ships: Iterable<FleetShip>,
  localPlayerId: string | null,
): string | null {
  if (localPlayerId === null) return null;
  let best: string | null = null;
  let bestSq = Infinity;
  for (const s of ships) {
    if (s.ownerPlayerId !== localPlayerId) continue;
    const dx = s.x - x;
    const dy = s.y - y;
    const d = dx * dx + dy * dy;
    const reach = s.radius + TAP_SLOP;
    if (d <= reach * reach && d < bestSq) {
      bestSq = d;
      best = s.id;
    }
  }
  return best;
}

/**
 * Combine a gesture's hits with the current selection.
 *  - not additive: the hits replace the selection (empty hits clear it).
 *  - additive (shift) single hit already selected: toggles it off.
 *  - additive otherwise: hits are added.
 * Returns a new Set; never mutates `current`.
 */
export function applySelection(
  current: ReadonlySet<string>,
  hits: readonly string[],
  additive: boolean,
): Set<string> {
  if (!additive) return new Set(hits);
  const next = new Set(current);
  if (hits.length === 1 && current.has(hits[0]!)) {
    next.delete(hits[0]!);
    return next;
  }
  for (const id of hits) next.add(id);
  return next;
}

/**
 * THE selection's focus rule (RTS Part A: one selection concept). The focus
 * (the entity whose details panel shows) survives a change of the selected
 * ships only when no ships are selected (then it may be anything you tapped)
 * or it is one of them. False ⇒ the focus clears.
 */
export function focusSurvives(ships: ReadonlySet<string>, focusId: string | null): boolean {
  return focusId !== null && (ships.size === 0 || ships.has(focusId));
}

/** True when both sets hold the same ids. */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Whether `id` is still an own ship in the mirror (used to prune). */
export function isOwnShipPresent(id: string, mirror: RenderMirror): boolean {
  if (isShipIAmFlying(mirror, id)) return true;
  // Else one of my PARKED hulls (pre-S3 behaviour: never another active ship).
  const s = mirror.ships.get(id);
  return s !== undefined && isParkedHull(mirror, id, s) && isOwnedByMe(mirror, id, s);
}
