/**
 * Phase 8 sub-phase B — client-side transit helpers.
 *
 * Both messages travel over the existing Colyseus room socket (the source
 * room is already connected when transit is engaged), so there's no HTTP
 * indirection. The server orchestrator validates `targetSectorKey` is a
 * neighbour and replies with `transit_state` events that drive the
 * HyperspaceOverlay UI.
 */
import type { Room } from 'colyseus.js';

export function engageTransit(
  room: Room,
  targetSectorKey: string,
  arrival?: { x: number; y: number },
): void {
  const msg: { type: 'engage_transit'; targetSectorKey: string; arrival?: { x: number; y: number } } = {
    type: 'engage_transit',
    targetSectorKey,
  };
  if (arrival) msg.arrival = { x: arrival.x, y: arrival.y };
  room.send('engage_transit', msg);
}

export function cancelTransit(room: Room): void {
  room.send('cancel_transit', { type: 'cancel_transit' });
}
