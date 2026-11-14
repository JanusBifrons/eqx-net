/**
 * RTS fleet warp (UI) — what "Warp here" does in each control mode. Pure.
 *
 * Fly mode: unchanged, the ship you fly warps (no ship ids sent).
 * Command view: the SELECTED ships warp together (`engage_transit.shipIds` =
 * the one selection's ids); with nothing selected the button is disabled and
 * says why. Piloting is not commanding: a selection only exists in Command
 * view (owner decision 2026-11-14).
 */
import type { Room } from 'colyseus.js';
import { engageTransit } from '../net/transitClient';

export const FLEET_WARP_HINT = 'Select ships to warp';

export type FleetWarpRequest =
  | { allowed: true; shipIds?: readonly string[] }
  | { allowed: false; hint: string };

export function fleetWarpRequest(pilotMode: 'pilot' | 'spectator', selectionIds: readonly string[]): FleetWarpRequest {
  if (pilotMode !== 'spectator') return { allowed: true };
  if (selectionIds.length === 0) return { allowed: false, hint: FLEET_WARP_HINT };
  return { allowed: true, shipIds: selectionIds };
}

type Engage = (
  room: Room, targetSectorKey: string, arrival?: { x: number; y: number }, shipId?: string, shipIds?: readonly string[],
) => void;

/**
 * "Warp here" from the galaxy drawer: sends `engage_transit` for the current
 * control mode (Fly: the flown ship; Command view: the selected ships via
 * `shipIds`). Returns false (nothing sent) in Command view with no selection.
 */
export function sendWarpHere(
  room: Room,
  targetSectorKey: string,
  arrival: { x: number; y: number } | undefined,
  pilotMode: 'pilot' | 'spectator',
  selectionIds: readonly string[],
  engage: Engage = engageTransit,
): boolean {
  const req = fleetWarpRequest(pilotMode, selectionIds);
  if (!req.allowed) return false;
  engage(room, targetSectorKey, arrival, undefined, req.shipIds);
  return true;
}
