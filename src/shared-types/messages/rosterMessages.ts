/**
 * Phase 2 multi-ship roster — server pushes a player's full roster (up to
 * 10 entries) whenever it changes. The client uses this to drive the
 * ship-list panel on the galaxy map. Per-entry numbers are static-state
 * (last-known position when stored; current pose when active). The
 * canonical x/y for an active ship still flows over the per-frame render
 * mirror — this message is for the discrete card UI.
 */
import { z } from 'zod';

export interface ShipRosterEntry {
  shipId: string;
  kind: string;
  /** Catalogue version when the entry was last saved server-side.
   *  Returning-player drift handling clamps stale rows to the current
   *  catalogue at hydrate time; this field is informational here. */
  kindVersion: number;
  health: number;
  /** Sector this ship was last seen in (or is currently active in). */
  sectorKey: string;
  /** Last-known world position. For active ships this is updated when
   *  the server flushes pose to persistence (periodic + onLeave). */
  x: number;
  y: number;
  /** True while bound to a sector-room slot (player is connected and
   *  playing this ship, or just disconnected and within the 15-min
   *  linger window). */
  isActive: boolean;
}

export interface ShipRosterMessage {
  type: 'ship_roster';
  ships: ShipRosterEntry[];
}

/** Campaign 6.1 (anti-patterns review C-core 3) — defensive ingest schemas
 *  for the roster push. Same contract as `WelcomeSchema`: the server trusts
 *  its own construction; a client consumer `safeParse`s on receipt and drops
 *  malformed payloads (invariant #3). Mirrors the hand-written interfaces
 *  exactly — the assignability lock in `messages.test.ts` catches drift.
 *  Poses are `.finite()` (an Infinity/NaN x/y would poison card UI maths). */
export const ShipRosterEntrySchema = z
  .object({
    shipId: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    kindVersion: z.number().int(),
    health: z.number().finite(),
    sectorKey: z.string().min(1).max(64),
    x: z.number().finite(),
    y: z.number().finite(),
    isActive: z.boolean(),
  })
  .strict();

export const ShipRosterSchema = z
  .object({
    type: z.literal('ship_roster'),
    ships: z.array(ShipRosterEntrySchema),
  })
  .strict();
