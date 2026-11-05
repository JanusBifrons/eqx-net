import { describe, it, expect } from 'vitest';
import { familyFor, flashFrameAt, heatAfter, muzzleFlashFlipbook, nearestMuzzle, recoilAt, turretBarrelTex, turretBaseTex } from './turretFx.js';

const alpha = (i: { w: number; data: Uint8ClampedArray }, x: number, y: number): number => i.data[(y * i.w + x) * 4 + 3]!;

describe('turret bakes', () => {
  it('housings are round discs (racks are boxes), transparent at the corners', () => {
    for (const f of ['bolt', 'beam', 'charge'] as const) {
      const t = turretBaseTex(f, 64);
      expect(alpha(t, 32, 32)).toBe(255);
      expect(alpha(t, 2, 2)).toBe(0);
    }
    const rack = turretBaseTex('missile', 64);
    expect(alpha(rack, 32, 32)).toBe(255);
    expect(alpha(rack, 6, 32)).toBeGreaterThan(0); // reaches the side like a box
  });

  it('a bolt barrel has a muzzle brake wider than its body', () => {
    const b = turretBarrelTex('bolt', 16, 64);
    const width = (row: number): number => { let n = 0; for (let x = 0; x < 16; x++) if (alpha(b, x, row) > 128) n++; return n; };
    expect(width(3)).toBeGreaterThan(width(30));
  });

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
