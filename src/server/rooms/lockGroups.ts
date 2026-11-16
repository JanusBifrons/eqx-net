/**
 * A ship's weapon groups for fire control (`LockSubsystem`): its slots, with
 * activated latent mounts as their own 'wing' group. Split out of
 * LockSubsystem.ts (god-file cap). Runs on a ship (re)build, never per tick.
 */
import type { ShipKind, WeaponMount, WeaponSlot } from '../../shared-types/shipKinds/types.js';

/** Weapon groups of a ship: its slots, with activated latent mounts as their own 'wing' group. */
export function shipGroups(
  kind: ShipKind,
  activated: ReadonlyArray<WeaponMount>,
): Array<{ slot: WeaponSlot; mounts: WeaponMount[] }> {
  const out: Array<{ slot: WeaponSlot; mounts: WeaponMount[] }> = [];
  const byId = new Map<string, WeaponMount>();
  for (const m of kind.mounts ?? []) byId.set(m.id, m);
  for (const slot of kind.slots ?? []) {
    const mounts: WeaponMount[] = [];
    for (const id of slot.mountIds) {
      const m = byId.get(id);
      if (m) mounts.push(m);
    }
    if (mounts.length > 0) out.push({ slot, mounts });
  }
  if (activated.length > 0) {
    out.push({ slot: { id: 'wing', displayName: 'Wing', mountIds: activated.map((m) => m.id) }, mounts: [...activated] });
  }
  return out;
}
