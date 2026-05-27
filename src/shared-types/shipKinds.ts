/**
 * Ship-kind catalogue — barrel for the family split per the god-file
 * refactor plan (`docs/plans/refactor-god-files.md`, commit 4).
 *
 * Read by:
 *   - `src/core/physics/World.ts` (per-kind damping, max speed, lateral
 *     grip, thrust impulse, etc. when the worker spawns or applies input).
 *   - `src/core/ai/HostileDroneBehaviour.ts` (per-kind AI tuning — drones
 *     pick a random kind on spawn and steer with that kind's tuning).
 *   - `src/server/rooms/SectorRoom.ts` (validates the `shipKind` field on
 *     `JoinOptions`, writes it to `ShipState.kind`, threads it into the
 *     `SPAWN` worker command).
 *   - `src/server/spawn/SwarmSpawner.ts` (picks a random kind per drone).
 *   - `src/client/components/ShipPickerModal.tsx` and the in-game renderer
 *     (`shape` drives the polygon and colour so the picker silhouette
 *     and the in-world sprite are guaranteed identical).
 *
 * Adding a new kind: append a record to a family file (or add a new
 * family file) AND append it to `catalogueOrder.ts`'s `SHIP_KINDS_LIST`.
 * The catalogue's u8 wire index is the position in that list — only
 * append, never reorder.
 *
 * Living in `src/shared-types/` (pure TS + zod, no runtime behaviour) is
 * what lets server / core / client all read the same definitions without
 * violating the boundary invariants.
 */

// Re-export schemas + types + legacy mount templates from the family files.
export {
  ShipShapeSchema,
  MountWeaponIdSchema,
  WeaponMountSchema,
  WeaponSlotSchema,
  ShipKindSchema,
  LEGACY_FORWARD_MOUNT,
  LEGACY_PRIMARY_SLOT,
} from './shipKinds/types.js';
export type {
  ShipShape,
  WeaponMount,
  WeaponSlot,
  ShipKind,
  ShipKindId,
} from './shipKinds/types.js';

// Re-export individual kind constants (per-family).
export { SCOUT, FIGHTER } from './shipKinds/fighters.js';
export { HEAVY, INTERCEPTOR, GUNSHIP } from './shipKinds/heavyClass.js';
export { MISSILE_FRIGATE } from './shipKinds/missileFrigate.js';

// Re-export the canonical-order list.
export { SHIP_KINDS_LIST } from './shipKinds/catalogueOrder.js';

// Build the `SHIP_KINDS` keyed lookup from the canonical list. The list
// is the single source of truth for wire order; this object is a
// convenience for code that wants id-based lookup. Both must agree by
// construction (golden test snapshots both in tests/unit/shipKinds.test.ts).
import { FIGHTER, SCOUT } from './shipKinds/fighters.js';
import { HEAVY, INTERCEPTOR, GUNSHIP } from './shipKinds/heavyClass.js';
import { MISSILE_FRIGATE } from './shipKinds/missileFrigate.js';
import { SHIP_KINDS_LIST } from './shipKinds/catalogueOrder.js';
import type { ShipKind, ShipKindId } from './shipKinds/types.js';

/**
 * The catalogue, frozen so a typo can't mutate it at runtime. Keys are
 * the canonical ids. **The ORDER of this object literal mirrors the
 * `SHIP_KINDS_LIST` order** so `Object.values(SHIP_KINDS)` and
 * `SHIP_KINDS_LIST` agree byte-for-byte (locked by `shipKinds.test.ts`).
 * The list is the source of truth for wire-format order; this object
 * exists for id-based lookup convenience.
 */
export const SHIP_KINDS = Object.freeze({
  fighter: FIGHTER,
  scout: SCOUT,
  heavy: HEAVY,
  interceptor: INTERCEPTOR,
  gunship: GUNSHIP,
  'missile-frigate': MISSILE_FRIGATE,
} as const) satisfies Readonly<Record<string, ShipKind>>;

/**
 * Catalogue stat-version. Bumped by hand whenever a kind's numerical stats
 * change (maxSpeed, maxHealth, maxAngvel, damping, grip, thrust, mount
 * positions, etc.) — anything that affects gameplay feel for a stored ship
 * picked up after a long absence.
 *
 * The kind *id* set is append-only (invariant #11), but the numbers attached
 * to each id can drift across releases. Stored `player_ships` rows record
 * the catalogue version they were saved at; on hydrate, if the version is
 * older than this constant, the per-ship `health` is clamped down to the
 * current `maxHealth` (so we never strip earned damage but never gift hull
 * above the new cap either) and other stats are read live from the
 * catalogue. See `src/server/playerShips/PlayerShipStore.ts` for the
 * hydrate path.
 *
 * Bumping rule: any PR that edits a numeric field inside `SHIP_KINDS`
 * MUST bump this value by 1 in the same PR. Mount-layout changes are not
 * auto-handled — they require a separate migration story.
 */
export const SHIP_KIND_CATALOGUE_VERSION = 3;

export const DEFAULT_SHIP_KIND: ShipKindId = 'fighter';

/**
 * Legacy export: the previous build hard-coded `BOOST_MULTIPLIER` in
 * `src/core/physics/World.ts` and several tests imported it from there.
 * Re-exported here so those import sites keep resolving without churn while
 * Phase 2 migrates them. The new authoritative value is per-kind.
 */
export const BOOST_MULTIPLIER = FIGHTER.boostMultiplier;

/**
 * Resolve a (possibly missing or malformed) kind id to a concrete `ShipKind`.
 * Falls back to `DEFAULT_SHIP_KIND` on any unknown / invalid input — this is
 * deliberate so a legacy snapshot or a malformed wire packet can never crash
 * the spawn path.
 */
export function getShipKind(id: string | null | undefined): ShipKind {
  if (id != null && Object.prototype.hasOwnProperty.call(SHIP_KINDS, id)) {
    return (SHIP_KINDS as Record<string, ShipKind>)[id]!;
  }
  return (SHIP_KINDS as Record<string, ShipKind>)[DEFAULT_SHIP_KIND]!;
}

/** Type guard — narrows a string to `ShipKindId` if it's a known kind. */
export function isShipKindId(id: string): id is ShipKindId {
  return Object.prototype.hasOwnProperty.call(SHIP_KINDS, id);
}

/**
 * Index of a kind in `SHIP_KINDS_LIST`. Used by the swarm wire format to
 * encode a drone's kind as a `u8` byte. Returns 0 (the default kind's slot
 * if the default sits at index 0; otherwise the first kind in the list) on
 * unknown ids, so a malformed encode is decoded back to the first kind
 * rather than crashing — same forgiving stance as `getShipKind`.
 */
export function shipKindToIndex(id: ShipKindId): number {
  for (let i = 0; i < SHIP_KINDS_LIST.length; i++) {
    if (SHIP_KINDS_LIST[i]!.id === id) return i;
  }
  return 0;
}

/** Inverse of `shipKindToIndex`. Out-of-range indices fall back to default. */
export function shipKindFromIndex(index: number): ShipKindId {
  const k = SHIP_KINDS_LIST[index];
  return k ? k.id : DEFAULT_SHIP_KIND;
}
