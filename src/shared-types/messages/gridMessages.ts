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
export interface GridPulseEvent {
  type: 'grid_pulse';
  /** Endpoint entityId pairs `[aId, bId]` that carried flow this pulse —
   *  numeric `u16 entityId`s matching the binary swarm channel + the
   *  `structures[]` slice, so the client joins them to structure positions. */
  flashed: Array<[number, number]>;
  /** Flow material — drives the client tint (Phase 3: always 'minerals'). */
  material: 'power' | 'minerals';
}
