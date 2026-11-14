/**
 * Own-fleet selection (RTS stream slice 13a). Pure: no Pixi, no DOM.
 *
 * "Your ships" are the local player's active ship (`mirror.ships` keyed by
 * `localPlayerId`) plus their lingering (parked) hulls in
 * `mirror.lingeringShips` (`ownerPlayerId === localPlayerId`). Ids follow the
 * `pickEntityAt` / `SelectionBracket` convention: the active ship is its
 * playerId, a lingering hull is its shipInstanceId.
 *
 * All coordinates here are GAME space (y up), the space the mirror holds.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { TAP_SLOP } from './pickEntity.js';

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
  for (const [id, s] of mirror.ships) {
    out.push({ id, x: s.x, y: s.y, ownerPlayerId: id, radius: shipRadius(s.kind) });
  }
  if (mirror.lingeringShips) {
    for (const [id, l] of mirror.lingeringShips) {
      out.push({ id, x: l.x, y: l.y, ownerPlayerId: l.ownerPlayerId, radius: shipRadius(l.kind) });
    }
  }
  return out;
}

/** Ids of own ships whose centre lies inside the box (corners in any order). */
export function boxSelectOwn(
  x0: number, y0: number, x1: number, y1: number,
  ships: Iterable<FleetShip>,
  localPlayerId: string | null,
  // Squads come later: a hit will expand to its whole squad via this hook.
  // TODO(rts): expandToSquads(ids, squadOf) once squads exist.
  _squadOf?: (id: string) => string | undefined,
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
  return hits;
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

/** True when both sets hold the same ids. */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Whether `id` is still an own ship in the mirror (used to prune). */
export function isOwnShipPresent(id: string, mirror: RenderMirror): boolean {
  const local = mirror.localPlayerId;
  if (local === null) return false;
  if (id === local) return mirror.ships.has(id);
  const l = mirror.lingeringShips?.get(id);
  return l !== undefined && l.ownerPlayerId === local;
}
