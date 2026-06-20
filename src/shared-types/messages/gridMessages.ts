/**
 * Server → client (broadcast): the grid pulse lit some connections this
 * heartbeat (speed-dial-resource-structures plan, Phase 3).
 *
 * Discrete + low-frequency (≤ 1 Hz) — fits the discrete event-bus channel, NOT
 * the per-frame continuous channel (honours the Event-Bus Architecture rule).
 * The client flashes the named connection segments in the carried `material`
 * colour for `FLASH_DURATION_MS`, rather than streaming per-connection flash
 * state every frame. Absent (not sent) on pulses that moved nothing.
 * Interface-only (no zod) — server→client events aren't in the inbound
 * `ClientMessageSchema`.
 */
/** Per-edge flow material — drives the client connector tint (WS-D #12). A
 *  presentation hint only (JSON string, never a binary/versioned wire field):
 *  `minerals`→orange, `repair`→green, `construction`→cyan, `power`→reserved. */
export type GridFlowMaterial = 'power' | 'minerals' | 'repair' | 'construction';

export interface GridPulseEvent {
  type: 'grid_pulse';
  /** Endpoint entityId pairs + the per-edge flow MATERIAL `[aId, bId, material]`
   *  that carried flow this pulse — numeric `u16 entityId`s matching the binary
   *  swarm channel + the `structures[]` slice, so the client joins them to
   *  structure positions AND tints each edge by its own flow (a repair route and
   *  a haul route can light in the SAME pulse). WS-D (#12) added the 3rd tuple
   *  element; a legacy 2-tuple `[aId, bId]` is tolerated (defaults to the
   *  top-level `material`). */
  flashed: Array<[number, number, GridFlowMaterial] | [number, number]>;
  /** Dominant flow material — back-compat single field + the default tint for any
   *  legacy 2-tuple `flashed` entry. */
  material: GridFlowMaterial;
}
