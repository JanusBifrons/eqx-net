import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { TRACTOR_DEF } from './tractorSpec.js';
import { mountPriority } from './mountTargeting.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import {
  SALVAGE_HAUL_DIST_PER_DREF, SALVAGE_HAUL_MIN_ACCEL, SALVAGE_TARGET_CLASS,
  SALVAGE_CONSUME_FRAC, hasMiningTool, isSalvageWeapon, salvageConsumable, salvageConsumeRadius, salvageHaulMass, salvageHaulable, salvagePrefersBig,
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

describe('consumable: a piece this ship can take in whole (the factory line)', () => {
  const withTractor = (id: string) => {
    const k = getShipKind(id);
    return { radius: k.radius, mounts: [...(k.mounts ?? []), mount('t', 'tractor', 'S')] };
  };

  it('the consume radius is SALVAGE_CONSUME_FRAC × the hull radius, 0 with no mining tool', () => {
    const fighter = withTractor('fighter');
    expect(salvageConsumeRadius(fighter)).toBeCloseTo(SALVAGE_CONSUME_FRAC * fighter.radius);
    expect(salvageConsumeRadius({ radius: 100, mounts: [mount('l', 'mining_laser', 'S')] })).toBeCloseTo(SALVAGE_CONSUME_FRAC * 100);
    expect(salvageConsumeRadius(getShipKind('destroyer')), 'naval guns only: consumes nothing').toBe(0);
    expect(hasMiningTool([mount('g', 'naval_m', 'M')])).toBe(false);
  });

  it('a small piece: too big for a fighter, consumable by a big ship', () => {
    const small = { radius: 40, holdWeight: 5 };
    const fighter = salvageConsumeRadius(withTractor('fighter'));
    const big = salvageConsumeRadius(withTractor('battleship'));
    expect(salvageConsumable(small, fighter, 1000)).toBe(false);
    expect(salvageConsumable(small, big, 1000)).toBe(true);
    // A piece bigger than the line's small end is cut first, even by a big ship.
    expect(salvageConsumable({ radius: big * 1.01, holdWeight: 5 }, big, 1000)).toBe(false);
  });

  it('a full hold: not consumable', () => {
    const big = salvageConsumeRadius(withTractor('battleship'));
    expect(salvageConsumable({ radius: 40, holdWeight: 5 }, big, 4)).toBe(false);
    expect(salvageConsumable({ radius: 40, holdWeight: 5 }, big, 5)).toBe(true);
  });
});
