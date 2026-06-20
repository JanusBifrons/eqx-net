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
 * One activated latent mount slot (Phase 4 WS-B3). Rides the player
 * `ShipState`/roster `mounts` JSON — `slotId` names a `ShipKind.latentMounts`
 * entry, `weaponId` is the player's chosen weapon for it. The GEOMETRY for the
 * slot is looked up from the catalogue (never on the wire). This is the
 * shared-types twin of `ActivatedMount` in `PlayerShipStore` — kept here so the
 * pure resolvers below + the wire schema stay self-contained. */
export interface ActivatedMountSpec {
  slotId: string;
  weaponId: string;
}

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

// ───────────────────────────────────────────────────────────────────────────
// Dynamic weapon mounts (Phase 4 WS-B3, plan: effervescent-umbrella).
//
// Activated latent mounts ride the player ShipState/roster as a list of
// `ActivatedMountSpec` ({ slotId, weaponId }). The GEOMETRY for an activated
// slot is looked up from `ShipKind.latentMounts` by `slotId` — never on the
// wire (the same trick as scrap colliders). These three resolvers are the ONE
// place that mapping lives; the server (aim + fire) and the client (predicted
// aim + beam + render) all route through them, so the per-instance mount list
// is identical on both sides (lockstep, invariant #12).
// ───────────────────────────────────────────────────────────────────────────

/** Empty frozen list — the un-upgraded fallback. Returning the SAME reference
 *  for every un-upgraded resolve avoids a per-call `[]` literal (invariant
 *  #14; these resolvers run in the per-tick aim + fire path). */
const EMPTY_MOUNTS: ReadonlyArray<WeaponMount> = Object.freeze([]);

/**
 * Resolve a ship instance's ACTIVATED latent mounts as full `WeaponMount`s.
 *
 * For each `{ slotId, weaponId }` in `activated`, finds the matching
 * `kind.latentMounts` entry and returns it WITH the player's chosen `weaponId`
 * substituted for the catalogue default. Order follows `kind.latentMounts`
 * (deterministic — both sides iterate the catalogue, NOT the roster list, so a
 * differently-ordered roster JSON can't desync the index space). A
 * `slotId` that names no latent mount is ignored (defensive — a malformed
 * roster row must not crash the fire path); a duplicate `slotId` activates the
 * slot once. Empty `activated` (or a kind with no `latentMounts`) ⇒ the shared
 * empty list (byte-identical to un-upgraded).
 */
export function resolveActivatedMounts(
  kind: ShipKind,
  activated: ReadonlyArray<ActivatedMountSpec> | undefined,
): ReadonlyArray<WeaponMount> {
  const latent = kind.latentMounts;
  if (!latent || latent.length === 0 || !activated || activated.length === 0) {
    return EMPTY_MOUNTS;
  }
  const out: WeaponMount[] = [];
  // Iterate the CATALOGUE latent list (stable order); for each, check whether
  // it's activated. First matching activation wins (de-dupes).
  for (const lm of latent) {
    const act = activated.find((a) => a.slotId === lm.id);
    if (!act) continue;
    // Geometry from the catalogue; weapon from the player's choice. Spread so
    // the catalogue's frozen mount is not mutated.
    out.push({ ...lm, weaponId: act.weaponId } as WeaponMount);
  }
  return out;
}

/**
 * Resolve a ship instance's FULL mount list — `[...kind.mounts, ...activated
 * latent mounts]`. This is the per-instance index space for `mountAngles[]`
 * (base mounts keep their catalogue indices; activated latent mounts append)
 * AND the renderer's per-instance turret list. Un-upgraded ⇒ the base mount
 * list reference (byte-identical to `kind.mounts`).
 */
export function resolveInstanceMounts(
  kind: ShipKind,
  activated: ReadonlyArray<ActivatedMountSpec> | undefined,
): ReadonlyArray<WeaponMount> {
  const base = kind.mounts ?? EMPTY_MOUNTS;
  const activatedMounts = resolveActivatedMounts(kind, activated);
  if (activatedMounts.length === 0) return base;
  const out: WeaponMount[] = [];
  for (const m of base) out.push(m);
  for (const m of activatedMounts) out.push(m);
  return out;
}

/**
 * Resolve a ship instance's FIRING mount set — the active slot's base mounts
 * PLUS every activated latent mount. Activated latent mounts always fire (they
 * are not bound to a slot; the player owns the hardpoint outright). Un-upgraded
 * ⇒ exactly the active slot's mounts (no behaviour change).
 */
export function resolveInstanceFireMounts(
  kind: ShipKind,
  activated: ReadonlyArray<ActivatedMountSpec> | undefined,
  slotId?: string,
): ReadonlyArray<WeaponMount> {
  const slotMounts = resolveSlotMounts(kind, slotId);
  const activatedMounts = resolveActivatedMounts(kind, activated);
  if (activatedMounts.length === 0) return slotMounts;
  const out: WeaponMount[] = [];
  for (const m of slotMounts) out.push(m);
  for (const m of activatedMounts) out.push(m);
  return out;
}

/** True iff `slotId` names a real latent hardpoint on `kind` (the server's
 *  authoritative "is this a legal slot to activate" gate). */
export function isLatentSlot(kind: ShipKind, slotId: string): boolean {
  const latent = kind.latentMounts;
  if (!latent) return false;
  for (const lm of latent) if (lm.id === slotId) return true;
  return false;
}
