import { describe, it, expect } from 'vitest';
import { getWeapon, isWeaponId, WEAPONS, WEAPON_IDS, DEFAULT_WEAPON } from './WeaponCatalogue.js';

describe('WeaponCatalogue', () => {
  it('getWeapon returns the hitscan definition', () => {
    const w = getWeapon('hitscan');
    expect(w.id).toBe('hitscan');
    expect(w.mode).toBe('hitscan');
    // Smooth-beam retune (2026-05-22): 4 HP × 33 ms = 120 DPS preserved
    // from the prior 20 HP × 167 ms. The cadence is the load-bearing
    // feel knob; the damage scales inversely to keep balance fixed.
    expect(w.damage).toBe(4);
    expect(w.cooldownTicks).toBe(2);
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
});
