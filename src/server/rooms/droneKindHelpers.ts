/**
 * Pure drone-kind catalogue lookups. Extracted from the monolithic
 * `SectorRoom.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 20 prep). Both are
 * stateless wrappers over `getShipKind` from the shared catalogue —
 * no `this`, no server-only deps.
 */

import { getShipKind } from '../../shared-types/shipKinds.js';

/** Resolve a (possibly missing) ship-kind id to the kind's max health, or
 *  null when the id is unknown. Drones use this on spawn so each kind has
 *  its own hull pool. */
export function getDroneMaxHealth(kindId: string | undefined): number | null {
  if (!kindId) return null;
  return getShipKind(kindId).maxHealth;
}

/** Per-kind shield pool for a drone (0 when the kind id is unknown). */
export function getDroneShieldMax(kindId: string | undefined): number {
  if (!kindId) return 0;
  return getShipKind(kindId).shieldMax;
}
