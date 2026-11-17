/**
 * Territory Lock (sector control, galaxy-map plan): the placement rules and the
 * live-lock read, over the room's own `StructureRegistry`. No tracker of its
 * own: a lock is just a `territory_lock` structure, and the control meter
 * (`RobotTerritory`) reads its lock sides from the room's `liveCounts`.
 *
 * Owner rules: "once it's yours you can lock it down with a territory control
 * structure which locks your ownership until destroyed"; built like other
 * structures (minerals drained while it builds, `TERRITORY_LOCK_COST`).
 *
 * Placement (player `place_structure` only, server-side):
 *  - the builder's side must HOLD the sector on the control meter now;
 *  - at most one lock per sector (a blueprint still building counts).
 *
 * Only a BUILT lock locks: a blueprint under construction does nothing. A lock
 * whose side no longer holds the sector does nothing either (the stepper
 * ignores a non-holder's lock); if that side takes the sector back, the
 * standing lock locks it again.
 */
import { parseOwner } from '../../shared-types/relations.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import { sectorController } from '../../core/galaxy/control.js';
import type { StructureRecord } from './StructureRegistry.js';

export const TERRITORY_LOCK_KIND: StructureKindId = 'territory_lock';

export const LOCK_NOT_HELD_REASON = 'You can only build a Territory Lock in a sector your side holds.';
export const LOCK_TAKEN_REASON = 'This sector already has a Territory Lock.';

/**
 * Why `owner` may not place `kindId` here, or null when it may. Only the
 * Territory Lock has rules. `holder` = the sector's holder on the live control
 * meter (`liveSectorHolder`): null = neutral, undefined = no meter running, in
 * which case the sector's static controller stands in (never a player).
 * Placement cadence (a player's click), never a tick.
 */
export function territoryLockRefusal(
  owner: string,
  kindId: string,
  sectorKey: string,
  holder: string | null | undefined,
  structures: Iterable<StructureRecord>,
): string | null {
  if (kindId !== TERRITORY_LOCK_KIND) return null;
  const held = holder === undefined ? sectorController(sectorKey) : holder;
  if (held === null || held !== parseOwner(owner).faction) return LOCK_NOT_HELD_REASON;
  for (const s of structures) if (s.kind === TERRITORY_LOCK_KIND) return LOCK_TAKEN_REASON;
  return null;
}

/** True when `s` is a built Territory Lock (it locks its owner's side). */
export function isLiveTerritoryLock(s: StructureRecord): boolean {
  return s.kind === TERRITORY_LOCK_KIND && s.isConstructed;
}
