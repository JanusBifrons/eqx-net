import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { TRACTOR_DEF } from './tractorSpec.js';
import { mountPriority } from './mountTargeting.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import {
  SALVAGE_HAUL_DIST_PER_DREF, SALVAGE_HAUL_MIN_ACCEL, SALVAGE_TARGET_CLASS,
  SALVAGE_TIER_NONE, SALVAGE_TIER_SIZES, hasMiningTool, isSalvageWeapon, laserCutsTier, laserRungMask, mountTier,
  ROCK_CHUNK_MIN_WEIGHT, rockChunkWeight, salvageConsumable, salvageConsumeMass, salvagePrefersBig, salvageTier, salvageTierMass, tractorTakesTier,
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

  it('the ladder: only the matching size fires (a laser one tier below the piece; XL on tier none)', () => {
    const all = laserRungMask(SALVAGE_TIER_SIZES.map((s) => mount(s, 'mining_laser', s)));
    const L = mountTier('L');
    expect(laserCutsTier(mountTier('XL'), L, all), 'an XL laser leaves an L-tier piece').toBe(false);
    expect(laserCutsTier(mountTier('S'), L, all), 'an S laser leaves it too: the M laser cuts it').toBe(false);
    expect(laserCutsTier(mountTier('M'), L, all), 'the M laser cuts an L-tier piece').toBe(true);
    expect(laserCutsTier(L, L, all)).toBe(false);
    expect(laserCutsTier(mountTier('XL'), SALVAGE_TIER_NONE, all), 'XL cuts a piece no tractor pulls').toBe(true);
    expect(laserCutsTier(mountTier('L'), SALVAGE_TIER_NONE, all), 'L leaves it to the XL').toBe(false);
    for (const k of SALVAGE_TIER_SIZES) expect(laserCutsTier(mountTier(k), mountTier('AA'), all), `${k}: nothing cuts an AA-tier piece`).toBe(false);
  });

  it('no laser of the needed size: the next smaller size the ship has cuts those pieces', () => {
    // The barge: XL, L, M and AA lasers, no S.
    const barge = laserRungMask(getShipKind('barge').mounts ?? []);
    expect(laserCutsTier(mountTier('AA'), mountTier('M'), barge), 'AA lasers take the M-tier pieces (no S laser)').toBe(true);
    expect(laserCutsTier(mountTier('AA'), mountTier('S'), barge)).toBe(true);
    expect(laserCutsTier(mountTier('M'), mountTier('M'), barge)).toBe(false);
    const smallOnly = laserRungMask([mount('a', 'mining_laser', 'S')]);
    expect(laserCutsTier(mountTier('S'), SALVAGE_TIER_NONE, smallOnly), 'an S-only miner still cuts a field rock').toBe(true);
    expect(laserCutsTier(mountTier('S'), mountTier('XL'), smallOnly)).toBe(true);
    expect(laserCutsTier(mountTier('S'), mountTier('S'), smallOnly), 'below its size: none smaller, nobody cuts').toBe(false);
    expect(laserRungMask([mount('t', 'tractor', 'XL')]), 'tractors are not lasers').toBe(0);
  });

  it('a tractor pulls only pieces at or below its size', () => {
    const L = mountTier('L');
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

  const AA = salvageTierMass('AA');
  /** A fighter and a destroyer given a tractor, and the barge as built. */
  const ships = (): Array<[string, { radius: number; mounts?: ReadonlyArray<WeaponMount> }]> =>
    [['fighter', withTractor('fighter')], ['destroyer', withTractor('destroyer')], ['barge', getShipKind('barge')]];

  it('hold size is the smallest size (the AA tier), the same on every ship; nothing without a mining tool', () => {
    for (const [id, k] of ships()) expect(salvageConsumeMass(k), id).toBe(AA);
    expect(salvageConsumeMass({ mounts: [mount('l', 'mining_laser', 'S')] })).toBe(AA);
    expect(salvageConsumeMass(getShipKind('destroyer')), 'naval guns only: consumes nothing').toBe(0);
    expect(hasMiningTool([mount('g', 'naval_m', 'M')])).toBe(false);
  });

  it('consumable only at the AA tier, on a fighter, a destroyer and a barge alike', () => {
    expect(salvageTier(AA * 1.01)).toBe(mountTier('S'));
    for (const [id, k] of ships()) {
      const m = salvageConsumeMass(k);
      expect(salvageConsumable({ mass: AA, holdWeight: 5 }, m, 1000), `${id}: an AA-tier piece`).toBe(true);
      expect(salvageConsumable({ mass: 1, holdWeight: 5 }, m, 1000), `${id}: a crumb`).toBe(true);
      expect(salvageConsumable({ mass: AA * 1.01, holdWeight: 5 }, m, 1000), `${id}: an S-tier piece is cut first`).toBe(false);
      expect(salvageConsumable({ mass: Infinity, holdWeight: Infinity }, m, 1000), `${id}: a field rock`).toBe(false);
    }
    expect(salvageConsumable({ mass: 1, holdWeight: 1 }, 0, 1000), 'no mining tool').toBe(false);
  });

  it('a rock piece goes in whole as one chunk: only its weight against the free hold counts', () => {
    const m = salvageConsumeMass(getShipKind('barge'));
    const ore = { rockId: 'r', resource: 'rock', perArea: 1 } as const;
    expect(salvageConsumable({ mass: 1, holdWeight: 250, ore }, m, 1000)).toBe(true);
    expect(salvageConsumable({ mass: m * 50, holdWeight: 900, ore }, m, 1000), 'no mass cap for a chunk').toBe(true);
    expect(salvageConsumable({ mass: 1, holdWeight: 1200, ore }, m, 1000), 'too heavy for the free hold').toBe(false);
    expect(salvageConsumable({ mass: 1, holdWeight: 250, ore }, 0, 1000), 'no mining tool').toBe(false);
    expect(salvageConsumable({ mass: m * 50, holdWeight: 5, ore: undefined }, m, 1000), 'a big wreck piece is still cut first').toBe(false);
  });

  it('a rock chunk weighs at least 250 and grows with its mass', () => {
    expect(rockChunkWeight(0)).toBe(ROCK_CHUNK_MIN_WEIGHT);
    expect(rockChunkWeight(1)).toBe(ROCK_CHUNK_MIN_WEIGHT);
    expect(rockChunkWeight(1e12)).toBeGreaterThan(ROCK_CHUNK_MIN_WEIGHT);
    expect(rockChunkWeight(2e12)).toBeGreaterThan(rockChunkWeight(1e12));
  });

  it('a full hold: not consumable', () => {
    const m = salvageConsumeMass(withTractor('battleship'));
    expect(salvageConsumable({ mass: 10, holdWeight: 5 }, m, 4)).toBe(false);
    expect(salvageConsumable({ mass: 10, holdWeight: 5 }, m, 5)).toBe(true);
  });
});
