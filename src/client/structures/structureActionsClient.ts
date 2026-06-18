/**
 * Client-side structure ACTIONS (Phase-1 issue 6) — deconstruct toggle /
 * reconnect / clear-connections for a selected structure the local player owns.
 * Mirrors `structurePlacementClient`'s send pattern; the structure is referenced
 * by its numeric swarm entityId (the selected id). Owner-gated server-side.
 */
import { getGameClient } from '../net/clientSingleton.js';

export type StructureAction = 'toggle_deconstruct' | 'reconnect' | 'clear_connections';

/** Send a `structure_action` for the structure with swarm entityId `id`.
 *  Returns true if the message was sent (false when there's no live room). */
export function sendStructureAction(id: number, action: StructureAction): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('structure_action', { type: 'structure_action', id, action });
  return true;
}
