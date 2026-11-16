/**
 * Capital turret SALVAGE targeting (salvage plan partitioned-chasing-lark
 * PR 16; owner's "smart mining lasers" rule, 2026-11-16). Pure and
 * allocation-free after the first call per mount list (#14), so the server's
 * `WeaponMountTicker` (and any later client mirror) runs the same picks.
 *
 * A mount whose weapon MINES (`isSalvageWeapon`: a 'rock' target factor
 * above 0, the mining laser) picks among salvage candidates (wreck pieces,
 * rocks, rock pieces; class `SALVAGE_TARGET_CLASS`) instead of hostiles:
 *  1. **Haulable by me ⇒ not a target.** A laser stops cutting a piece once
 *     THIS ship could tractor it in and store it: its mass is at most
 *     `salvageHaulMass` (the ship's strongest tractor mount, at
 *     `SALVAGE_HAUL_DIST_PER_DREF` × dRef, give it at least
 *     `SALVAGE_HAUL_MIN_ACCEL`: the tractor's own fixed force and falloff,
 *     `tractorPull`, accel = F / m) AND its hold weight fits the free hold.
 *  2. **Spread.** A cut roughly halves a piece, so about one laser per piece:
 *     a mount skips a piece another of this ship's mining mounts has claimed
 *     unless nothing unclaimed is in reach (fewest claims first).
 *  3. **Size match.** Heavy mounts (M/L/XL, the same split as
 *     `mountPriority`) take the heaviest piece in reach; light ones (AA/S,
 *     unsized) finish the lightest. Distance breaks ties.
 * The ship filters its candidates ONCE per retarget (`filterSalvageCandidates`
 * over its broadphase query: unhaulable, in reach, nearest
 * `SALVAGE_CANDIDATE_CAP`), so a retarget costs at most cap evaluations per
 * mount whatever the size of the field.
 */
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING } from '../../shared-types/shipScale/tuning.js';
import { getWeapon, weaponTargetFactor, type WeaponDef } from './WeaponCatalogue.js';
import { mountWeaponReach } from './mountReach.js';
import { tractorPull } from './tractorSpec.js';
import { SALVAGE_TARGET_CLASS } from './mountTargeting.js';

export { SALVAGE_TARGET_CLASS };

/** A tractor is judged able to haul a piece when it can accelerate it at
 *  least this much (u/s²) at the haul distance. 10 u/s² brings a piece in
 *  from 500 u in about 10 s; the tractor record's own example ("a 2,000-mass
 *  one at 3 u/s²") is the "barely moves" case this rules out. */
export const SALVAGE_HAUL_MIN_ACCEL = 10;

/** The haul distance, in multiples of the tractor's `dRef`: a piece just
 *  outside the cushion being drawn in, where the inverse-square falloff has
 *  already cut the pull to a quarter. Judging at full force (≤ dRef) would
 *  call pieces haulable that the beam can't start moving from range. */
export const SALVAGE_HAUL_DIST_PER_DREF = 2;

/** Most candidates one ship keeps per retarget (nearest first): bounds a
 *  mount's retarget at this many evaluations however big the field. */
export const SALVAGE_CANDIDATE_CAP = 32;

/** One salvage candidate (a wreck piece, a rock or a rock piece). */
export interface SalvageCandidate {
  id: string;
  x: number;
  y: number;
  /** Bounding radius: reach is judged to its edge. */
  radius: number;
  /** Body mass (the tractor accelerates it by F / mass). */
  mass: number;
  /** Hold weight it would take once stored (its pod's goods × weight). */
  holdWeight: number;
}

/** Optional work counter for count-budget tests (candidate evaluations). */
export interface SalvagePickWork { evals: number }

/** Does this weapon mine (and so pick salvage, not hostiles)? Data-driven:
 *  only a weapon naming a 'rock' factor mines (`weaponTargetFactor`). */
export function isSalvageWeapon(def: WeaponDef): boolean {
  return weaponTargetFactor(def, 'rock') > 0;
}

/** Heavy mounts take big pieces, light ones small (mountPriority's split). */
export function salvagePrefersBig(size: WeaponMount['size']): boolean {
  return size === 'M' || size === 'L' || size === 'XL';
}

