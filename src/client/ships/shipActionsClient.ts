/**
 * Client-side ship ACTIONS (Phase 4 WS-A2) — the in-world "Pilot" action for an
 * OWNED in-sector ship. Mirrors `structureActionsClient`'s send pattern, but the
 * actual swap (the `pilot_ship` send + the spectator-clear + camera-glide +
 * self-prediction re-anchor) is owned by `ColyseusGameClient.pilotInSectorShip`
 * so all the transition state lives in one place (the client owns its own
 * prediction). This is the thin UI→client bridge.
 */
import { getGameClient } from '../net/clientSingleton.js';
import type { FleetCommandMessage } from '../net/ColyseusClient.js';
import type { WingmanMode, WingmanOrder, WingmanStance } from '@core/ai/wingman/types';

/**
 * Pilot the OWNED in-sector ship with shipInstanceId `shipId` — a same-sector
 * instant swap (no spool, no curtain; the camera smooth-lerps to the new ship).
 * Returns true when the swap was dispatched (false when there's no live room).
 */
export function sendPilotShip(shipId: string): boolean {
  const client = getGameClient();
  if (!client) return false;
  return client.pilotInSectorShip(shipId);
}

/**
 * STOP PILOTING → spectate (Equinox Phase-5 audit). The inverse of
 * {@link sendPilotShip}: tell the server to displace our active hull into a
 * lingering hull so it parks in-world AND appears in our own `lingeringShips`
 * for the Pilot dropdown. No-op server-side when we have no active hull
 * (death-spectator / join-as-spectator). Returns true when dispatched.
 */
export function sendSpectate(): boolean {
  const client = getGameClient();
  if (!client) return false;
  return client.sendSpectate();
}

// ── RTS command layer (slice 6a): fleet command senders ──────────────────
// Thin UI→client bridges over `ColyseusGameClient.sendFleetCommand`. Each
// returns true when dispatched (false with no live room). Owner-gating and
// validation of the ship ids happen server-side.

function dispatchFleet(msg: FleetCommandMessage): boolean {
  const client = getGameClient();
  if (!client) return false;
  return client.sendFleetCommand(msg);
}

/** One-off order: `move` to (x, y), `attack` targetId, or `stop`. */
export function sendFleetOrder(shipIds: string[], order: WingmanOrder): boolean {
  if (order.kind === 'move') {
    return dispatchFleet({ type: 'fleet_order', shipIds, kind: 'move', x: order.x, y: order.y });
  }
  if (order.kind === 'attack') {
    return dispatchFleet({ type: 'fleet_order', shipIds, kind: 'attack', targetId: order.targetId });
  }
  return dispatchFleet({ type: 'fleet_order', shipIds, kind: 'stop' });
}

/** Optional per-mode parameters for {@link sendSetMode}. */
export interface SetModeParams {
  route?: [number, number][];
  guardRadius?: number;
  escortId?: string;
}

/** Set the standing wingman mode for the given ships. */
export function sendSetMode(shipIds: string[], mode: WingmanMode, params: SetModeParams = {}): boolean {
  return dispatchFleet({
    type: 'set_mode',
    shipIds,
    mode,
    ...(params.route !== undefined ? { route: params.route } : {}),
    ...(params.guardRadius !== undefined ? { guardRadius: params.guardRadius } : {}),
    ...(params.escortId !== undefined ? { escortId: params.escortId } : {}),
  });
}

/** Set the fire stance for the given ships. */
export function sendSetStance(shipIds: string[], stance: WingmanStance): boolean {
  return dispatchFleet({ type: 'set_stance', shipIds, stance });
}

/** Group 2..24 owned ships into a squad. */
export function sendFormSquad(shipIds: string[]): boolean {
  return dispatchFleet({ type: 'form_squad', shipIds });
}

/** Break up a squad. */
export function sendDisbandSquad(squadId: string): boolean {
  return dispatchFleet({ type: 'disband_squad', squadId });
}
