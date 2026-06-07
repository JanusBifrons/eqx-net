import { describe, it, expect } from 'vitest';
import {
  getWeapon,
  isWeaponId,
  weaponAutoFireRange,
  WEAPONS,
  WEAPON_IDS,
  DEFAULT_WEAPON,
} from './WeaponCatalogue.js';

describe('WeaponCatalogue', () => {
  it('getWeapon returns the hitscan (beam) definition', () => {
    const w = getWeapon('hitscan');
    expect(w.id).toBe('hitscan');
    expect(w.mode).toBe('hitscan');
    // Weapons/energy/AI overhaul (2026-06-01): the beam became the
    // interceptor's very-close-range duellist — damage 20 → 13,
    // range 500 → 250. Cadence stays 6 Hz (cooldownTicks 10).
    expect(w.damage).toBe(13);
    expect(w.cooldownTicks).toBe(10);
    if (w.mode === 'hitscan') {
      expect(w.range).toBe(250);
    }
    // Per-slot-trigger energy cost (costliest weapon — high DPS twin beams).
    expect(w.energyCost).toBe(5);
  });

  it('getWeapon returns the laser (bolt) definition', () => {
    const w = getWeapon('laser');
    expect(w.id).toBe('laser');
    expect(w.mode).toBe('projectile');
    // Weapons/energy/AI overhaul (2026-06-01): bolts are the workhorse —
    // damage 10 → 12, medium range (maxTicks 90 → 42 ⇒ ~1120 u).
    expect(w.damage).toBe(12);
    if (w.mode === 'projectile') {
      expect(w.speed).toBe(1600);
      expect(w.radius).toBe(3);
      expect(w.maxTicks).toBe(42);
    }
    expect(w.energyCost).toBe(2);
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

  it('every weapon has positive damage, cooldown, and energy cost', () => {
    for (const w of WEAPONS.values()) {
      expect(w.damage).toBeGreaterThan(0);
      expect(w.cooldownTicks).toBeGreaterThan(0);
      expect(w.energyCost).toBeGreaterThan(0);
    }
  });

  it('getWeapon returns the heat-seeker (missile) definition', () => {
    const w = getWeapon('heat-seeker');
    expect(w.id).toBe('heat-seeker');
    expect(w.mode).toBe('missile');
    // Weapons/energy/AI overhaul (2026-06-01): missiles kill ≤300-HP ships
    // in a 2-missile salvo (damage 30 → 150); cadence 180 → 90 ticks so the
    // pool/regen can sustain ~8 in flight; per-salvo energy cost 60.
    expect(w.damage).toBe(150);
    expect(w.cooldownTicks).toBe(90);
    expect(w.energyCost).toBe(60);
    if (w.mode === 'missile') {
      // Slow + dodgeable speed (one of the load-bearing tuning numbers).
      expect(w.speed).toBe(400);
      // Looser homing (smoke handoff 2026-06-06, Issue 2: "review turn
      // speed" → easier to dodge). turnRate 1.5 → 1.0; turn radius =
      // speed/turnRate = 400 u (was ~267 u).
      expect(w.turnRate).toBe(1.0);
      // Long enough that dumb-mode missiles waste shots — not a near-miss
      // toy weapon. (On expiry the missile now fizzles, not detonates.)
      expect(w.lifetimeTicks).toBe(360);
      // Splash falloff geometry — splashFalloffMin must be > 0 to keep
      // the inverse-square clamp safe.
      expect(w.splashFalloffMin).toBeGreaterThan(0);
      expect(w.splashRadius).toBeGreaterThan(w.splashFalloffMin);
      // Owner exclusion ON by default (prevents self-splash on
      // point-blank detonations near launch).
      expect(w.splashExcludeOwner).toBe(true);
      // Impact-only (smoke handoff 2026-06-06, Issue 2): proximity fuse
      // DISABLED — only a direct sweep hit detonates. A near-miss flies
      // past without exploding.
      expect(w.proximityFuseRadius).toBe(0);
    }
  });

  it('isWeaponId accepts heat-seeker', () => {
    expect(isWeaponId('heat-seeker')).toBe(true);
  });
});

describe('weaponAutoFireRange', () => {
  it('hitscan uses the beam range exactly', () => {
    const w = getWeapon('hitscan');
    if (w.mode !== 'hitscan') throw new Error('expected hitscan');
    expect(weaponAutoFireRange(w)).toBe(w.range);
  });

  it('projectile is 0.85x the bolt max travel (speed*maxTicks/60)', () => {
    const w = getWeapon('laser');
    if (w.mode !== 'projectile') throw new Error('expected projectile');
    const maxTravel = (w.speed * w.maxTicks) / 60;
    expect(weaponAutoFireRange(w)).toBeCloseTo(maxTravel * 0.85, 6);
    // Must stay strictly inside the bolt's reach so it can land before expiry.
    expect(weaponAutoFireRange(w)).toBeLessThan(maxTravel);
  });

  it('missile is capped to half the theoretical homing reach', () => {
    const w = getWeapon('heat-seeker');
    if (w.mode !== 'missile') throw new Error('expected missile');
    const maxReach = (w.speed * w.lifetimeTicks) / 60;
    expect(weaponAutoFireRange(w)).toBeCloseTo(maxReach * 0.5, 6);
  });

  it('orders beam < bolt < missile auto-fire range (close → medium → long)', () => {
    const beam = weaponAutoFireRange(getWeapon('hitscan'));
    const bolt = weaponAutoFireRange(getWeapon('laser'));
    const missile = weaponAutoFireRange(getWeapon('heat-seeker'));
    expect(beam).toBeLessThan(bolt);
    expect(bolt).toBeLessThan(missile);
  });

  it('returns a positive finite range for every weapon', () => {
    for (const w of WEAPONS.values()) {
      const r = weaponAutoFireRange(w);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
    }
  });
});

/**
 * Time-to-kill targets (weapons/energy/AI overhaul §2). These lock the
 * *gameplay intent* (TTK math) rather than the raw damage literals, so a
 * future balance pass can move `damage`/`cooldownTicks` together as long as
 * the resulting kill time stays in band. Effective HP = shield + hull with
 * NO spillover (the last hit before a shield drops is fully absorbed), so a
 * pessimistic kill needs `ceil(shield/dmg) + ceil(hull/dmg)` hits when the
 * shield soaks the overkill on its final hit.
 */
describe('WeaponCatalogue — TTK targets (lock the math, not the literals)', () => {
  const FIGHTER_SHIELD = 150;
  const FIGHTER_HULL = 150;

  /** Pessimistic shots-to-kill given no-spillover shields. */
  const shotsToKill = (dmg: number, shield: number, hull: number): number =>
    Math.ceil(shield / dmg) + Math.ceil(hull / dmg);

  it('a single beam kills a 300-HP fighter in ~3-5 s at 6 Hz', () => {
    const w = getWeapon('hitscan');
    const shots = shotsToKill(w.damage, FIGHTER_SHIELD, FIGHTER_HULL);
    const seconds = (shots * w.cooldownTicks) / 60;
    expect(seconds).toBeGreaterThanOrEqual(3);
    expect(seconds).toBeLessThanOrEqual(5.5);
  });

  it('bolts kill a 300-HP fighter in ~3-5 s at 6 Hz', () => {
    const w = getWeapon('laser');
    const shots = shotsToKill(w.damage, FIGHTER_SHIELD, FIGHTER_HULL);
    const seconds = (shots * w.cooldownTicks) / 60;
    expect(seconds).toBeGreaterThanOrEqual(3);
    expect(seconds).toBeLessThanOrEqual(5.5);
  });

  it('a 2-missile salvo kills the common ≤300-HP ships', () => {
    const w = getWeapon('heat-seeker');
    // One missile is fully absorbed by a ≤150 shield (no spillover → shield
    // to 0); the second lands on hull. So a 2-missile salvo must one-shot a
    // ≤150 hull once the shield is down.
    expect(w.damage).toBeGreaterThanOrEqual(FIGHTER_HULL);
    expect(w.damage).toBeGreaterThanOrEqual(FIGHTER_SHIELD);
  });

  it('missile cadence can sustain ~8 in flight (≈4 salvos over the 6 s TTL)', () => {
    const w = getWeapon('heat-seeker');
    if (w.mode !== 'missile') throw new Error('expected missile');
    const ttlSeconds = w.lifetimeTicks / 60;
    const salvoIntervalSeconds = w.cooldownTicks / 60;
    const salvosInFlight = ttlSeconds / salvoIntervalSeconds;
    const missilesInFlight = salvosInFlight * 2; // 2 mounts per salvo
    expect(missilesInFlight).toBeGreaterThanOrEqual(6);
    expect(missilesInFlight).toBeLessThanOrEqual(10);
  });
});
