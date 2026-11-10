/**
 * Naval guns are in ABSOLUTE units (real-scale naval ranges, slice 1): the
 * `naval_*` weapons are exempt from the ship-scale combat profile, and their
 * authored numbers are the ones the shipped game (2× B) already ran, so the
 * change is a no-op there. Sub-capital weapons still follow the profile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeaponDef, WeaponId } from '../../src/core/combat/WeaponCatalogue.js';
import { getWeapon, scaleWeaponDef, weaponAutoFireRange } from '../../src/core/combat/WeaponCatalogue.js';
import { AT_AUTHORED_SHIP_SCALE } from '../../src/shared-types/shipScale/config.js';

const NAVAL: readonly WeaponId[] = ['naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege'];
const SUB_CAPITAL: readonly WeaponId[] = ['hitscan', 'laser', 'heat-seeker', 'pulse-orb', 'charge-laser', 'autocannon'];

/** The naval records as authored at 1× BEFORE this change (origin/main). */
const PRE_CHANGE_1X: Record<string, { speed: number; maxTicks: number; splash?: { radius: number; falloffMin: number } }> = {
  naval_s: { speed: 1800, maxTicks: 60 },
  naval_m: { speed: 2000, maxTicks: 83 },
  naval_l: { speed: 2200, maxTicks: 104 },
  naval_xl: { speed: 2300, maxTicks: 110 },
  naval_xxl: { speed: 2600, maxTicks: 140 },
  naval_siege: { speed: 1900, maxTicks: 160, splash: { radius: 160, falloffMin: 30 } },
};

/** Import a fresh catalogue under the given ship scale + combat profile. */
async function catalogueAt(scale: string, tuning: 'A' | 'B'): Promise<typeof import('../../src/core/combat/WeaponCatalogue.js')> {
  vi.stubEnv('EQX_SHIP_SCALE', scale);
  vi.stubEnv('EQX_SHIP_TUNING', tuning);
  vi.resetModules();
  return import('../../src/core/combat/WeaponCatalogue.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('naval guns are absolute (exempt from the combat profile)', () => {
  it('reach, flight and splash are the same under profile A at 1× and profile B at 2×', async () => {
    const a = await catalogueAt('1', 'A');
    const b = await catalogueAt('2', 'B');
    for (const id of NAVAL) {
      expect(a.getWeapon(id), id).toEqual(b.getWeapon(id));
      expect(a.weaponAutoFireRange(a.getWeapon(id)), id).toBe(b.weaponAutoFireRange(b.getWeapon(id)));
    }
  });

  it('the shipped (2× B) numbers are byte-identical to before: the old 1× record × the old profile', async () => {
    const shipped = await catalogueAt('2', 'B');
    for (const id of NAVAL) {
      const now = shipped.getWeapon(id);
      const old = PRE_CHANGE_1X[id]!;
      // What `profiled` produced in the shipped game before (reach ×1.5, splash ×2).
      const before = scaleWeaponDef({ ...now, ...old } as WeaponDef, 1.5, 2);
      expect(now, id).toEqual(before);
    }
    const gustav = shipped.getWeapon('naval_siege');
    expect(gustav.mode === 'projectile' && gustav.splash).toEqual({ radius: 320, falloffMin: 60 });
  });

  it('sub-capital weapons still follow the profile (unchanged)', async () => {
    const a = await catalogueAt('1', 'A');
    const b = await catalogueAt('2', 'B');
    for (const id of SUB_CAPITAL) {
      expect(b.getWeapon(id), id).toEqual(scaleWeaponDef(a.getWeapon(id), 1.5, 2));
    }
  });

  it('the engage reach the shipped game used is unchanged', () => {
    // weaponAutoFireRange in the shipped game before this change.
    const expected: Record<string, number> = {
      naval_s: 2295, naval_m: 3541.6666666666665, naval_l: 4862, naval_xl: 5376.25, naval_xxl: 7735, naval_siege: 6460,
    };
    for (const id of NAVAL) expect(weaponAutoFireRange(getWeapon(id)), id).toBeCloseTo(expected[id]!, 9);
  });
});

describe.runIf(AT_AUTHORED_SHIP_SCALE)('at the authored scale (1× A)', () => {
  it('naval guns keep their absolute reach; sub-capital weapons keep their 1× numbers', () => {
    expect(getWeapon('naval_xl').mode === 'projectile' && getWeapon('naval_xl')).toMatchObject({ speed: 2300, maxTicks: 165 });
    expect(getWeapon('naval_siege').mode === 'projectile' && getWeapon('naval_siege')).toMatchObject({ maxTicks: 240, splash: { radius: 320, falloffMin: 60 } });
    expect(getWeapon('autocannon').mode === 'projectile' && getWeapon('autocannon')).toMatchObject({ maxTicks: 36 });
  });
});
