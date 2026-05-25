/**
 * Pure mount/slot geometry helpers. Extracted from the monolithic
 * `SectorRoom.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 21 prep). Both are
 * stateless functions of their arguments — no `this`, no class state.
 *
 * The server's `handleFire` + `handleAiFire` path resolves the active
 * slot's mounts via {@link resolveSlotMounts}, then for each mount
 * computes the world-pivot via {@link mountWorldOrigin} and adds the
 * 20 u barrel offset along the mount's fire direction. Same call
 * shape `WeaponMountTicker` will adopt when commit 21's full extraction
 * lands.
 */

import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds.js';

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
 * Compute the per-mount world origin given a ship's pose and the mount's
 * ship-local offset. The ship's `angle` rotates the mount's local coords
 * into world space; the result is the world position of the mount's pivot
 * (before the 20 u / 16 u barrel offset applied by callers along the
 * mount's fire direction).
 *
 * Mirrors the client's `applyMountOffset` helper byte-for-byte (the
 * client uses the function with the same math under a different name
 * because both server and client must produce identical mount-pivot
 * coords for lockstep beam geometry).
 */
export function mountWorldOrigin(
  shipX: number,
  shipY: number,
  shipAngle: number,
  mount: WeaponMount,
): { x: number; y: number } {
  const cosA = Math.cos(shipAngle);
  const sinA = Math.sin(shipAngle);
  return {
    x: shipX + (mount.localX * cosA - mount.localY * sinA),
    y: shipY + (mount.localX * sinA + mount.localY * cosA),
  };
}
