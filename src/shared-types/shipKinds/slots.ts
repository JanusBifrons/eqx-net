/**
 * Pure slot → mount resolution. Lives in `src/shared-types/` (pure TS, no
 * runtime deps) so BOTH `src/core` (energy-cost math) and `src/server`
 * (fire path) resolve a ship-kind's active slot to its mount list through
 * the SAME function — single ownership of the slot-resolution policy.
 *
 * Extracted from `src/server/rooms/mountGeometry.ts` (which now re-exports
 * this) when the energy system needed the same lookup in `src/core` without
 * a server import (boundary invariant #1). The semantics are byte-for-byte
 * what `mountGeometry.resolveSlotMounts` did before.
 */

import type { ShipKind, WeaponMount } from './types.js';

/**
 * Resolve a ship's active slot to the ordered mount list it covers.
 * Returns an empty array when the ship-kind has no mounts/slots
 * (defensive — every shipped kind has them, but a malformed catalogue
 * shouldn't crash the room).
 *
 * When `slotId` is undefined, falls back to the first slot in catalogue
 * order. When the named slot isn't found, also falls back to the first
 * slot — matches the pre-2c "primary == default" semantics.
 */
export function resolveSlotMounts(
  kind: ShipKind,
  slotId?: string,
): ReadonlyArray<WeaponMount> {
  const mounts = kind.mounts;
  const slots = kind.slots;
  if (!mounts || !slots || slots.length === 0) return [];
  const slot = slotId ? slots.find((s) => s.id === slotId) ?? slots[0]! : slots[0]!;
  const out: WeaponMount[] = [];
  for (const mid of slot.mountIds) {
    const m = mounts.find((mm) => mm.id === mid);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Resolve a ship's active slot record (not just its mounts). Same fallback
 * semantics as {@link resolveSlotMounts}. Returns `undefined` when the kind
 * has no slots.
 */
export function resolveSlot(kind: ShipKind, slotId?: string) {
  const slots = kind.slots;
  if (!slots || slots.length === 0) return undefined;
  return slotId ? slots.find((s) => s.id === slotId) ?? slots[0]! : slots[0]!;
}
