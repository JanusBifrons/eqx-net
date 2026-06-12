/** Phase 8 sub-phase B — server → client transit lifecycle messages
 *  (NOT inbound — see `clientMessages.ts` for `EngageTransitSchema`
 *  + `CancelTransitSchema`). */

import { z } from 'zod';

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

/**
 * Server → client (broadcast, wave-system Phase 5): something is SPOOLING to
 * warp into THIS sector — show the destination-sector occupants a HUD warning
 * with a countdown. Emitted ONCE at spool start (carrying the full spool
 * remaining as `countdownMs`), for BOTH a drone squad (`count` 8, `label`
 * "Legionnaire") and a player (`count` 1, `label` the display name). A drone
 * squad's per-bot `warp_in` flashes still fire on arrival; this is the distinct
 * HUD-banner channel (it carries NO positions → Zustand-safe, invariant #2).
 *
 * It drives visible UI, so — unlike `warp_in`/`bot_aggro` — the client zod-
 * validates it and drops malformed packets (invariant #3): a bad
 * `count`/`countdownMs` would render a garbage banner. `id` keys the banner so
 * a cancelled/aborted spool can clear it (`warp_warning_clear`).
 */
export const WarpWarningSchema = z
  .object({
    type: z.literal('warp_warning'),
    /** Stable id for this incoming group (the squadId, or the player id). */
    id: z.string().min(1),
    /** Display label for the line — e.g. "Legionnaire" or a player name. */
    label: z.string().min(1).max(64),
    /** How many ships are inbound (8 for a squad, 1 for a player). */
    count: z.number().int().min(1).max(64),
    /** Spool remaining at emit, ms — the countdown the banner ticks down. */
    countdownMs: z.number().finite().nonnegative(),
    /** Optional ship-kind id for an icon. */
    kind: z.string().optional(),
  })
  .strict();

export type WarpWarningEvent = z.infer<typeof WarpWarningSchema>;

/**
 * Server → client (broadcast): clear a pending `warp_warning` (its spool was
 * cancelled or the warping ship died during the vulnerable spool). `id` matches
 * the `warp_warning.id` to dismiss.
 */
export const WarpWarningClearSchema = z
  .object({
    type: z.literal('warp_warning_clear'),
    id: z.string().min(1),
  })
  .strict();

export type WarpWarningClearEvent = z.infer<typeof WarpWarningClearSchema>;

/**
 * Server → client (broadcast): a faction's base FIRST became "ready" enough to
 * draw drone waves (Capital + Miner + Solar + Turret all built). WS-11 (R2.24
 * Part B) — drives a one-shot owner-only toast so the player learns their base
 * is now a wave target. A DISCRETE broadcast (not the snapshot/binary path),
 * exactly like `warp_warning`; the client zod-validates + shows the toast only
 * when `factionId` is the local player. Fired once per ready transition (the
 * server `FactionLedger.markReadyNotified` one-shot).
 */
export const BaseReadySchema = z
  .object({
    type: z.literal('base_ready'),
    /** The owning player's id (== the faction id). */
    factionId: z.string().min(1).max(64),
    /** Sector the base is in. */
    sectorKey: z.string().min(1).max(64),
  })
  .strict();

export type BaseReadyEvent = z.infer<typeof BaseReadySchema>;
