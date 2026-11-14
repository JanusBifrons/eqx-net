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
 * Keys follow the mirror (plan Part A, mixed keys): an active ship lives in
 * `mirror.ships` under its pilot's playerId; a parked hull lives in
 * `mirror.lingeringShips` under its shipInstanceId and carries
 * `ownerPlayerId`. Liveness itself is the shared vocabulary in
 * `src/core/entity/shipLiveness.ts`; ship entries mirror the wire `isActive`.
 */
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';

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
