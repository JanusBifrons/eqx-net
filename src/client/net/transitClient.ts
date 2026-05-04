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

export function engageTransit(room: Room, targetSectorKey: string): void {
  room.send('engage_transit', { type: 'engage_transit', targetSectorKey });
}

export function cancelTransit(room: Room): void {
  room.send('cancel_transit', { type: 'cancel_transit' });
}
