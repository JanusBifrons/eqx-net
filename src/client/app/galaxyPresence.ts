import type { RosterEntry } from '../state/storeTypes';
import type {
  SectorStructurePresence,
  SectorPresence,
} from '../../shared-types/galaxyPresence.js';

/**
 * Merge the logged-in player's owned structures (from `GET /galaxy/presence`) +
 * ship locations (from the roster) into the per-sector "my presence" overlay
 * pushed to the galaxy map (Equinox Phase 7, omnipotent view).
 *
 * The ACTIVE ship is placed at the LIVE `currentSectorKey` — its roster
 * `sectorKey` can be stale across a transit (the server doesn't refresh it on
 * markActive, see src/server CLAUDE.md). Every other roster ship uses its own
 * `sectorKey`. A ship with no resolvable sector is skipped.
 *
 * Pure — unit-tested; the App effect is a thin caller. Runs at poll / roster
 * cadence (not per-frame), so the per-call allocation is fine.
 */
export function mergePlayerPresence(
  ownedStructures: readonly SectorStructurePresence[],
  roster: readonly RosterEntry[],
  currentSectorKey: string | null,
): SectorPresence[] {
  const bySector = new Map<string, { ships: number; structures: number }>();
  for (const s of ownedStructures) {
    bySector.set(s.key, { ships: 0, structures: s.structures });
  }
  for (const ship of roster) {
    const key = ship.isActive && currentSectorKey ? currentSectorKey : ship.sectorKey;
    if (!key) continue;
    const e = bySector.get(key) ?? { ships: 0, structures: 0 };
    e.ships += 1;
    bySector.set(key, e);
  }
  return Array.from(bySector, ([key, v]) => ({ key, ships: v.ships, structures: v.structures }));
}
