import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { TRACTOR_DEF } from './tractorSpec.js';
import { mountPriority } from './mountTargeting.js';
import {
  SALVAGE_HAUL_DIST_PER_DREF, SALVAGE_HAUL_MIN_ACCEL, SALVAGE_TARGET_CLASS,
  isSalvageWeapon, salvageHaulMass, salvageHaulable, salvagePrefersBig,
  type SalvageCandidate,
} from './salvageTargeting.js';

const mount = (id: string, weaponId: WeaponMount['weaponId'], size?: WeaponMount['size']): WeaponMount => ({
  id, localX: 0, localY: 0, baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 1, weaponId,
  ...(size !== undefined ? { size } : {}),
});
const piece = (id: string, x: number, mass: number, holdWeight = 1, radius = 10): SalvageCandidate =>
  ({ id, x, y: 0, radius, mass, holdWeight });

describe('salvage targeting (salvage PR 16)', () => {
  it('only a mining weapon picks salvage (its rock factor, not its id)', () => {
    expect(isSalvageWeapon(getWeapon('mining_laser'))).toBe(true);
    expect(isSalvageWeapon(getWeapon('naval_m'))).toBe(false);
    expect(isSalvageWeapon(getWeapon('heavy_beam'))).toBe(false);
    expect(isSalvageWeapon(getWeapon('tractor'))).toBe(false);
  });

  it('salvage is the last choice for every combat mount', () => {
    for (const size of ['AA', 'S', 'M', 'L', 'XL', undefined] as const) {
      for (const cls of ['small', 'subcapital', 'small-capital', 'capital', 'structure'] as const) {
        expect(mountPriority(size, SALVAGE_TARGET_CLASS)).toBeGreaterThan(mountPriority(size, cls));
      }
    }
  });

  it('haul mass: the strongest tractor record force × size power, at the haul distance falloff, over the min accel', () => {
    const t = TRACTOR_DEF.tractor!;
    const falloff = 1 / (SALVAGE_HAUL_DIST_PER_DREF * SALVAGE_HAUL_DIST_PER_DREF);
    expect(salvageHaulMass([mount('a', 'mining_laser', 'XL')])).toBe(0);
    expect(salvageHaulMass([mount('t', 'tractor', 'S')])).toBeCloseTo((t.force * falloff) / SALVAGE_HAUL_MIN_ACCEL);
    // One tractor per piece: the strongest single mount, never the sum.
    const mixed = [mount('t1', 'tractor', 'AA'), mount('t2', 'tractor', 'XL'), mount('t3', 'tractor', 'S')];
    const want = (t.force * MOUNT_SIZE_TUNING.XL.power * falloff) / SALVAGE_HAUL_MIN_ACCEL;
    expect(salvageHaulMass(mixed)).toBeCloseTo(want);
    expect(salvageHaulMass([mount('a', 'tractor', 'XL'), mount('b', 'tractor', 'XL')])).toBeCloseTo(want);
  });

  it('a piece this ship can tractor AND store is haulable (no laser target)', () => {
    const light = piece('light', 100, 50, 5);
    const heavy = piece('heavy', 200, 5000, 5);
    expect(salvageHaulable(light, 150, 100)).toBe(true);
    expect(salvageHaulable(heavy, 150, 100)).toBe(false);
    // Hold full: the light piece can't be stored, so the laser cuts it.
    expect(salvageHaulable(light, 150, 2)).toBe(false);
    // No tractor (haul mass 0): every piece is cut.
    expect(salvageHaulable(light, 0, 100)).toBe(false);
  });

  it('heavy mounts (M/L/XL) prefer big pieces, light ones (AA/S/unsized) small', () => {
    for (const s of ['M', 'L', 'XL'] as const) expect(salvagePrefersBig(s)).toBe(true);
    for (const s of ['AA', 'S', undefined] as const) expect(salvagePrefersBig(s)).toBe(false);
  });
});
