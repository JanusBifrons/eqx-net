/**
 * Phase 2 multi-ship roster — server pushes a player's full roster (up to
 * 10 entries) whenever it changes. The client uses this to drive the
 * ship-list panel on the galaxy map. Per-entry numbers are static-state
 * (last-known position when stored; current pose when active). The
 * canonical x/y for an active ship still flows over the per-frame render
 * mirror — this message is for the discrete card UI.
 */
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
