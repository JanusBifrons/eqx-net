import { describe, it, expect } from 'vitest';
import { familyFor, flashFrameAt, heatAfter, muzzleFlashFlipbook, nearestMuzzle, recoilAt, NAVAL_FLASH_LIFE_S, shellImpactRadius, muzzleSmokePuff, MUZZLE_SMOKE_LIFE_S, shellEndedOnHit, muzzleLightAt, MUZZLE_LIGHT_TAIL_S, navalMuzzleLight } from './turretFx.js';

describe('turret bakes', () => {
  it('the flash shrinks frame by frame', () => {
    const fb = muzzleFlashFlipbook(4, 64);
    const sum = (f: number): number => { let s = 0; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) s += fb.sheet.data[(y * fb.sheet.w + f * 64 + x) * 4 + 3]!; return s; };
    expect(sum(0)).toBeGreaterThan(sum(3) * 1.5);
  });
});

describe('firing reactions', () => {
  it('recoil kicks to 1 fast, then settles home', () => {
    expect(recoilAt(-0.1)).toBe(0);
    expect(recoilAt(0.025)).toBeCloseTo(1, 5);
    expect(Math.abs(recoilAt(0.4))).toBeLessThan(0.02);
  });

  it('the flash lasts 70 ms over its frames', () => {
    expect(flashFrameAt(0, 4)).toBe(0);
    expect(flashFrameAt(0.069, 4)).toBe(3);
    expect(flashFrameAt(0.07, 4)).toBe(-1);
  });

  it('heat builds with sustained fire and cools', () => {
    let h = 0;
    for (let i = 0; i < 5; i++) h = heatAfter(h, 0.1, 1);
    expect(h).toBeGreaterThan(0.8);
    h = heatAfter(h, 2, 0);
    expect(h).toBeLessThan(0.02);
  });

  it('matches a new bolt to the nearest barrel within range', () => {
    const xs = [0, 10, 20], ys = [0, 0, 0];
    expect(nearestMuzzle(9, 1, xs, ys, 3, 5)).toBe(1);
    expect(nearestMuzzle(9, 30, xs, ys, 3, 5)).toBe(-1);
  });

  it('maps weapons to families', () => {
    expect(familyFor('laser', 'projectile', false)).toBe('bolt');
    expect(familyFor('hitscan', 'hitscan', false)).toBe('beam');
    expect(familyFor('charge-laser', 'hitscan', true)).toBe('charge');
    expect(familyFor('heat-seeker', 'missile', false)).toBe('missile');
  });
});

describe('capital naval gun effects (review round 2026-11-07)', () => {
  it('a naval flash lasts several times a fighter gun flash', () => {
    expect(flashFrameAt(0.15, 4)).toBe(-1); // fighter flash gone
    expect(flashFrameAt(0.15, 4, NAVAL_FLASH_LIFE_S)).toBeGreaterThanOrEqual(0); // naval still burning
    expect(flashFrameAt(NAVAL_FLASH_LIFE_S, 4, NAVAL_FLASH_LIFE_S)).toBe(-1);
  });

  it('the impact burst grows with the shell (invariant #18)', () => {
    expect(shellImpactRadius(6)).toBeGreaterThan(shellImpactRadius(3));
  });
});

describe('naval muzzle smoke is a directed cone (review 2026-11-07)', () => {
  const out = { d: 0, size: 0, alpha: 0, lat: 0, rot: 0 };
  it('blows forward along the barrel and fades out', () => {
    const near = muzzleSmokePuff(0.1, 0, 40, { ...out }).d;
    const later = muzzleSmokePuff(0.8, 0, 40, { ...out }).d;
    expect(later).toBeGreaterThan(near);
    expect(muzzleSmokePuff(0.8, 2, 40, { ...out }).d).toBeGreaterThan(muzzleSmokePuff(0.8, 0, 40, { ...out }).d);
    expect(muzzleSmokePuff(MUZZLE_SMOKE_LIFE_S, 0, 40, { ...out }).alpha).toBe(0);
    expect(muzzleSmokePuff(0.1, 0, 40, { ...out }).alpha).toBeGreaterThan(muzzleSmokePuff(1.2, 0, 40, { ...out }).alpha);
  });
  it('scales with the barrel (invariant #18)', () => {
    expect(muzzleSmokePuff(0.5, 1, 40, { ...out }).size).toBeCloseTo(muzzleSmokePuff(0.5, 1, 10, { ...out }).size * 4, 6);
  });
});

describe('naval shell impacts (review 2026-11-07)', () => {
  it('a shell that stopped short burst on a hit; one that ran its range just fades', () => {
    expect(shellEndedOnHit(2000, 4200)).toBe(true);
    expect(shellEndedOnHit(4000, 4200)).toBe(false);
  });
});
describe('muzzle-flash light (gpu-lit review 2026-11-09)', () => {
  it('holds while the flash sprite shows, then eases out over a short tail', () => {
    expect(muzzleLightAt(-1, 0.07)).toBe(0);
    expect(muzzleLightAt(0, 0.07)).toBe(1);
    expect(muzzleLightAt(0.069, 0.07)).toBe(1);
    // Still lit after the sprite ends: the light outlives the 1–2 frame flash.
    expect(muzzleLightAt(0.07 + 1 / 60, 0.07)).toBeGreaterThan(0.5);
    expect(muzzleLightAt(0.07 + MUZZLE_LIGHT_TAIL_S * 0.5, 0.07)).toBeGreaterThan(0.1);
    expect(muzzleLightAt(0.07 + MUZZLE_LIGHT_TAIL_S, 0.07)).toBe(0);
    expect(MUZZLE_LIGHT_TAIL_S).toBeGreaterThanOrEqual(0.08);
    expect(MUZZLE_LIGHT_TAIL_S).toBeLessThanOrEqual(0.12);
  });

  it('the tail is an ease-out: it falls fastest first and never rises', () => {
    let prev = 1;
    for (let i = 1; i <= 20; i++) {
      const v = muzzleLightAt(0.22 + (i / 20) * MUZZLE_LIGHT_TAIL_S, NAVAL_FLASH_LIFE_S);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
    const a = 1 - muzzleLightAt(0.22 + MUZZLE_LIGHT_TAIL_S * 0.25, 0.22);
    const b = muzzleLightAt(0.22 + MUZZLE_LIGHT_TAIL_S * 0.5, 0.22) - muzzleLightAt(0.22 + MUZZLE_LIGHT_TAIL_S * 0.75, 0.22);
    expect(a).toBeGreaterThan(b);
  });

  it('a naval flash lights in proportion to its gun: 16" > 5" > nothing', () => {
    const out = { intensity: 0, reach: 0, z: 0 };
    const big = { ...navalMuzzleLight(34.7, out) }; // battleship 16"
    const five = { ...navalMuzzleLight(15.3, out) }; // battleship 5"
    const dd = { ...navalMuzzleLight(11.2, out) }; // destroyer 5"
    // The 5" was clamped to the same light as the 16" (width / 2 capped at 6).
    expect(big.reach).toBeGreaterThan(five.reach * 1.5);
    expect(big.intensity).toBeGreaterThan(five.intensity);
    expect(five.reach).toBeGreaterThan(dd.reach);
    // ...but the 5" still reads on the deck around it.
    expect(five.intensity).toBeGreaterThan(3);
    expect(five.reach).toBeGreaterThan(200);
    expect(five.z).toBeGreaterThan(0);
  });

  it('writes into the scratch it is given (alloc-free, #14)', () => {
    const out = { intensity: 0, reach: 0, z: 0 };
    expect(navalMuzzleLight(20, out)).toBe(out);
  });
});
