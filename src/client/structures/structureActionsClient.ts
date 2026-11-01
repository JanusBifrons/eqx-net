/**
 * Client-side structure ACTIONS (Phase-1 issue 6) — deconstruct toggle /
 * reconnect / clear-connections for a selected structure the local player owns.
 * Mirrors `structurePlacementClient`'s send pattern; the structure is referenced
 * by its numeric swarm entityId (the selected id). Owner-gated server-side.
 */
import type { GateAccess } from '../../shared-types/gateAccess';
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

/** Phase 4 WS-B4 — send `upgrade_structure` for the structure with swarm
 *  entityId `entityId` (a paid level-up build phase, owner-gated server-side).
 *  Returns true if the message was sent (false when there's no live room). */
export function sendUpgradeStructure(entityId: number): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('upgrade_structure', { type: 'upgrade_structure', entityId });
  return true;
}

/** Gates — send `set_gate_access` (who this gate opens for). Owner-gated
 *  server-side; the inspector only offers it on the owner's own gates. */
export function sendSetGateAccess(entityId: number, access: GateAccess): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('set_gate_access', { type: 'set_gate_access', entityId, access });
  return true;
}

/** Living World P1a-2 — send `repair_ship` (repair MY active ship to full at my
 *  own storage, paid from the wallet; the server checks range + balance). */
export function sendRepairShip(): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('repair_ship', { type: 'repair_ship' });
  return true;
}

/** Living World P1a-2 — send `refine_salvage` (salvage from the base storage
 *  network → this Capital's mineral bank; owner-gated server-side). Returns
 *  true if the message was sent (false when there's no live room). */
export function sendRefineSalvage(entityId: number, qty: number): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('refine_salvage', { type: 'refine_salvage', entityId, qty });
  return true;
}
