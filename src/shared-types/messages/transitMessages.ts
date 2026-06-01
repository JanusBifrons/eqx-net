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
 *
 * Pre-handshake (plan: crispy-kazoo, Commit 2): sent to every existing
 * occupant EXCEPT the joining player themselves; the joiner's own
 * arrival visual came from a different code path.
 *
 * Post-handshake: sent to ALL occupants of the destination sector
 * INCLUDING the joiner. The joiner uses `arrivalTick` to schedule
 * their curtain drop + local warp-in animation in sync with every
 * other observer. Observers fire `triggerWarpIn` at `arrivalTick`
 * (not on receipt) so the flash lands at the same logical instant
 * everywhere. `ARRIVAL_OFFSET_TICKS = 6` (100 ms @ 60 Hz) gives the
 * broadcast time to propagate before the activation tick.
 *
 * `arrivalTick` is optional for back-compat with older servers that
 * pre-date the handshake; pre-handshake clients ignore it harmlessly,
 * pre-handshake servers (the existing transit-arrival fast path) keep
 * working without it. New handshake call sites MUST populate it.
 */
export interface WarpInEvent {
  type: 'warp_in';
  playerId: string;
  x: number;
  y: number;
  /** Server tick at which the ship becomes visible. Present on
   *  spawn-handshake commits + new transit-arrival commits. */
  arrivalTick?: number;
}
