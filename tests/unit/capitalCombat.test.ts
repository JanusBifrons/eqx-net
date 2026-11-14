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
import { canTrack, mountLineClear, mountPriority, targetClass } from '../../src/core/combat/mountTargeting';
import { HostileDroneBehaviour, BROADSIDE_STANDOFF } from '../../src/core/ai/HostileDroneBehaviour';
import { getShipKind } from '../../src/shared-types/shipKinds';
import type { AiWorldView } from '../../src/core/contracts/IAiBehaviour';
import { stepKinematic, throttleOf, turnOf } from '../../src/core/ai/pilotTestKit';

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
    it(`${id}: every gun fires its calibre's weapon; AA mounts fire laser bolts from 4 barrels`, () => {
      const kind = getShipKind(id);
      expect(kind.mounts.length).toBeGreaterThan(0);
      expect(kind.mounts.some((m) => m.size === 'AA')).toBe(true);
      for (const m of kind.mounts) {
        if (m.size === 'AA') { expect(m.weaponId).toBe('laser'); expect(m.barrels).toBe(4); continue; }
        expect(m.weaponId).toBe(`naval_${m.size!.toLowerCase()}`);
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
      const realMax: Record<string, number> = { AA: 0.5, S: 0.27, M: 0.15, L: 0.09, XL: 0.075 }; // ~15/8/5/4 °/s
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
    // Holds its heading and station at the stand-off: no key held (no turn, no
    // thrust), so it does not steam out of reach.
    expect(intent.input).toBe(0);
  });

  it('in reach, just off the stand-off: holds still, so the hull comes to rest (no creep)', () => {
    // perf scene capital-duel (PR #549 CI, 2026-11-14): the pilot 4,000 u off
    // the beam, the stand-off ~4,032 u (0.8 % off). The brain asked for
    // 0.78 u/s along the beam — a creep that corrects the range by under
    // 0.004 u/s — so the pilot kept tapping thrust and the hull never rested:
    // its pose went out every tick (swarm wire 0.24 → 3.1 KB/s). A captain at
    // the stand-off holds station, keys off, like a player who holds nothing.
    const kind = getShipKind('battleship');
    const standoff = mainReach() * BROADSIDE_STANDOFF;
    for (const d of [4000, standoff * 0.98, standoff * 1.02]) {
      const b = new HostileDroneBehaviour('battleship');
      b.markHostile('p', 100);
      const body = { ...self };
      for (let t = 0; t < 600; t++) {
        const intent = b.tick({ id: 'bs', ...body }, view(d, 0));
        expect(intent.input, `range ${d.toFixed(0)}, tick ${t}: no key while at the stand-off`).toBe(0);
        stepKinematic(body, kind, intent);
      }
      expect(Math.hypot(body.vx, body.vy)).toBe(0);
    }
  });

  it('in reach, well inside the stand-off: still opens the range', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    const intent = b.tick(self, view(mainReach() * BROADSIDE_STANDOFF * 0.5, 0));
    expect(intent.input).not.toBe(0);
  });

  it('in reach, bow-on: turns the beam toward the target', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    const intent = b.tick(self, view(0, mainReach() * BROADSIDE_STANDOFF));
    expect(intent.fire).toBeUndefined();
    expect(turnOf(intent)).not.toBe(0);
  });

  it('out of reach, target abeam: turns toward it WITHOUT steaming away', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    // Far off the starboard beam: must turn toward +x (negative angle in the
    // ship convention: forward = (-sin a, cos a)) and not thrust while facing
    // away (the film found a battleship steaming off out of its own reach).
    const intent = b.tick(self, view(mainReach() * 2, 0));
    expect(turnOf(intent)).toBe(-1);
    expect(throttleOf(intent)).not.toBe(1);
  });

  it('out of reach, target astern: backs its engines (brakes the way away, never thrusts ahead)', () => {
    // showcase-capital-duel 2026-11-12: a battleship that aggroed while making
    // way ahead, its target astern, coasted out of its own reach for the whole
    // turn. It must back toward the target at its own reverse power.
    const kind = getShipKind('battleship');
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    const intent = b.tick({ ...self, vy: 40 }, view(0, -mainReach() * 1.1));
    expect(kind.reverseFactor).toBeGreaterThan(0);
    expect(throttleOf(intent), 'it must back its engines (reverse), toward the target').toBe(-1);
  });

  it('out of reach, target ahead: closes at full thrust', () => {
    const b = new HostileDroneBehaviour('battleship');
    b.markHostile('p', 100);
    const intent = b.tick(self, view(0, mainReach() * 2));
    expect(throttleOf(intent)).toBe(1);
    expect(turnOf(intent)).toBe(0);
  });
});

describe('turret targeting: priority + what a turret can practically engage', () => {
  it('each gun size prefers its own class, but no class is banned', () => {
    expect(targetClass(getShipKind('fighter'))).toBe('small');
    expect(targetClass(getShipKind('crossguard'))).toBe('subcapital');
    expect(targetClass(getShipKind('destroyer'))).toBe('small-capital');
    expect(targetClass(getShipKind('battleship'))).toBe('capital');
    expect(mountPriority('XL', 'capital')).toBeLessThan(mountPriority('XL', 'small'));
    expect(mountPriority('S', 'subcapital')).toBeLessThan(mountPriority('S', 'capital'));
    expect(mountPriority('S', 'capital')).toBeLessThan(mountPriority('S', 'small'));
    expect(mountPriority('AA', 'small')).toBeLessThan(mountPriority('AA', 'capital'));
    for (const s of ['AA', 'S', 'M', 'L', 'XL'] as const) expect(Number.isFinite(mountPriority(s, 'small'))).toBe(true);
  });

  it('a 16" turret cannot track a fighter darting past close by, but can a slow or distant one', () => {
    const xl = getShipKind('battleship').mounts.find((m) => m.size === 'XL')!;
    const aa = getShipKind('battleship').mounts.find((m) => m.size === 'AA')!;
    // Fighter 1,500 u abeam crossing at 300 u/s: bearing rate 0.2 rad/s.
    expect(canTrack(xl.rotationSpeed, 1500, 0, 0, 300)).toBe(false);
    expect(canTrack(aa.rotationSpeed, 1500, 0, 0, 300)).toBe(true);
    // The same fighter sitting still, or far off, is trackable by the 16".
    expect(canTrack(xl.rotationSpeed, 1500, 0, 0, 0)).toBe(true);
    expect(canTrack(xl.rotationSpeed, 6000, 0, 0, 300)).toBe(true);
  });

  it('guns fire outwards, never down the length of their own hull', () => {
    const bs = getShipKind('battleship');
    const fore = bs.mounts.find((m) => m.id === 'main-1')!;
    expect(mountLineClear(bs, fore, Math.PI / 2)).toBe(true); // abeam to port
    expect(mountLineClear(bs, fore, -Math.PI / 2)).toBe(true); // abeam to starboard
    expect(mountLineClear(bs, fore, Math.PI)).toBe(false); // straight aft, along the deck
    const aaStbd = bs.mounts.find((m) => m.size === 'AA' && m.localX > 0)!;
    expect(mountLineClear(bs, aaStbd, -Math.PI / 2)).toBe(true); // outboard
    expect(mountLineClear(bs, aaStbd, Math.PI / 2)).toBe(false); // across its own deck
  });
});
