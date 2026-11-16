import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { LOCK_HAULABLE, LOCK_SALVAGE, TURRET_NO_LOCK, pickTurretLock } from './turretLockPick.js';

// Salvage share-out (owner 2026-11-16): a group's mining lasers spread over
// the locked pieces, big lasers on big pieces, skipping pieces the ship can
// already tow AND store (`LOCK_HAULABLE`).

const REACH = 5000;
const mount = (weaponId: WeaponMount['weaponId'], size: WeaponMount['size']) =>
  ({ baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 1, weaponId, size });
const piece = (radius: number) => ({ kindId: null, angle: 0, shieldUp: false, radius });

/** Every mount's pick, in group order. */
function picks(
  group: ReturnType<typeof mount>[], radii: number[], flags: number[],
): number[] {
  const n = radii.length;
  const tx = radii.map((_, i) => 500 * (i + 1));
  const ty = radii.map(() => 0);
  const shapes = radii.map(piece);
  return group.map((m, o) => pickTurretLock(m, 0, 0, 0, REACH, o, n, tx, ty, shapes, flags, group));
}

describe('pickTurretLock: mining lasers on salvage locks', () => {
  const S = LOCK_SALVAGE;
  it('L,L,S,S on 4 pieces: each L on one of the 2 biggest, each S on a small, all distinct', () => {
    // Pieces in lock order: small, big, smaller, biggest.
    const radii = [40, 300, 20, 500];
    const group = [mount('mining_laser', 'S'), mount('mining_laser', 'L'), mount('mining_laser', 'S'), mount('mining_laser', 'L')];
    const got = picks(group, radii, [S, S, S, S]);
    expect(new Set(got).size).toBe(4);
    for (const o of [1, 3]) expect([1, 3]).toContain(got[o]);
    for (const o of [0, 2]) expect([0, 2]).toContain(got[o]);
  });

  it('two lasers on one cuttable piece: both on it (no n === 1 short-circuit miss)', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'S')];
    expect(picks(group, [200], [S])).toEqual([0, 0]);
  });

  it('a piece the ship can tow and store is skipped', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    // The biggest piece is haulable: both lasers share the other two.
    const got = picks(group, [100, 900, 50], [S, S | LOCK_HAULABLE, S]);
    expect(got).not.toContain(1);
    expect(got).toEqual([0, 2]);
  });

  it('every piece haulable: no aim, so the laser does not fire', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'S')];
    const H = S | LOCK_HAULABLE;
    expect(picks(group, [100, 900], [H, H])).toEqual([TURRET_NO_LOCK, TURRET_NO_LOCK]);
    expect(picks(group, [100], [H])).toEqual([TURRET_NO_LOCK, TURRET_NO_LOCK]);
  });

  it('more lasers than pieces: they wrap round the pieces, biggest first', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    expect(picks(group, [100, 300], [S, S])).toEqual([1, 0, 1]);
  });

  it('a non-salvage mount on the same locks keeps the old share-out', () => {
    const radii = [40, 300, 20, 500];
    const group = [mount('naval_m', 'S'), mount('naval_m', 'L'), mount('naval_m', 'S'), mount('naval_m', 'L')];
    const flagged = picks(group, radii, [S, S, S, S | LOCK_HAULABLE]);
    const tx = radii.map((_, i) => 500 * (i + 1));
    const ty = radii.map(() => 0);
    const shapes = radii.map(piece);
    const old = group.map((m, o) => pickTurretLock(m, 0, 0, 0, REACH, o, 4, tx, ty, shapes));
    expect(flagged).toEqual(old);
    expect(old).toEqual([0, 1, 2, 3]);
  });

  it('a mining laser on non-salvage locks keeps the old share-out', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    expect(picks(group, [10, 20], [0, 0])).toEqual([0, 1]);
  });
});
