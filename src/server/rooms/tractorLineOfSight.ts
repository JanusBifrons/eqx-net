/**
 * The lock hand-over's salvage-tool line of sight (lockSalvage.ts
 * `salvageLineClear`): does a tractor dish (or, `laser`, a mining-laser
 * mount) of a ship have a clear line to a lock key? The beam's own query
 * (`LineOfFireGate.firstOnLine` from each mount's muzzle, as
 * `setTractorMuzzle` places it), stopping at the first clear mount. Loot pods
 * never block (as for every beam). Allocation-free (#14).
 */
import { getShipKind, type ShipKindId, type WeaponMount } from '../../shared-types/shipKinds.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { isSalvageWeapon } from '../../core/combat/salvageTargeting.js';

/** No mounts (#14). */
const NO_MOUNTS: ReadonlyArray<WeaponMount> = [];

export interface TractorLineHost {
  /** The lock key's target position into `out` (and its gate id); false when it is not a live swarm body. */
  target(key: string, out: { x: number; y: number; id: string }): boolean;
  /** The ship's activated extra mounts (level-ups), if any. */
  activatedMounts(emitterId: string): ReadonlyArray<WeaponMount> | undefined;
  /** The first body on the line that is not a loot pod, or '' when clear. */
  firstOnLine(fx: number, fy: number, tx: number, ty: number, skipId: string, targetId: string): string;
}

const T = { x: 0, y: 0, id: '' };

/** True when a tractor dish (`laser`: a mining-laser mount) of ship `kind`
 *  (gate body `emitterId`, pose `p`) has a clear line to `key`. No ship, no
 *  pose, not a swarm key or no such mount: clear. */
export function salvageLineClear(
  host: TractorLineHost, emitterId: string, kind: ShipKindId | undefined,
  p: { x: number; y: number; angle: number } | undefined, key: string, laser = false,
): boolean {
  if (kind === undefined || p === undefined || !host.target(key, T)) return true;
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  let any = false;
  for (let pass = 0; pass < 2; pass++) {
    const mounts = pass === 0 ? getShipKind(kind).mounts ?? NO_MOUNTS : host.activatedMounts(emitterId) ?? NO_MOUNTS;
    for (let i = 0; i < mounts.length; i++) {
      const m = mounts[i]!;
      const w = getWeapon(m.weaponId);
      if (laser ? !isSalvageWeapon(w) : w.tractor === undefined) continue;
      any = true;
      const mx = p.x + (m.localX * c - m.localY * s), my = p.y + (m.localX * s + m.localY * c);
      if (host.firstOnLine(mx, my, T.x, T.y, emitterId, T.id) === '') return true;
    }
  }
  return !any;
}
