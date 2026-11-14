/**
 * `mountsReachTarget`: is a target inside FIRE range of any of a set of
 * mounts (each from its own world position, with its own gun's reach, to the
 * target's hit shape via the shared per-turret gate `mountInReach`)? Since
 * locks work at any distance (owner 2026-11-14), this is what AUTO groups
 * release on and what gates the "locks keep it hostile" refresh.
 */
import { describe, it, expect } from 'vitest';
import { mountsReachTarget, mountWeaponReach, type MountRangeTarget } from './mountReach.js';
import { shipHitBound } from './shipHitShape.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';

const fighter = getShipKind('fighter');
const ship = (kindId: string): MountRangeTarget => ({ kindId, angle: 0, shieldUp: true });
const circle = (radius: number): MountRangeTarget => ({ kindId: null, radius });

describe('mountsReachTarget', () => {
  const mounts = fighter.mounts ?? [];
  const reach = Math.max(...mounts.map((m) => mountWeaponReach(m)));

  it('a fighter in reach of the guns is in fire range; one far past it is not', () => {
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, reach * 0.5, ship('fighter'))).toBe(true);
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, reach * 5, ship('fighter'))).toBe(false);
  });

  it('measures to the hull, not the centre: a big hull is in range while its centre is past reach', () => {
    const bound = shipHitBound('battleship');
    const y = reach + bound * 0.5;
    expect(y).toBeGreaterThan(reach);
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, y, ship('battleship'))).toBe(true);
  });

  it('a kindless target (a structure) is a circle of `radius`', () => {
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, reach + 90, circle(100))).toBe(true);
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, reach + 130, circle(100))).toBe(false);
  });

  it('slack widens every reach (the AUTO release hysteresis)', () => {
    const y = reach * 1.05;
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, y, circle(0))).toBe(false);
    expect(mountsReachTarget(mounts, 0, 0, 0, 0, y, circle(0), 1.1)).toBe(true);
  });

  it('a mount measures from its own world position (offset + hull heading)', () => {
    const m: WeaponMount = { ...(mounts[0]!), id: 'off', localX: 0, localY: 500 };
    const r = mountWeaponReach(m);
    // Heading 0: forward = +y, so the mount sits 500 u ahead.
    expect(mountsReachTarget([m], 0, 0, 0, 0, 500 + r - 1, circle(0))).toBe(true);
    // Turned half round: the mount is now 500 u behind; the same point is out.
    expect(mountsReachTarget([m], 0, 0, Math.PI, 0, 500 + r - 1, circle(0))).toBe(false);
  });

  it('no mounts: never in range', () => {
    expect(mountsReachTarget([], 0, 0, 0, 0, 1, ship('fighter'))).toBe(false);
  });
});
