/**
 * Phase 8 sub-phase B — client-side transit helpers.
 *
 * Both messages travel over the existing Colyseus room socket (the source
 * room is already connected when transit is engaged), so there's no HTTP
 * indirection. The server orchestrator validates `targetSectorKey` is a
 * neighbour and replies with `transit_state` events that drive the
 * HyperspaceOverlay UI.
 *
 * Phase 5 — `shipId` extension for in-game roster switching. When set,
 * the destination room binds the named roster entry at arrival instead
 * of letting the source ship continue. Server validates ownership via
 * `PlayerShipStore.get(shipId).playerId === <requesting player>` and
 * rejects with `destination_unavailable` on mismatch.
 */
import type { Room } from 'colyseus.js';

export function engageTransit(
  room: Room,
  targetSectorKey: string,
  arrival?: { x: number; y: number },
  shipId?: string,
): void {
  const msg: {
    type: 'engage_transit';
    targetSectorKey: string;
    arrival?: { x: number; y: number };
    shipId?: string;
  } = {
    type: 'engage_transit',
    targetSectorKey,
  };
  if (arrival) msg.arrival = { x: arrival.x, y: arrival.y };
  if (shipId) msg.shipId = shipId;
  room.send('engage_transit', msg);
}

export function cancelTransit(room: Room): void {
  room.send('cancel_transit', { type: 'cancel_transit' });
}