const haulCache = new WeakMap<ReadonlyArray<WeaponMount>, number>();

/** The heaviest piece this ship can haul: its STRONGEST SINGLE tractor
 *  mount's `tractorPull(force × size power, dRef, reach, haul distance)`
 *  over `SALVAGE_HAUL_MIN_ACCEL`. One tractor per piece, like one laser per
 *  piece (each tractor locks its own target), so pulls never sum. 0 with no
 *  tractor. Cached per mount list. */
export function salvageHaulMass(mounts: ReadonlyArray<WeaponMount>): number {
  const hit = haulCache.get(mounts);
  if (hit !== undefined) return hit;
  let force = 0;
  for (const m of mounts) {
    const t = getWeapon(m.weaponId).tractor;
    if (t === undefined) continue;
    const power = MOUNT_SIZE_TUNING[m.size ?? 'S'].power;
    const pull = tractorPull(t.force * power, t.dRef, mountWeaponReach(m), SALVAGE_HAUL_DIST_PER_DREF * t.dRef);
    if (pull > force) force = pull;
  }
  const mass = force / SALVAGE_HAUL_MIN_ACCEL;
  haulCache.set(mounts, mass);
  return mass;
}

/** Could this ship tractor `c` in and store it? Then no laser cuts it. */
export function salvageHaulable(c: SalvageCandidate, haulMass: number, freeHold: number): boolean {
  return c.mass <= haulMass && c.holdWeight <= freeHold;
}

/**
 * The once-per-retarget filter: copy into `out` the candidates of `src[0..n)`
 * that are NOT haulable and lie within `reach` (to their edge) of the ship at
 * (sx, sy), nearest first, at most `SALVAGE_CANDIDATE_CAP`. Returns the count.
 * `out` is caller scratch (reused; written by reference). O(n × cap) worst.
 */
export function filterSalvageCandidates(
  src: ReadonlyArray<SalvageCandidate>, n: number, sx: number, sy: number, reach: number,
  haulMass: number, freeHold: number, out: SalvageCandidate[], dist2: Float64Array, work?: SalvagePickWork,
): number {
  let k = 0;
  for (let j = 0; j < n; j++) {
    const c = src[j]!;
    if (work !== undefined) work.evals++;
    if (salvageHaulable(c, haulMass, freeHold)) continue;
    const dx = c.x - sx, dy = c.y - sy;
    const r = reach + c.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) continue;
    if (k === SALVAGE_CANDIDATE_CAP && d2 >= dist2[k - 1]!) continue;
    // Insertion into the sorted head (stable: ties keep input order).
    let p = k < SALVAGE_CANDIDATE_CAP ? k++ : k - 1;
    while (p > 0 && dist2[p - 1]! > d2) { out[p] = out[p - 1]!; dist2[p] = dist2[p - 1]!; p--; }
    out[p] = c; dist2[p] = d2;
  }
  return k;
}

/**
 * One mining mount's pick among `cands[0..n)` (already filtered, or raw:
 * haulable and out-of-reach ones are skipped here too). `claims[j]` = how
 * many OTHER mining mounts of this ship hold candidate j. Lowest
 * (claims, size preference, distance) wins. Returns the index, or -1.
 */
export function pickSalvageTarget(
  cands: ReadonlyArray<SalvageCandidate>, n: number, claims: ArrayLike<number>,
  size: WeaponMount['size'], mx: number, my: number, reach: number,
  haulMass: number, freeHold: number, work?: SalvagePickWork,
): number {
  const big = salvagePrefersBig(size);
  let best = -1, bestClaims = Infinity, bestMass = 0, bestD2 = Infinity;
  for (let j = 0; j < n; j++) {
    const c = cands[j]!;
    if (work !== undefined) work.evals++;
    const cl = claims[j]!;
    if (cl > bestClaims) continue;
    if (salvageHaulable(c, haulMass, freeHold)) continue;
    const dx = c.x - mx, dy = c.y - my;
    const r = reach + c.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r) continue;
    if (cl === bestClaims) {
      const better = big ? c.mass > bestMass : c.mass < bestMass;
      if (!better && (c.mass !== bestMass || d2 >= bestD2)) continue;
    }
    best = j; bestClaims = cl; bestMass = c.mass; bestD2 = d2;
  }
  return best;
}
