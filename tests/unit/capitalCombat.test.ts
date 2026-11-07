/**
 * Capital combat (plan prancy-squishing-donut Phase 3): the naval gun table,
 * how capital mounts bind to it, the shared turret reach (#15) and broadside
 * steering. The end-to-end lock is
 * tests/integration/sectorRoom/capitalEngagement.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { getWeapon, weaponAutoFireRange, WEAPON_IDS, isWeaponId } from '../../src/core/combat/WeaponCatalogue';
import { mountTargetReach, mountWeaponReach, hasTurretFireControl } from '../../src/core/combat/mountReach';
import { HITSCAN_RANGE } from '../../src/core/combat/Weapons';
import { navalTurret, navalBarrelOffset, NAVAL_BARREL_SPAN } from '../../src/core/combat/muzzle';
import { HostileDroneBehaviour, BROADSIDE_STANDOFF } from '../../src/core/ai/HostileDroneBehaviour';
import { getShipKind } from '../../src/shared-types/shipKinds';
import type { AiWorldView } from '../../src/core/contracts/IAiBehaviour';

const CAPITALS = ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship'];
const SIZES = ['naval_s', 'naval_m', 'naval_l', 'naval_xl'] as const;
const reach = (id: (typeof SIZES)[number]): number => weaponAutoFireRange(getWeapon(id));

describe('naval guns follow the WW2 calibre ratios', () => {
  it('are registered weapon ids', () => {
    for (const id of SIZES) {
      expect(WEAPON_IDS).toContain(id);
      expect(isWeaponId(id)).toBe(true);
    }
  });

  it('reach keeps the real range ratio 1 : 1.54 : 2.12 : 2.34', () => {
    const want = [1, 1.54, 2.12, 2.34];
    SIZES.forEach((id, i) => expect(reach(id) / reach('naval_s')).toBeCloseTo(want[i]!, 1));
  });

  it('bigger guns hit harder, reload slower and fly ~2 s or less to full reach', () => {
    for (let i = 1; i < SIZES.length; i++) {
      const a = getWeapon(SIZES[i - 1]!), b = getWeapon(SIZES[i]!);
      expect(b.damage).toBeGreaterThan(a.damage);
      expect(b.cooldownTicks).toBeGreaterThan(a.cooldownTicks);
    }
    for (const id of SIZES) {
      const w = getWeapon(id);
      if (w.mode !== 'projectile') throw new Error('naval guns are projectiles');
      expect(w.maxTicks / 60).toBeLessThanOrEqual(2.2 * 1.5); // ×1.5 combat scale at 2× B
    }
  });
});

describe('capital mounts', () => {
  for (const id of CAPITALS) {
    it(`${id}: every mount fires the naval gun of its size`, () => {
      const kind = getShipKind(id);
      expect(kind.mounts.length).toBeGreaterThan(0);
      for (const m of kind.mounts) {
        const size = (m as { size?: string }).size;
        expect(m.weaponId).toBe(`naval_${size!.toLowerCase()}`);
      }
    });

    it(`${id}: turret reach covers its longest gun from the centre`, () => {
      const kind = getShipKind(id);
      expect(hasTurretFireControl(kind)).toBe(true);
      const r = mountTargetReach(kind, kind.mounts);
      for (const m of kind.mounts) expect(r).toBeGreaterThanOrEqual(mountWeaponReach(m));
      // Out past its own hull: the old 250 u never left it.
      expect(r).toBeGreaterThan(kind.radius);
    });
  }

  for (const id of CAPITALS) {
    it(`${id}: main turrets train ±135° at near-real rates, and gunhouses never touch`, () => {
      const kind = getShipKind(id);
      const mains = kind.mounts.filter((m) => m.id.startsWith('main-'));
      const realMax: Record<string, number> = { S: 0.27, M: 0.15, L: 0.09, XL: 0.075 }; // ~15/8/5/4 °/s
      for (const m of kind.mounts) expect(m.rotationSpeed).toBeLessThanOrEqual(realMax[m.size!]!);
      for (const m of mains) {
        expect(m.arcMax).toBeCloseTo((3 * Math.PI) / 4, 5);
        expect(m.arcMin).toBeCloseTo(-(3 * Math.PI) / 4, 5);
      }
      // Two gunhouses can't overlap at any angle when their pivots are at
      // least two half-diagonals apart.
      for (let i = 0; i < mains.length; i++) {
        for (let j = i + 1; j < mains.length; j++) {
          const a = navalTurret(kind, mains[i])!, b = navalTurret(kind, mains[j])!;
          const need = Math.hypot(a.houseW / 2, a.houseL / 2) + Math.hypot(b.houseW / 2, b.houseL / 2);
          const d = Math.abs(mains[i]!.localY - mains[j]!.localY) * (kind.appliedScale ?? 1);
          expect(d).toBeGreaterThanOrEqual(need * 0.999);
        }
      }
    });
  }

  it('barrel offsets span the drawn gunhouse symmetrically', () => {
    const kind = getShipKind('battleship');
    const t = navalTurret(kind, kind.mounts.find((m) => m.id === 'main-1'))!;
    expect(t.barrels).toBe(3);
    expect(navalBarrelOffset(t, 1)).toBeCloseTo(0, 6);
    expect(navalBarrelOffset(t, 0)).toBeCloseTo(-navalBarrelOffset(t, 2), 6);
    expect(navalBarrelOffset(t, 2) - navalBarrelOffset(t, 0)).toBeCloseTo(t.houseW * NAVAL_BARREL_SPAN, 6);
  });

  it('every non-capital keeps the fixed HITSCAN_RANGE (byte-identical aim)', () => {
    for (const id of ['scout', 'fighter', 'heavy', 'interceptor', 'gunship', 'missile-frigate']) {
      const kind = getShipKind(id);
      expect(hasTurretFireControl(kind)).toBe(false);
      expect(mountTargetReach(kind, kind.mounts)).toBe(HITSCAN_RANGE);
    }
  });
});

describe('broadside steering', () => {
  const view = (x: number, y: number): AiWorldView => ({
    players: [{ id: 'p', x, y, vx: 0, vy: 0 }],
    tick: 200,
    dtSec: 1 / 60,
  });
  const self = { id: 'bs', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const mainReach = (): number => Math.max(...getShipKind('battleship').mounts.map((m) => mountWeaponReach(m)));

  it('in reach: holds the beam toward the target and never fires with the hull', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    // Target off the starboard beam (+x) at the stand-off: heading 0 is already
    // beam-on, so the hull holds its heading.
    const d = mainReach() * BROADSIDE_STANDOFF;
    const intent = b.tick(self, view(d, 0));
    expect(intent.fire).toBeUndefined();
    expect(Math.abs(intent.setAngvel ?? 0)).toBeLessThan(0.1 * getShipKind('battleship').maxAngvel);
    // Holds station at the stand-off (no thrust): it must not steam out of reach.
    expect(Math.hypot(intent.fx, intent.fy)).toBeLessThan(0.05 * getShipKind('battleship').ai.thrust);
  });

  it('in reach, bow-on: turns the beam toward the target', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    const intent = b.tick(self, view(0, mainReach() * BROADSIDE_STANDOFF));
    expect(intent.fire).toBeUndefined();
    expect(Math.abs(intent.setAngvel ?? 0)).toBeGreaterThan(0.5 * getShipKind('battleship').maxAngvel);
  });

  it('out of reach, target abeam: turns toward it WITHOUT steaming away', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    // Far off the starboard beam: must turn toward +x (negative angle in the
    // ship convention: forward = (-sin a, cos a)) and not thrust while facing
    // away (the film found a battleship steaming off out of its own reach).
    const intent = b.tick(self, view(mainReach() * 2, 0));
    expect(intent.setAngvel ?? 0).toBeLessThan(0);
    expect(Math.hypot(intent.fx, intent.fy)).toBeLessThan(0.01 * getShipKind('battleship').ai.thrust);
  });

  it('out of reach, target ahead: closes at full thrust', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    const intent = b.tick(self, view(0, mainReach() * 2));
    expect(Math.hypot(intent.fx, intent.fy)).toBeCloseTo(getShipKind('battleship').ai.thrust, 3);
  });
});
