/**
 * The naval range switch (ranges plan slice 14, owner decision 2026-11-10):
 * `EQX_NAVAL_RANGE=legacy` (default) leaves every naval gun as it was;
 * `real` gives each gun its real maximum range in the game's km (1 km =
 * 1,000 u) as its ENGAGE reach, with the time of flight real ÷ 3.
 *
 * Both sides build the catalogue from the same switch (#15): the server stamps
 * its mode on the welcome and the client checks it; workers get it in their
 * name. Sub-capital weapons are untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeaponId } from '../../src/core/combat/WeaponCatalogue.js';
import {
  LEGACY_NAVAL_GUN_BALLISTICS, REAL_NAVAL_GUNS, REAL_NAVAL_GUN_BALLISTICS, navalGunEngageReach,
  navalGunBallisticsFor, projectileEngageReach,
} from '../../src/shared-types/combat/navalGuns.js';
import {
  NAVAL_RANGE, navalRangeMismatch, navalRangeWorkerNameSuffix, resolveNavalRange, stampNavalRange,
} from '../../src/shared-types/combat/navalRange.js';
import { WelcomeSchema } from '../../src/shared-types/messages/snapshotMessages.js';

type Catalogue = typeof import('../../src/core/combat/WeaponCatalogue.js');
type Structures = typeof import('../../src/shared-types/structureKinds.js');

const NAVAL = ['naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege'] as const;
const SUB_CAPITAL: readonly WeaponId[] = ['hitscan', 'laser', 'heat-seeker', 'pulse-orb', 'charge-laser', 'autocannon'];

/** The owner's table: reach (u) and game flight (s), shell speed (u/s). */
const TABLE = {
  naval_s: { reach: 16_600, flight: 19.3, speed: 860 },
  naval_m: { reach: 25_500, flight: 24, speed: 1_060 },
  naval_l: { reach: 35_000, flight: 28, speed: 1_250 },
  naval_xl: { reach: 38_700, flight: 30, speed: 1_290 },
  naval_siege: { reach: 47_000, flight: 32.7, speed: 1_440 },
  naval_xxl: { reach: 56_000, flight: 35.7, speed: 1_570 },
} as const;

