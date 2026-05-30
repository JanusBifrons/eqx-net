import { describe, it, expect } from 'vitest';
import { getWeapon, isWeaponId, WEAPONS, WEAPON_IDS, DEFAULT_WEAPON } from './WeaponCatalogue.js';

describe('WeaponCatalogue', () => {
  it('getWeapon returns the hitscan definition', () => {
    const w = getWeapon('hitscan');
    expect(w.id).toBe('hitscan');
    expect(w.mode).toBe('hitscan');
    // Smooth-beam revert (2026-05-22): server-side cadence stays at the
    // original 6 Hz (cooldownTicks=10, damage=20). Smooth feel is
    // produced CLIENT-side via visual splitting — see `ColyseusClient`
    // predicted-spawn scheduler + `LESSONS.md` 2026-05-22 smooth-beam.
    expect(w.damage).toBe(20);
    expect(w.cooldownTicks).toBe(10);
  });

  it('getWeapon returns the laser definition', () => {
    const w = getWeapon('laser');
    expect(w.id).toBe('laser');
    expect(w.mode).toBe('projectile');
    expect(w.damage).toBe(10);
    if (w.mode === 'projectile') {
      expect(w.speed).toBe(1600);
      expect(w.radius).toBe(3);
      expect(w.maxTicks).toBe(90);
    }
  });

  it('WEAPON_IDS matches WEAPONS keys', () => {
    expect(WEAPON_IDS).toEqual([...WEAPONS.keys()]);
  });

  it('DEFAULT_WEAPON is a valid weapon id', () => {
    expect(isWeaponId(DEFAULT_WEAPON)).toBe(true);
    expect(WEAPONS.has(DEFAULT_WEAPON)).toBe(true);
  });

  it('isWeaponId rejects invalid values', () => {
    expect(isWeaponId('banana')).toBe(false);
    expect(isWeaponId(42)).toBe(false);
    expect(isWeaponId(null)).toBe(false);
  });

  it('every weapon has positive damage and cooldown', () => {
    for (const w of WEAPONS.values()) {
      expect(w.damage).toBeGreaterThan(0);
      expect(w.cooldownTicks).toBeGreaterThan(0);
    }
  });

  it('getWeapon returns the heat-seeker definition', () => {
    const w = getWeapon('heat-seeker');
    expect(w.id).toBe('heat-seeker');
    expect(w.mode).toBe('missile');
    if (w.mode === 'missile') {
      // Slow + dodgeable speed (one of the load-bearing tuning numbers).
      expect(w.speed).toBe(400);
      expect(w.turnRate).toBe(1.5);
      // Long enough that dumb-mode missiles waste shots — not a near-miss
      // toy weapon.
      expect(w.lifetimeTicks).toBe(360);
      // Splash falloff geometry — splashFalloffMin must be > 0 to keep
      // the inverse-square clamp safe.
      expect(w.splashFalloffMin).toBeGreaterThan(0);
      expect(w.splashRadius).toBeGreaterThan(w.splashFalloffMin);
      // Owner exclusion ON by default (prevents self-splash on
      // point-blank detonations near launch).
      expect(w.splashExcludeOwner).toBe(true);
      // Proximity-fuse smaller than splash radius (near-misses feel
      // meaningful but the explosion still hits the target).
      expect(w.proximityFuseRadius).toBeGreaterThan(0);
      expect(w.proximityFuseRadius).toBeLessThan(w.splashRadius);
    }
  });

  it('isWeaponId accepts heat-seeker', () => {
    expect(isWeaponId('heat-seeker')).toBe(true);
  });
});
