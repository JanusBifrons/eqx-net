import { describe, it, expect } from 'vitest';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon } from './WeaponCatalogue.js';
import { TRACTOR_DEF } from './tractorSpec.js';
import { mountPriority } from './mountTargeting.js';
import {
  SALVAGE_CANDIDATE_CAP, SALVAGE_HAUL_DIST_PER_DREF, SALVAGE_HAUL_MIN_ACCEL, SALVAGE_TARGET_CLASS,
  filterSalvageCandidates, isSalvageWeapon, pickSalvageTarget, salvageHaulMass,
  type SalvageCandidate, type SalvagePickWork,
} from './salvageTargeting.js';

const mount = (id: string, weaponId: WeaponMount['weaponId'], size?: WeaponMount['size']): WeaponMount => ({
  id, localX: 0, localY: 0, baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 1, weaponId,
  ...(size !== undefined ? { size } : {}),
});
const piece = (id: string, x: number, mass: number, holdWeight = 1, radius = 10): SalvageCandidate =>
  ({ id, x, y: 0, radius, mass, holdWeight });

const REACH = 5000;
const pick = (c: SalvageCandidate[], claims: number[], size: WeaponMount['size'], haulMass = 0, freeHold = 0): number =>
  pickSalvageTarget(c, c.length, claims, size, 0, 0, REACH, haulMass, freeHold);

