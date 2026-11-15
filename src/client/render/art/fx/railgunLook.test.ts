/**
 * The railgun's look (weapon-mounts.md "Railgun look"): its turret family,
 * the split-rail geometry against the shared muzzle (#15), the charge
 * filling the slot breech → muzzle, the vent gas and hot rails after a shot,
 * and the slug's lingering wake — with the per-tier counts that keep them in
 * the effects budget.
 */
import { describe, expect, it } from 'vitest';
import {
  railGeom, railHeatAt, railSlotCharge, railVentPuff, railVentPuffs, RAIL_VENTS, RAIL_VENT_LIFE_S,
  slugWakeAlpha, slugWakeSegments, slugWakeWidth, SLUG_WAKE_LIFE_S,
} from './turretFx.js';
import { shipTurrets } from '../turretLayout.js';
import { getShipKind } from '../../../../shared-types/shipKinds.js';
import { shipMountMuzzle } from '../../../../core/combat/muzzle.js';

describe('railgun turret family', () => {
  it("a battleship-rail's railgun mounts draw as the 'rail' family; a naval battleship's mains are unchanged", () => {
    const rail = shipTurrets('battleship-rail');
    const rails = rail.filter((t) => t.mount.weaponId === 'railgun');
    expect(rails.length).toBeGreaterThan(0);
    for (const t of rails) {
      expect(t.family).toBe('rail');
      expect(t.naval?.barrels, 'one barrel').toBe(1);
    }
    for (const t of rail) if (t.mount.weaponId !== 'railgun') expect(t.family).not.toBe('rail');
    for (const t of shipTurrets('battleship')) {
      expect(t.family).not.toBe('rail');
      if (t.mount.id.startsWith('main-')) expect(t.family).toBe('bolt');
    }
  });

  it('the rails end at the shared muzzle, and show longer than a naval barrel', () => {
    const k = getShipKind('battleship-rail');
    const t = shipTurrets('battleship-rail').find((p) => p.family === 'rail')!;
    const g = railGeom(t.naval!.houseW, t.naval!.houseL, t.len, t.wid);
    expect(-g.muzzleY).toBeCloseTo(shipMountMuzzle(k, t.mount)!, 5);
    // A naval barrel shows from the gunhouse face (houseL / 2); the rails
    // from inside the breech disc.
    expect(g.railY0 - g.muzzleY).toBeGreaterThan(t.len);
    expect(g.slotW).toBeGreaterThan(0);
    expect(g.railOuter).toBeCloseTo(g.slotW / 2 + g.railW, 9);
  });
});

describe('railgun charge (rail-slot telegraph)', () => {
  it('the slot fills from the breech to the muzzle and brightens as it nears full', () => {
    const out = { fill: 0, bright: 0 };
    let lastFill = -1, lastBright = -1;
    for (const l of [0, 0.25, 0.5, 0.75, 1]) {
      railSlotCharge(l, out);
      expect(out.fill).toBeCloseTo(l, 9);
      expect(out.fill).toBeGreaterThan(lastFill);
      expect(out.bright).toBeGreaterThan(lastBright);
      lastFill = out.fill; lastBright = out.bright;
    }
    expect(railSlotCharge(1, out).bright).toBe(1);
    expect(railSlotCharge(2, out).fill).toBe(1);
    expect(railSlotCharge(-1, out).fill).toBe(0);
  });
});

describe('railgun vent and hot rails', () => {
  const g = railGeom(320, 360, 430, 35);

  it('the rails are hottest at the shot and cool over ~2 s', () => {
    expect(railHeatAt(-0.1)).toBe(0);
    expect(railHeatAt(0)).toBe(1);
    expect(railHeatAt(1)).toBeLessThan(railHeatAt(0.5));
    expect(railHeatAt(RAIL_VENT_LIFE_S)).toBe(0);
  });

  it('vent gas leaves sideways from the vents along each rail, then fades', () => {
    const p = { x: 0, y: 0, size: 0, alpha: 0, hot: 0 };
    railVentPuff(0.4, 0, g, p);
    expect(p.alpha).toBeGreaterThan(0);
    expect(p.x).toBeGreaterThan(g.railOuter); // out of the right rail
    expect(p.y).toBeLessThan(g.railY0); // along the rails, ahead of the breech
    expect(p.y).toBeGreaterThan(g.muzzleY);
    railVentPuff(0.4, 1, g, p);
    expect(p.x).toBeLessThan(-g.railOuter); // and out of the left
    const early = railVentPuff(0.05, 0, g, p).hot;
    expect(early).toBeGreaterThan(0); // spark-hot as it leaves
    expect(railVentPuff(RAIL_VENT_LIFE_S, 0, g, p).alpha).toBe(0);
  });

  it('vent puffs per effects tier: both sides at high, half at medium, none on low tiers', () => {
    expect(railVentPuffs('high')).toBe(RAIL_VENTS.length * 2);
    expect(railVentPuffs('medium')).toBe(RAIL_VENTS.length);
    expect(railVentPuffs('low')).toBe(0);
    expect(railVentPuffs('minimal')).toBe(0);
  });
});

describe('railgun slug wake', () => {
  it('wake pieces per effects tier', () => {
    expect(slugWakeSegments('high')).toBe(10);
    expect(slugWakeSegments('medium')).toBe(6);
    expect(slugWakeSegments('low')).toBe(3);
    expect(slugWakeSegments('minimal')).toBe(0);
  });

  it('a wake piece fades and spreads over its life (1-2 s)', () => {
    expect(SLUG_WAKE_LIFE_S).toBeGreaterThanOrEqual(1);
    expect(SLUG_WAKE_LIFE_S).toBeLessThanOrEqual(2);
    expect(slugWakeAlpha(0)).toBeGreaterThan(slugWakeAlpha(0.8));
    expect(slugWakeAlpha(SLUG_WAKE_LIFE_S)).toBe(0);
    expect(slugWakeWidth(SLUG_WAKE_LIFE_S * 0.9)).toBeGreaterThan(slugWakeWidth(0));
  });
});
