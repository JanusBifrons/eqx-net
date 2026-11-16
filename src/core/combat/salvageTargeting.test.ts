import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { TRACTOR_DEF } from './tractorSpec.js';
import { mountPriority } from './mountTargeting.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import {
  SALVAGE_HAUL_DIST_PER_DREF, SALVAGE_HAUL_MIN_ACCEL, SALVAGE_TARGET_CLASS,
  SALVAGE_CONSUME_FRAC, SALVAGE_TIER_NONE, SALVAGE_TIER_SIZES, hasMiningTool, isSalvageWeapon, laserCutsTier, mountTier,
  salvageConsumable, salvageConsumeRadius, salvagePrefersBig, salvageTier, salvageTierMass, tractorTakesTier,
} from './salvageTargeting.js';

const mount = (id: string, weaponId: WeaponMount['weaponId'], size?: WeaponMount['size']): WeaponMount => ({
  id, localX: 0, localY: 0, baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 1, weaponId,
  ...(size !== undefined ? { size } : {}),
});

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

  it('tier mass per size: the tractor record force × size power, at the haul distance falloff, over the min accel', () => {
    const t = TRACTOR_DEF.tractor!;
    const falloff = 1 / (SALVAGE_HAUL_DIST_PER_DREF * SALVAGE_HAUL_DIST_PER_DREF);
    for (const size of SALVAGE_TIER_SIZES) {
      expect(salvageTierMass(size)).toBeCloseTo((t.force * MOUNT_SIZE_TUNING[size].power * falloff) / SALVAGE_HAUL_MIN_ACCEL);
    }
    // Today's numbers (the docs quote them).
    expect(SALVAGE_TIER_SIZES.map((z) => Math.round(salvageTierMass(z)))).toEqual([60, 150, 375, 900, 2250]);
  });

  it('a piece\'s tier is the smallest size whose tractor pulls it, at every size boundary', () => {
    expect(salvageTier(0)).toBe(1);
    SALVAGE_TIER_SIZES.forEach((size, i) => {
      const lim = salvageTierMass(size);
      expect(salvageTier(lim), `${size} limit itself`).toBe(i + 1);
      expect(salvageTier(lim * 1.0001), `just past ${size}`).toBe(i + 2 > SALVAGE_TIER_SIZES.length ? SALVAGE_TIER_NONE : i + 2);
      expect(mountTier(size)).toBe(i + 1);
    });
    expect(salvageTier(1e9)).toBe(SALVAGE_TIER_NONE);
    expect(salvageTier(Infinity), 'a field rock').toBe(SALVAGE_TIER_NONE);
    expect(salvageTier(NaN)).toBe(SALVAGE_TIER_NONE);
    expect(mountTier(undefined), 'unsized = S (the tractor power rule)').toBe(mountTier('S'));
  });

  it('the ladder: a laser cuts only pieces above its size, a tractor pulls only pieces at or below it', () => {
    const L = mountTier('L');
    expect(laserCutsTier(mountTier('XL'), L), 'an XL laser leaves an L-tier piece').toBe(false);
    expect(laserCutsTier(mountTier('S'), L), 'an S laser cuts it').toBe(true);
    expect(laserCutsTier(L, L)).toBe(false);
    expect(laserCutsTier(mountTier('XL'), SALVAGE_TIER_NONE), 'every laser cuts a piece no tractor pulls').toBe(true);
    expect(tractorTakesTier(L, L), 'an L tractor takes an L-tier piece').toBe(true);
    expect(tractorTakesTier(mountTier('S'), L), 'an S tractor ignores it').toBe(false);
    expect(tractorTakesTier(mountTier('XL'), SALVAGE_TIER_NONE), 'no tractor pulls a piece too big for all').toBe(false);
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