async function loadAt(mode: string | undefined): Promise<{ cat: Catalogue; sk: Structures }> {
  if (mode !== undefined) vi.stubEnv('EQX_NAVAL_RANGE', mode);
  vi.resetModules();
  const cat = await import('../../src/core/combat/WeaponCatalogue.js');
  const sk = await import('../../src/shared-types/structureKinds.js');
  return { cat, sk };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('naval range switch — resolution', () => {
  it('is legacy unless asked for real, from env, page global or worker name', () => {
    expect(resolveNavalRange({})).toBe('legacy');
    expect(resolveNavalRange({ env: { EQX_NAVAL_RANGE: 'real' } })).toBe('real');
    expect(resolveNavalRange({ env: { EQX_NAVAL_RANGE: 'bogus' } })).toBe('legacy');
    expect(resolveNavalRange({ global: { __EQX_NAVAL_RANGE__: 'real' } })).toBe('real');
    expect(resolveNavalRange({ workerName: `renderer;shipScale=2${navalRangeWorkerNameSuffix('real')}` })).toBe('real');
    expect(resolveNavalRange({ workerName: `renderer;shipScale=2${navalRangeWorkerNameSuffix('legacy')}` })).toBe('legacy');
  });

  it('the default process (no env) runs legacy', () => {
    if (process.env['EQX_NAVAL_RANGE'] === undefined) expect(NAVAL_RANGE).toBe('legacy');
  });
});

describe('naval range switch — catalogue', () => {
  it('legacy: the naval records are unchanged', async () => {
    const { cat } = await loadAt('legacy');
    for (const id of NAVAL) {
      const d = cat.getWeapon(id);
      if (d.mode !== 'projectile') throw new Error(id);
      expect({ speed: d.speed, maxTicks: d.maxTicks }).toEqual(LEGACY_NAVAL_GUN_BALLISTICS[id]);
    }
    // The 16" engages at the shipped ~5,376 u.
    expect(Math.round(cat.weaponAutoFireRange(cat.getWeapon('naval_xl')))).toBe(5376);
  });

  it('real: engage reach = the real max range, flight = real ÷ 3, speeds match the table', async () => {
    const { cat } = await loadAt('real');
    for (const id of NAVAL) {
      const d = cat.getWeapon(id);
      if (d.mode !== 'projectile') throw new Error(id);
      const row = TABLE[id];
      expect({ speed: d.speed, maxTicks: d.maxTicks }).toEqual(REAL_NAVAL_GUN_BALLISTICS[id]);
      // Engage reach: the real range, never short of it, < 1 tick of travel over.
      const engage = cat.weaponAutoFireRange(d);
      expect(engage).toBeGreaterThanOrEqual(row.reach);
      expect(engage - row.reach).toBeLessThan(d.speed / 60);
      // Time to max range = real ÷ 3 (the table, to its rounding).
      expect(row.reach / d.speed).toBeCloseTo(row.flight, 0);
      expect(Math.abs(row.reach / d.speed - REAL_NAVAL_GUNS[id].realFlightS / 3)).toBeLessThan(0.02);
      expect(Math.abs(d.speed - row.speed) / row.speed).toBeLessThan(0.01);
      // The shell covers its flight to max range (with the 0.85 engage margin).
      expect(d.maxTicks).toBeGreaterThan((row.reach / d.speed) * 60);
      expect((d.maxTicks / 60) * d.speed).toBeLessThan(row.reach * 1.2);
    }
  });

  it('real: the ratios between guns are the research ratios (1 : 1.54 : 2.11 : 2.33 : 2.83 : 3.37)', () => {
    const r = (id: keyof typeof TABLE): number => navalGunEngageReach(id, 'real') / navalGunEngageReach('naval_s', 'real');
    expect(r('naval_m')).toBeCloseTo(25.5 / 16.6, 2);
    expect(r('naval_l')).toBeCloseTo(35 / 16.6, 2);
    expect(r('naval_xl')).toBeCloseTo(38.7 / 16.6, 2);
    expect(r('naval_siege')).toBeCloseTo(47 / 16.6, 2);
    expect(r('naval_xxl')).toBeCloseTo(56 / 16.6, 2);
    // Every real reach is ~7.2× the legacy one (the proposal's "× today").
    for (const id of NAVAL) {
      const x = navalGunEngageReach(id, 'real') / navalGunEngageReach(id, 'legacy');
      expect(x).toBeGreaterThan(7.0);
      expect(x).toBeLessThan(7.5);
    }
  });

  it('real: Gustav keeps its 320 u blast; sub-capital weapons are untouched', async () => {
    const legacy = await loadAt('legacy');
    const legacySub = SUB_CAPITAL.map((id) => legacy.cat.getWeapon(id));
    const legacySplash = legacy.cat.getWeapon('naval_siege');
    vi.unstubAllEnvs();
    const real = await loadAt('real');
    expect(SUB_CAPITAL.map((id) => real.cat.getWeapon(id))).toEqual(legacySub);
    const siege = real.cat.getWeapon('naval_siege');
    if (siege.mode !== 'projectile' || legacySplash.mode !== 'projectile') throw new Error('siege');
    expect(siege.splash).toEqual({ radius: 320, falloffMin: 60 });
    expect(siege.splash).toEqual(legacySplash.splash);
  });

  it('real: a coastal gun\'s weaponRange follows its gun', async () => {
    const { cat, sk } = await loadAt('real');
    const pairs: ReadonlyArray<readonly [string, WeaponId]> = [
      ['dp_mount_5in', 'naval_s'], ['coastal_casemate_8in', 'naval_m'], ['coastal_turret_11in', 'naval_l'],
      ['coastal_barbette_16in', 'naval_xl'], ['coastal_lindemann', 'naval_xxl'], ['siege_gun_80cm', 'naval_siege'],
    ];
    for (const [kind, gun] of pairs) {
      const k = sk.STRUCTURE_KINDS_LIST.find((s) => s.id === kind);
      expect(k, kind).toBeDefined();
      expect(k!.weaponRange, kind).toBe(Math.round(cat.weaponAutoFireRange(cat.getWeapon(gun))));
    }
    expect(sk.STRUCTURE_KINDS_LIST.find((s) => s.id === 'coastal_barbette_16in')!.weaponRange).toBe(navalGunEngageReach('naval_xl', 'real'));
  });

  it('the table helper and the engage-reach helper agree', () => {
    for (const mode of ['legacy', 'real'] as const) {
      for (const id of NAVAL) {
        const b = navalGunBallisticsFor(mode)[id];
        expect(navalGunEngageReach(id, mode)).toBe(Math.round(projectileEngageReach(b.speed, b.maxTicks)));
      }
    }
  });
});

describe('naval range switch — server/client parity (#15)', () => {
  it('a legacy welcome is unchanged and reads as no mismatch on a legacy client', () => {
    const w = stampNavalRange({ type: 'welcome' as const, playerId: 'p' }, 'legacy');
    expect('navalRange' in w).toBe(false);
    expect(navalRangeMismatch(w, 'legacy')).toBeNull();
  });

  it('a real server stamps it; a real client agrees, a legacy client is told the fix', () => {
    const w = stampNavalRange({ type: 'welcome' as const, playerId: 'p' }, 'real');
    expect(w.navalRange).toBe('real');
    expect(navalRangeMismatch(w, 'real')).toBeNull();
    expect(navalRangeMismatch(w, 'legacy')).toEqual({ server: 'real', client: 'legacy', fix: '?navalRange=real' });
    expect(navalRangeMismatch({}, 'real')?.server).toBe('legacy');
  });

  it('the stamped welcome passes the client\'s welcome schema', () => {
    const base = { type: 'welcome' as const, playerId: 'p', serverTick: 1, sectorKey: null, shipInstanceId: '' };
    expect(WelcomeSchema.safeParse(stampNavalRange(base, 'real')).success).toBe(true);
    expect(WelcomeSchema.safeParse(stampNavalRange(base, 'legacy')).success).toBe(true);
  });

  it('the welcome this server builds matches this process (stampNavalRange default)', () => {
    const w = stampNavalRange({ type: 'welcome' as const, playerId: 'p' });
    expect(navalRangeMismatch(w)).toBeNull();
  });

  it('workers inherit the mode through shipScaleWorkerName', async () => {
    vi.stubEnv('EQX_NAVAL_RANGE', 'real');
    vi.resetModules();
    const cfg = await import('../../src/shared-types/shipScale/config.js');
    const nr = await import('../../src/shared-types/combat/navalRange.js');
    expect(nr.resolveNavalRange({ workerName: cfg.shipScaleWorkerName('renderer') })).toBe('real');
  });
});
