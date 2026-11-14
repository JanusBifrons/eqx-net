/**
 * Own-ship predicates for the client mirror (RTS Part A S0; invariant #17).
 *
 * The ONE place the client answers "is this the ship I'm flying?" and "is
 * this ship mine?". Pure and mirror-only: no Zustand, no Pixi, no DOM, so the
 * renderer worker, the network client and React panels all call the same
 * functions. Before S0 each caller compared `id === localPlayerId` or
 * `ownerPlayerId === localPlayerId` its own way (fleetSelection, the
 * EntityStatsPanel Pilot gate, pickEntity, syncMirror).
 *
 * Keys follow the mirror (plan Part A, ONE ship list with mixed keys, S3): an
 * active ship lives in `mirror.ships` under its pilot's playerId; a parked
 * (AI-flown) hull lives in the SAME map under its shipInstanceId and carries
 * `ownerPlayerId`. Liveness itself is the shared vocabulary in
 * `src/core/entity/shipLiveness.ts`; ship entries mirror the wire `isActive`.
 */
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import { isLingeringHull, type ShipLivenessView } from '@core/entity/shipLiveness';

/** Reused liveness view (alloc-free per call, #14). Mirror entries are alive
 *  by construction: a dead ship's entry is dropped. */
const _liveness: ShipLivenessView = { alive: true, isActive: true };

/** The player who owns the ship at `key`: its `ownerPlayerId`, else the key
 *  itself (active ships are keyed by their pilot's playerId; an entry seeded
 *  before the schema diff wrote its owner has only the key). */
export function shipOwner(key: string, entry: ShipRenderState): string {
  return entry.ownerPlayerId ?? key;
}

/** "The ship I'm flying": the local player's own `mirror.ships` entry. */
export function isShipIAmFlying(mirror: RenderMirror, key: string): boolean {
  const local = mirror.localPlayerId;
  return local !== null && key === local && mirror.ships.has(key);
}

/** "Owned by me": any ship entry (active or parked) the local player owns. */
export function isOwnedByMe(mirror: RenderMirror, key: string, entry: ShipRenderState): boolean {
  const local = mirror.localPlayerId;
  return local !== null && shipOwner(key, entry) === local;
}

/** "A parked hull": a ship no session is flying (the wire's `isActive=false`;
 *  AI-flown or idle), the shared LINGERING class (#17). The one exception is
 *  the ship I'm flying: the local welcome ship is still `isActive=false`
 *  during its pending join, keyed by my playerId, and is never a parked hull.
 *  Since RTS Part A S3 parked hulls live in `mirror.ships` (shipInstanceId
 *  keys); loops that keep their pre-S3 behaviour gate on this. */
export function isParkedHull(mirror: RenderMirror, key: string, entry: ShipRenderState): boolean {
  if (isShipIAmFlying(mirror, key)) return false;
  _liveness.isActive = entry.isActive !== false;
  return isLingeringHull(_liveness);
}
