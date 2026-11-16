import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { LOCK_CONSUMABLE, LOCK_SALVAGE, TURRET_NO_LOCK, lockTierBits, pickTurretLock } from './turretLockPick.js';
import { SALVAGE_TIER_NONE, mountTier } from './salvageTargeting.js';

// Salvage share-out (owner 2026-11-16): a group's mining lasers spread over
// the locked pieces, big lasers on big pieces, skipping pieces a tractor of
// their own size can take (the size ladder: the piece's tier bits).

/** Flags of a salvage piece whose tier is `size` (the smallest tractor that pulls it). */
const tierOf = (size: WeaponMount['size']): number => LOCK_SALVAGE | lockTierBits(mountTier(size));

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

  it('a piece a tractor of the lasers\' own size can take is skipped', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    // The biggest piece is L-tier: both L lasers share the other two.
    const got = picks(group, [100, 900, 50], [S, tierOf('L'), S]);
    expect(got).not.toContain(1);
    expect(got).toEqual([0, 2]);
  });

  it('every piece at or below every laser\'s size: no aim, so the laser does not fire', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'S')];
    const H = tierOf('AA');
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
    const flagged = picks(group, radii, [S, S, S, tierOf('S')]);
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

describe('pickTurretLock: mining lasers only take pieces they can engage', () => {
  const S = LOCK_SALVAGE;
  /** An arc-limited laser facing `base` (rad; -π/2 faces +x, +π/2 faces -x). */
  const sided = (base: number) =>
    ({ baseAngle: base, arcMin: -0.5, arcMax: 0.5, rotationSpeed: 1, weaponId: 'mining_laser' as const, size: 'L' as const });
  const run = (group: ReadonlyArray<ReturnType<typeof sided>>, xs: number[], radii: number[], flags: number[]) =>
    group.map((m, o) => pickTurretLock(m, 0, 0, 0, REACH, o, xs.length, xs, xs.map(() => 0), radii.map(piece), flags, group));

  it('port and starboard lasers on rocks either side: each takes the rock in its own arc', () => {
    // Laser 0 faces port (-x), laser 1 starboard (+x); the BIG rock is to starboard.
    const group = [sided(Math.PI / 2), sided(-Math.PI / 2)];
    expect(run(group, [1000, -1000], [500, 100], [S, S])).toEqual([1, 0]);
  });

  it('a big piece out of reach: both lasers cut the small piece in reach', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    const got = group.map((m, o) =>
      pickTurretLock(m, 0, 0, 0, REACH, o, 2, [REACH * 3, 1000], [0, 0], [piece(900), piece(50)], [S, S], group));
    expect(got).toEqual([1, 1]);
  });

  it('no piece engageable: the laser parks on the first cuttable piece (as the ordinary pick parks)', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    const far = REACH * 3;
    const got = group.map((m, o) =>
      pickTurretLock(m, 0, 0, 0, REACH, o, 3, [far, far, far], [0, 1, 2], [piece(10), piece(900), piece(50)], [tierOf('L'), S, S], group));
    expect(got).toEqual([1, 1]);
  });

  it('an unknown pose (NaN, the client has no mirror entry) is never engageable', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'L')];
    const got = group.map((m, o) =>
      pickTurretLock(m, 0, 0, 0, REACH, o, 2, [NaN, 1000], [NaN, 0], [piece(900), piece(50)], [S, S], group));
    expect(got).toEqual([1, 1]);
  });
});

describe('pickTurretLock: piece size order is float32-stable (#15)', () => {
  it('server float64 radii and client float32 wire radii rank sibling pieces the same', () => {
    const a = 100.000001;
    const b = 100.000002;
    expect(Math.fround(a)).toBe(Math.fround(b)); // the wire can't tell them apart
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'S')];
    const server = picks(group, [a, b], [LOCK_SALVAGE, LOCK_SALVAGE]);
    const client = picks(group, [Math.fround(a), Math.fround(b)], [LOCK_SALVAGE, LOCK_SALVAGE]);
    expect(server).toEqual(client);
  });
});

describe('pickTurretLock: consumable pieces (the factory line)', () => {
  const S = LOCK_SALVAGE;
  const C = LOCK_SALVAGE | LOCK_CONSUMABLE;
  it('no laser aims at a consumable piece: it cuts the others, or has no aim', () => {
    const group = [mount('mining_laser', 'L'), mount('mining_laser', 'S')];
    for (const p of picks(group, [100, 30, 200], [S, C, S])) expect(p).not.toBe(1);
    expect(picks(group, [30], [C])).toEqual([TURRET_NO_LOCK, TURRET_NO_LOCK]);
  });

  it('a tractor skips a consumable piece and has no aim when every lock is one', () => {
    const group = [mount('tractor', 'L'), mount('tractor', 'S')];
    expect(picks(group, [30], [C])).toEqual([TURRET_NO_LOCK, TURRET_NO_LOCK]);
    expect(picks(group, [30, 40], [C, tierOf('S')])).toEqual([1, 1]);
  });
});

describe('pickTurretLock: the size ladder (owner 2026-11-16)', () => {
  const NONE = LOCK_SALVAGE | lockTierBits(SALVAGE_TIER_NONE);
  it('an XL laser skips an L-tier piece and an S laser cuts it', () => {
    const group = [mount('mining_laser', 'XL'), mount('mining_laser', 'S')];
    expect(picks(group, [40], [tierOf('L')])).toEqual([TURRET_NO_LOCK, 0]);
    // Beside a huge rock no tractor pulls: the XL laser on the rock, the S laser on the L-tier piece.
    expect(picks(group, [500, 40], [NONE, tierOf('L')])).toEqual([0, 1]);
  });

  it('every laser size works its own rung: XL/L the huge rocks, M the XL/L-tier pieces, S the M-tier ones', () => {
    const group = [mount('mining_laser', 'XL'), mount('mining_laser', 'M'), mount('mining_laser', 'S')];
    // Lock order: an M-tier piece, a huge rock, an L-tier piece.
    expect(picks(group, [25, 800, 35], [tierOf('M'), NONE, tierOf('L')])).toEqual([1, 2, 0]);
  });

  it('an L tractor takes an L-tier piece; an S tractor ignores it', () => {
    const group = [mount('tractor', 'L'), mount('tractor', 'S')];
    expect(picks(group, [40], [tierOf('L')])).toEqual([0, TURRET_NO_LOCK]);
    expect(picks(group, [40, 15], [tierOf('L'), tierOf('S')])).toEqual([0, 1]);
  });

  it('a tractor takes the biggest piece it can pull, never one too big for every tractor', () => {
    const group = [mount('tractor', 'L')];
    expect(picks(group, [20, 900, 60, 40], [tierOf('S'), NONE, tierOf('L'), tierOf('M')])).toEqual([2]);
    expect(picks(group, [900], [NONE])).toEqual([TURRET_NO_LOCK]);
  });

  it('two tractors of one size share the pieces out biggest first', () => {
    const group = [mount('tractor', 'M'), mount('tractor', 'M')];
    expect(picks(group, [20, 30], [tierOf('S'), tierOf('M')])).toEqual([1, 0]);
  });
});
