/**
 * Mining-tool range gradient (owner 2026-11-16, plan partitioned-chasing-lark):
 * a mining laser's or tractor's reach = catalogue range × the mount size's
 * `MOUNT_SIZE_TUNING.reach` / the XL one. XL keeps the catalogue range;
 * guns keep their reach at every size.
 */
import { describe, expect, it } from 'vitest';
import { mountWeaponReach, weaponIdReach } from './mountReach.js';
import { getWeapon, weaponAutoFireRange, type WeaponId } from './WeaponCatalogue.js';
import type { MountSize } from '../../shared-types/shipScale/tuning.js';

const SIZES: ReadonlyArray<MountSize | undefined> = ['AA', 'S', 'M', 'L', 'XL', undefined];
/** Expected reach per size: the mining laser (catalogue 12,000 u) and the
 *  tractor (catalogue 3,000 u). */
const WANT: Record<'mining_laser' | 'tractor', Record<MountSize, number>> = {
  mining_laser: { AA: 4364, S: 5455, M: 6818, L: 8727, XL: 12000 },
  tractor: { AA: 1091, S: 1364, M: 1705, L: 2182, XL: 3000 },
};

describe('mountWeaponReach: mining-tool range gradient by mount size', () => {
  for (const id of ['mining_laser', 'tractor'] as const) {
    it(`${id}: XL keeps the catalogue range; smaller mounts reach less`, () => {
      expect(weaponAutoFireRange(getWeapon(id))).toBe(WANT[id].XL);
      for (const size of ['AA', 'S', 'M', 'L', 'XL'] as const) {
        expect(Math.round(mountWeaponReach({ weaponId: id, size }))).toBe(WANT[id][size]);
      }
    });
    it(`${id}: an unsized mount counts as S`, () => {
      expect(mountWeaponReach({ weaponId: id })).toBe(mountWeaponReach({ weaponId: id, size: 'S' }));
    });
  }

  it('guns keep their catalogue reach at every size', () => {
    for (const id of ['hitscan', 'laser', 'autocannon', 'naval_xl', 'railgun'] as WeaponId[]) {
      const base = weaponAutoFireRange(getWeapon(id));
      for (const size of SIZES) expect(mountWeaponReach({ weaponId: id, size })).toBe(base);
    }
  });

  it('weaponIdReach is the same rule as mountWeaponReach', () => {
    for (const id of ['mining_laser', 'tractor', 'laser'] as WeaponId[]) {
      for (const size of SIZES) expect(weaponIdReach(id, size)).toBe(mountWeaponReach({ weaponId: id, size }));
    }
  });
});
