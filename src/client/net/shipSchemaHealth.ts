import type { ShipRenderState } from '@core/contracts/IRenderer';

/**
 * Copy a ship's schema `health` / `maxHealth` onto its mirror entry (RTS Part A
 * step 8). Every ship's `ShipState` already syncs both through room state, for
 * pilot- and AI-flown ships alike, so the fleet panel and the details panel
 * read hull % from here instead of a second carrier (`fleet_status` no longer
 * sends hull or morale). Called by `syncMirror` on every schema diff; writes
 * only finite numbers, never allocates (#14).
 */
export function copySchemaHealth(schemaShip: Record<string, unknown>, entry: ShipRenderState): void {
  const hp = schemaShip['health'];
  const max = schemaShip['maxHealth'];
  if (typeof hp === 'number' && Number.isFinite(hp)) entry.health = hp;
  if (typeof max === 'number' && Number.isFinite(max)) entry.maxHealth = max;
}

/** Hull % (0–100, rounded) of a mirror ship entry, or null before the schema
 *  brought its health. */
export function shipHullPct(entry: ShipRenderState | undefined): number | null {
  if (entry === undefined || entry.health === undefined || entry.maxHealth === undefined || entry.maxHealth <= 0) return null;
  return Math.round(Math.max(0, Math.min(1, entry.health / entry.maxHealth)) * 100);
}
