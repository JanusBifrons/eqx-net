/** Phase 8 sub-phase B — server → client transit lifecycle messages
 *  (NOT inbound — see `clientMessages.ts` for `EngageTransitSchema`
 *  + `CancelTransitSchema`). */

export type TransitStateLabel = 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED';
export type TransitCancelReason =
  | 'destroyed'
  | 'manual'
  | 'destination_unavailable'
  | 'token_expired'
  | 'not_neighbour';

export interface TransitStateMessage {
  type: 'transit_state';
  state: TransitStateLabel;
  /** Spool duration in ms. Present when `state === 'SPOOLING'`. */
  spoolMs?: number;
  /** Destination sector key. Present from SPOOLING through ARRIVED. */
  targetSectorKey?: string;
  /** When the state collapses to DOCKED via cancellation, why. */
  reason?: TransitCancelReason;
}

/**
 * Server → client (broadcast): a remote ship just warped OUT of this sector.
 * Sent to every occupant of the source sector EXCEPT the leaving player
 * themselves (the local player gets their own warp visual from the
 * `transit_state` SPOOLING/IN_TRANSIT machinery). The client fires a
 * one-shot `triggerWarpIn` (flash + burst ripple) at `(x, y)` so observers
 * see where the ship vanished from.
 *
 * NOTE: the message name is `warp_out` but the client uses the same
 * `triggerWarpIn` API for both directions — the renderer's "burst+flash
 * at a world point" pulse is direction-agnostic.
 */
export interface WarpOutEvent {
  type: 'warp_out';
  playerId: string;
  x: number;
  y: number;
}

/**
 * Server → client (broadcast): a ship just warped INTO this sector.
 * Sent to every existing occupant EXCEPT the joining player themselves
 * (the joiner gets their own arrival visual from the welcome /
 * snapshot flow). The client fires `triggerWarpIn` at the spawn world
 * point so observers see the arrival pulse.
 */
export interface WarpInEvent {
  type: 'warp_in';
  playerId: string;
  x: number;
  y: number;
}
