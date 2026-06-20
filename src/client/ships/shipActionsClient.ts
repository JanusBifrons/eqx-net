/**
 * Client-side ship ACTIONS (Phase 4 WS-A2) — the in-world "Pilot" action for an
 * OWNED in-sector ship. Mirrors `structureActionsClient`'s send pattern, but the
 * actual swap (the `pilot_ship` send + the spectator-clear + camera-glide +
 * self-prediction re-anchor) is owned by `ColyseusGameClient.pilotInSectorShip`
 * so all the transition state lives in one place (the client owns its own
 * prediction). This is the thin UI→client bridge.
 */
import { getGameClient } from '../net/clientSingleton.js';

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
