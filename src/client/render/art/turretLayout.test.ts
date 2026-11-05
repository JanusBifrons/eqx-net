/**
 * Turret layout + forge (rnd/turrets): the ring in the hull and the gun on
 * top come from one layout, so they line up; a fixed chin gun's tip is the
 * game's existing muzzle point.
 */
import { describe, it, expect } from 'vitest';
import { MUZZLE_CLEARANCE } from '../../../core/combat/Weapons.js';
import { forgeShip, forgeTurretGun, MAT } from './fields.js';
import { muzzleReach, shipTurrets, structureTurrets } from './turretLayout.js';

describe('turret layout', () => {
  it('a fixed centre gun is a chin gun whose tip is today\'s muzzle point', () => {
    const [t] = shipTurrets('fighter');
    expect(t!.chin).toBe(true);
    expect(-t!.py + muzzleReach(t!)).toBeCloseTo(MUZZLE_CLEARANCE, 6);
  });

  it('turning mounts pivot on the mount and are sized to the hull', () => {
    const ts = shipTurrets('gunship');
    expect(ts).toHaveLength(2);
    expect(ts[0]!.py).toBe(-12); // forward mount at game y +12 (the nose) → Pixi -12
    expect(ts[0]!.len).toBeLessThan(MUZZLE_CLEARANCE);
  });

  it('structure turrets scale with the footprint', () => {
    const [small] = structureTurrets('turret');
    const [big] = structureTurrets('missile_turret');
    expect(small!.len).toBeGreaterThan(MUZZLE_CLEARANCE * 2);
    expect(big!.family).toBe('missile');
    expect(big!.cap).toBeGreaterThan(small!.cap);
  });
});

describe('turret forge', () => {
  it('cuts a recessed ring into the hull at each mount', () => {
    const plain = forgeShip('gunship', { ppu: 4 });
    const rings = shipTurrets('gunship').map((t) => ({ x: t.px, y: t.py, r: t.ring }));
    const ringed = forgeShip('gunship', { ppu: 4, rings });
    const g = ringed.g, t = shipTurrets('gunship')[1]!; // the rear mount sits inside the hull
    const i = Math.round(t.py * g.ppu + g.oy) * g.w + Math.round(t.px * g.ppu + g.ox);
    expect(ringed.mat[i]).toBe(MAT.TRIM);
    expect(ringed.height[i]!).toBeLessThan(plain.height[i]!);
  });

  it('a gun has a painted cap and a metal barrel reaching forward to its length', () => {
    const f = forgeTurretGun({ family: 'bolt', paint: 0xff8800, len: 10, wid: 2.4, cap: 3.6, ppu: 6 });
    const at = (x: number, y: number): number => Math.round(y * f.g.ppu + f.g.oy) * f.g.w + Math.round(x * f.g.ppu + f.g.ox);
    expect(f.mat[at(3.0, 1.0)]).toBe(MAT.PAINT); // on the cap, off the barrel and its groove
    expect(f.mat[at(0, -6)]).toBe(MAT.METAL); // along the barrel
    expect(f.cov[at(0, -9.7)]!).toBeGreaterThan(0.5); // reaches the tip
    expect(f.cov[at(0, -11.5)]!).toBe(0); // and no further
  });
});