describe('salvage targeting (salvage PR 16)', () => {
  it('only a mining weapon picks salvage (its rock factor, not its id)', () => {
    expect(isSalvageWeapon(getWeapon('mining_laser'))).toBe(true);
    expect(isSalvageWeapon(getWeapon('naval_m'))).toBe(false);
    expect(isSalvageWeapon(getWeapon('heavy_beam'))).toBe(false);
    expect(isSalvageWeapon(getWeapon('tractor'))).toBe(false);
  });

  it('salvage is the last choice for every combat mount', () => {
    for (const size of ['AA', 'S', 'M', 'L', 'XL', undefined] as const) {
      for (const cls of ['small', 'subcapital', 'small-capital', 'capital', 'structure'] as const) {
        expect(mountPriority(size, SALVAGE_TARGET_CLASS)).toBeGreaterThan(mountPriority(size, cls));
      }
    }
  });

  it('haul mass: the tractor record force × size power, at the haul distance falloff, over the min accel', () => {
    const t = TRACTOR_DEF.tractor!;
    const falloff = 1 / (SALVAGE_HAUL_DIST_PER_DREF * SALVAGE_HAUL_DIST_PER_DREF);
    expect(salvageHaulMass([mount('a', 'mining_laser', 'XL')])).toBe(0);
    expect(salvageHaulMass([mount('t', 'tractor', 'S')])).toBeCloseTo((t.force * falloff) / SALVAGE_HAUL_MIN_ACCEL);
    const two = [mount('t1', 'tractor', 'XL'), mount('t2', 'tractor', 'AA')];
    const want = (t.force * (MOUNT_SIZE_TUNING.XL.power + MOUNT_SIZE_TUNING.AA.power) * falloff) / SALVAGE_HAUL_MIN_ACCEL;
    expect(salvageHaulMass(two)).toBeCloseTo(want);
  });

  it('a piece this ship can tractor AND store is no laser target', () => {
    const c = [piece('light', 100, 50, 5), piece('heavy', 200, 5000, 5)];
    // Light enough to haul and fits the hold: skipped, the heavy one is cut.
    expect(pick(c, [0, 0], 'S', 150, 100)).toBe(1);
    // Hold full: the light piece can't be stored, so the laser cuts it.
    expect(pick(c, [0, 0], 'S', 150, 2)).toBe(0);
    // No tractor (haul mass 0): every piece is cut.
    expect(pick(c, [0, 0], 'S', 0, 100)).toBe(0);
    // Everything haulable: nothing to cut.
    expect(pick([c[0]!], [0], 'XL', 1e9, 100)).toBe(-1);
  });

  it('big mounts take big pieces, small mounts finish small ones', () => {
    const c = [piece('mid', 300, 800), piece('big', 900, 4000), piece('small', 100, 200)];
    expect(pick(c, [0, 0, 0], 'XL')).toBe(1);
    expect(pick(c, [0, 0, 0], 'M')).toBe(1);
    expect(pick(c, [0, 0, 0], 'S')).toBe(2);
    expect(pick(c, [0, 0, 0], 'AA')).toBe(2);
    expect(pick(c, [0, 0, 0], undefined)).toBe(2);
  });

  it('out of reach (to the piece edge) is skipped', () => {
    const c = [piece('far', REACH + 100, 9000, 1, 50), piece('edge', REACH + 40, 10, 1, 50)];
    expect(pick(c, [0, 0], 'XL')).toBe(1);
  });

  it('spreads: each mount takes an unclaimed piece, doubling up only when none is left', () => {
    const c = [piece('a', 100, 3000), piece('b', 200, 2000), piece('c', 300, 1000)];
    const claims = [0, 0, 0];
    const sizes: WeaponMount['size'][] = ['XL', 'XL', 'XL', 'XL'];
    const got: number[] = [];
    for (const s of sizes) {
      const j = pick(c, claims, s);
      got.push(j);
      claims[j]!++;
    }
    // Three lasers on three pieces (biggest first), the fourth doubles up.
    expect(got.slice(0, 3).sort()).toEqual([0, 1, 2]);
    expect(got[3]).toBe(0);
    expect(claims).toEqual([2, 1, 1]);
  });

  it('a claimed piece is taken when nothing else is in reach', () => {
    const c = [piece('near', 100, 3000), piece('far', REACH * 3, 3000)];
    expect(pick(c, [1, 0], 'S')).toBe(0);
  });

  it('filter: unhaulable, in reach, nearest SALVAGE_CANDIDATE_CAP, sorted', () => {
    const src: SalvageCandidate[] = [];
    for (let i = 0; i < 200; i++) src.push(piece(`p${i}`, (199 - i) * 20, i % 4 === 0 ? 10 : 1000));
    src.push(piece('far', REACH * 4, 1000));
    const out: SalvageCandidate[] = [];
    const d2 = new Float64Array(SALVAGE_CANDIDATE_CAP);
    const n = filterSalvageCandidates(src, src.length, 0, 0, REACH, 100, 50, out, d2);
    expect(n).toBe(SALVAGE_CANDIDATE_CAP);
    for (let k = 0; k < n; k++) {
      expect(out[k]!.mass).toBeGreaterThan(100);
      if (k > 0) expect(out[k]!.x).toBeGreaterThanOrEqual(out[k - 1]!.x);
    }
    expect(out[0]!.id).toBe('p199');
  });

  it('count budget: a retarget costs ≤ cap evaluations per mount, however big the field', () => {
    // 600 pieces, 40 mining mounts, staggered retarget like tickCapitalMounts
    // ((tick + i × 7) % RETARGET_TICKS), one filter per tick some mount retargets.
    const RETARGET_TICKS = 30;
    const MOUNTS = 40;
    const src: SalvageCandidate[] = [];
    for (let i = 0; i < 600; i++) src.push(piece(`p${i}`, (i * 37) % 4000, 500 + ((i * 131) % 5000)));
    const out: SalvageCandidate[] = [];
    const d2 = new Float64Array(SALVAGE_CANDIDATE_CAP);
    const claims = new Int32Array(SALVAGE_CANDIDATE_CAP);
    const work: SalvagePickWork = { evals: 0 };
    let maxTick = 0;
    for (let tick = 0; tick < RETARGET_TICKS * 2; tick++) {
      const before = work.evals;
      let n = -1;
      for (let i = 0; i < MOUNTS; i++) {
        if ((tick + i * 7) % RETARGET_TICKS !== 0) continue;
        if (n < 0) { n = filterSalvageCandidates(src, src.length, 0, 0, REACH, 100, 50, out, d2, work); claims.fill(0); }
        const pre = work.evals;
        const j = pickSalvageTarget(out, n, claims, i % 2 === 0 ? 'XL' : 'S', 0, 0, REACH, 100, 50, work);
        expect(work.evals - pre).toBeLessThanOrEqual(SALVAGE_CANDIDATE_CAP);
        if (j >= 0) claims[j]!++;
      }
      maxTick = Math.max(maxTick, work.evals - before);
    }
    // Per tick: one pass over the field plus ≤ cap per retargeting mount
    // (at most ceil(MOUNTS / (RETARGET_TICKS / gcd(7, 30))) = 2 mounts a tick).
    expect(maxTick).toBeLessThanOrEqual(src.length + 2 * SALVAGE_CANDIDATE_CAP);
  });
});
