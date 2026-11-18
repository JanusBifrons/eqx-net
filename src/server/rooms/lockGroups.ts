/**
 * A ship's weapon groups for fire control (`LockSubsystem`): its slots, with
 * activated latent mounts as their own 'wing' group. Split out of
 * LockSubsystem.ts (god-file cap), with each group's lock geometry and arcs.
 * Runs on a ship (re)build, never per tick.
 */
import { WEAPON_LOCK_PROFILE, type MountSize } from '../../shared-types/combat/lockProfile.js';
import { mountWeaponReach } from '../../core/combat/mountReach.js';
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

const SIZE_RANK: Record<MountSize | 'none', number> = { none: 0, AA: 1, S: 2, M: 3, L: 4, XL: 5 };

/** Build a group's lock geometry from its mounts (largest size wins). */
export function groupGeometry(mounts: ReadonlyArray<WeaponMount>): {
  refSize: number; tracking: number; reach: number; absRange: boolean; size: WeaponMount['size'];
} {
  let size: MountSize | 'none' = 'none';
  let reach = 0;
  for (const m of mounts) {
    const s = (m.size ?? 'none') as MountSize | 'none';
    if (SIZE_RANK[s] > SIZE_RANK[size]) size = s;
    const r = mountWeaponReach(m);
    if (r > reach) reach = r;
  }
  const p = WEAPON_LOCK_PROFILE[size];
  return { refSize: p.refSize, tracking: p.tracking, reach, absRange: p.absRange, size: size === 'none' ? undefined : size };
}

/** Half-width (rad) a fixed gun counts as bearing on a target. */
const FIXED_BEAR = 0.3;

/** Relative arcs a group's barrels cover: [lo, hi] per mount. */
export function groupArcs(mounts: ReadonlyArray<WeaponMount>): number[] {
  const out: number[] = [];
  for (const m of mounts) {
    const fixed = m.arcMin === m.arcMax;
    out.push(m.baseAngle + (fixed ? -FIXED_BEAR : m.arcMin), m.baseAngle + (fixed ? FIXED_BEAR : m.arcMax));
  }
  return out;
}
