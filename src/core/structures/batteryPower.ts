/**
 * Battery stored-power math — zone-pure, allocation-free scalar helpers
 * (batteries plan). The server `StructureGridSubsystem` orchestrates WHICH
 * batteries charge/discharge and how a component's surplus/deficit is split;
 * these functions own the per-battery arithmetic so it is trivially testable
 * and identical wherever it runs.
 *
 * Power is measured in the same per-pulse units as the catalogue's
 * `powerOutput` / `powerConsumption` (a 1 Hz grid pulse, see
 * `structureGridConstants.TRANSFER_PULSE_MS`). A battery charges from a powered
 * component's surplus, discharges to cover a deficit so the component stays
 * `powered`, and is drained first by shield-wall hits (Part B).
 *
 * Lives in `src/core/structures/` next to `Grid` / `Connection` — pure logic,
 * no zone awareness, no I/O.
 */

/** Clamp a stored level into `[0, capacity]`. */
export function clampStored(stored: number, capacity: number): number {
  if (!(stored > 0)) return 0; // also maps NaN → 0
  if (stored > capacity) return capacity;
  return stored;
}

/**
 * Charge a battery from the component's available surplus this pulse.
 * Absorbs up to the remaining headroom (`capacity - stored`). Returns the new
 * stored level and how much surplus was actually absorbed (so the caller can
 * subtract it from the pool shared across the component's batteries).
 */
export function chargeStep(
  stored: number,
  capacity: number,
  available: number,
): { stored: number; absorbed: number } {
  if (available <= 0 || stored >= capacity) return { stored, absorbed: 0 };
  const room = capacity - stored;
  const absorbed = room < available ? room : available;
  return { stored: stored + absorbed, absorbed };
}

/**
 * Discharge a battery to help cover the component's deficit this pulse.
 * Supplies up to its stored level. Returns the new stored level and how much
 * power it supplied (subtract from the deficit the caller is trying to cover).
 */
export function dischargeStep(stored: number, needed: number): { stored: number; supplied: number } {
  if (needed <= 0 || stored <= 0) return { stored, supplied: 0 };
  const supplied = stored < needed ? stored : needed;
  return { stored: stored - supplied, supplied };
}

/**
 * Drain stored power directly (the shield-wall damage model, Part B, drains
 * batteries before stressing the grid). Returns the new stored level, how much
 * was actually drained (capped at `stored`), and whether the battery emptied.
 */
export function drainPower(
  stored: number,
  amount: number,
): { stored: number; drained: number; emptied: boolean } {
  if (amount <= 0 || stored <= 0) return { stored: stored > 0 ? stored : 0, drained: 0, emptied: stored <= 0 };
  const drained = stored < amount ? stored : amount;
  const next = stored - drained;
  return { stored: next, drained, emptied: next <= 0 };
}
