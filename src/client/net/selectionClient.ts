/**
 * Client-side click-to-inspect send helpers (structures follow-up Item B5).
 *
 * The renderer owns the selection; the main-thread `gameRafLoop` bridge detects
 * selection transitions (via `RendererFeedback.selectedPickId/Kind`) and calls
 * these to start/stop the server's selection-scoped stats stream. Only SHIP and
 * STRUCTURE selections use the channel — drones + wrecks read health from the
 * render mirror, so the bridge never calls `sendSelectEntity` for them.
 *
 * Send pattern mirrors `structures/structurePlacementClient.ts` — the live room
 * via the client singleton.
 */
import { getGameClient } from './clientSingleton.js';
import type { PickedEntityKind } from '../render/pickEntity.js';

/** Map a renderer pick kind to the wire `select_entity.kind`. Returns null for
 *  drone/wreck (those never use the channel). For a structure the wire `id` is
 *  the numeric swarm entityId (strip the `swarm-` prefix the mirror uses). */
export function toSelectWire(
  id: string,
  kind: PickedEntityKind,
): { id: string; kind: 'ship' | 'structure' } | null {
  if (kind === 'ship') return { id, kind: 'ship' };
  if (kind === 'structure') {
    const entityId = id.startsWith('swarm-') ? id.slice('swarm-'.length) : id;
    return { id: entityId, kind: 'structure' };
  }
  return null; // drone / wreck — no server channel
}

/** Start the server stats stream for a ship/structure selection. No-op (returns
 *  false) for drone/wreck or when there's no live room. */
export function sendSelectEntity(id: string, kind: PickedEntityKind): boolean {
  const wire = toSelectWire(id, kind);
  if (!wire) return false;
  const client = getGameClient();
  const room = client?.getRoom();
  if (!room) return false;
  room.send('select_entity', { type: 'select_entity', id: wire.id, kind: wire.kind });
  return true;
}

/** Stop the server stats stream. Idempotent on the server (keyed by session). */
export function sendDeselectEntity(): boolean {
  const client = getGameClient();
  const room = client?.getRoom();
  if (!room) return false;
  room.send('deselect_entity', { type: 'deselect_entity' });
  return true;
}
