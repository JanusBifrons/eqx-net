/**
 * `mountsReachTarget`: is a target inside FIRE range of any of a set of
 * mounts (each from its own world position, with its own gun's reach, to the
 * target's true hit shape via `shipWithinHullReach`)? Since locks work at any
 * distance (owner 2026-11-14), this is what AUTO groups release on and what
 * gates the "locks keep it hostile" refresh.
 */
import { describe, it, expect } from 'vitest';
import { mountsReachTarget, mountWeaponReach, type FireRangeTarget } from './mountReach.js';
import { shipHitBound } from './shipHitShape.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';

const fighter = getShipKind('fighter');
const battleship = getShipKind('battleship');

function target(x: number, kindId: string | null, radius = 30): FireRangeTarget {
  return { x, y: 0, angle: 0, kindId, radius };
}

describe('mountsReachTarget', () => {
  const mounts = fighter.mounts ?? [];
  const reach = Math.max(...mounts.map((m) => mountWeaponReach(m)));

  it('a fighter in reach of the guns is in fire range; one far past it is not', () => {
    expect(mountsReachTarget(mounts, 0, 0, 0, target(reach * 0.5, 'fighter'))).toBe(true);
    expect(mountsReachTarget(mounts, 0, 0, 0, target(reach * 5, 'fighter'))).toBe(false);
  });

  it('measures to the hull, not the centre: a big hull is in range while its centre is past reach', () => {
    const bound = shipHitBound('battleship');
    // Centre past reach, but the near side of the hull well inside.
    const x = reach + bound * 0.5;
    expect(Math.hypot(x, 0)).toBeGreaterThan(reach);
    expect(mountsReachTarget(mounts, 0, 0, 0, { x: 0, y: x, angle: 0, kindId: 'battleship', radius: battleship.radius })).toBe(true);
  });

  it('a kindless target (a structure) is a circle of `radius`', () => {
    expect(mountsReachTarget(mounts, 0, 0, 0, target(reach + 90, null, 100))).toBe(true);
    expect(mountsReachTarget(mounts, 0, 0, 0, target(reach + 110, null, 100))).toBe(false);
  });

  it('slack widens every reach (the AUTO release hysteresis)', () => {
    const t = target(reach + 60, null, 0);
    expect(mountsReachTarget(mounts, 0, 0, 0, t)).toBe(false);
    expect(mountsReachTarget(mounts, 0, 0, 0, t, 1.1)).toBe(reach * 0.1 >= 60);
  });

  it('a mount measures from its own world position (offset + hull heading)', () => {
    const m: WeaponMount = { ...(mounts[0]!), id: 'off', localX: 0, localY: 500 };
    const r = mountWeaponReach(m);
    // Heading 0: forward = +y, so the mount sits 500 u ahead.
    expect(mountsReachTarget([m], 0, 0, 0, { x: 0, y: 500 + r - 1, angle: 0, kindId: null, radius: 0 })).toBe(true);
    // Turned half round: the mount is now 500 u behind; the same point is out.
    expect(mountsReachTarget([m], 0, 0, Math.PI, { x: 0, y: 500 + r - 1, angle: 0, kindId: null, radius: 0 })).toBe(false);
  });

  it('no mounts: never in range', () => {
    expect(mountsReachTarget([], 0, 0, 0, target(1, 'fighter'))).toBe(false);
  });
});
