/**
 * Client-side structure ACTIONS (Phase-1 issue 6) — deconstruct toggle /
 * reconnect / clear-connections for a selected structure the local player owns.
 * Mirrors `structurePlacementClient`'s send pattern; the structure is referenced
 * by its numeric swarm entityId (the selected id). Owner-gated server-side.
 */
import type { RecipeId } from '../../shared-types/recipes';
import type { GateAccess } from '../../shared-types/gateAccess';
import type { TeleportRules } from '../../shared-types/teleport';
import type { GoodId } from '../../shared-types/goods';
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

/** P2b — send `set_recipe` (the owner picks what a processor makes). The
 *  server validates owner + that the kind runs the recipe. */
export function sendSetRecipe(entityId: number, recipe: RecipeId): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  room.send('set_recipe', { type: 'set_recipe', entityId, recipe });
  return true;
}

/** P2b — load the best matching blueprint from base storage into a processor,
 *  or put its blueprint back. Owner-gated server-side. */
export function sendBlueprintSlot(entityId: number, action: 'load' | 'unload'): boolean {
  const client = getGameClient();
  if (!client) return false;
  const room = client.getRoom();
  if (!room) return false;
  const type = action === 'load' ? 'load_blueprint' : 'unload_blueprint';
  room.send(type, { type, entityId });
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

// ── v4 T1 — teleporters (owner-gated server-side) ───────────────────────────

function sendTp(type: string, payload: Record<string, unknown>): boolean {
  const room = getGameClient()?.getRoom();
  if (!room) return false;
  room.send(type, { type, ...payload });
  return true;
}

export function sendTeleportPair(entityId: number, partnerEntityId: number): boolean {
  return sendTp('teleport_pair', { entityId, partnerEntityId });
}
export function sendTeleportUnpair(entityId: number): boolean {
  return sendTp('teleport_unpair', { entityId });
}
export function sendTeleportFire(entityId: number): boolean {
  return sendTp('teleport_fire', { entityId });
}
export function sendSetTeleportRules(entityId: number, rules: TeleportRules): boolean {
  return sendTp('set_teleport_rules', { entityId, rules });
}
export function sendTeleportPadLoad(entityId: number, good: GoodId, qty: number): boolean {
  return sendTp('teleport_pad_load', { entityId, good, qty });
}
export function sendTeleportPadUnload(entityId: number): boolean {
  return sendTp('teleport_pad_unload', { entityId });
}
