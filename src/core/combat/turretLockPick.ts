/**
 * Which of its group's locks a turret aims at (fire control, capitals). A
 * capital weapon group can hold several locks; its turrets share them out
 * instead of all training on the first: turret `ordinal` (its place in the
 * group's mount list) prefers lock `ordinal % n`, and when that one is out of
 * its reach or arc it takes the next lock round the list it CAN engage. With
 * none engageable it parks on the first lock. One lock (every non-capital
 * group) is always index 0, so those groups aim exactly as before.
 *
 * Gun size first (owner 2026-11-14): among the locks it can engage, a turret
 * takes the class its size prefers (`mountPriority`: heavy guns capitals and
 * structures, AA small craft), the round-robin above deciding only among
 * equal-priority locks. The class comes from the lock's hit shape
 * (`kindId`: a ship kind, else a structure), which both sides already fill
 * identically, so no second input can disagree (#15).
 *
 * Reach is the shared turret range gate (`mountInReach`): from the mount to
 * the nearest point of the target's hit shape (`shapes[i]`), the same rule
 * `mountCanEngage` applies to NPC and structure turrets.
 *
 * Mining lasers (owner 2026-11-16): when the mount's weapon mines
 * (`isSalvageWeapon`) and the caller flags salvage locks (`lockFlags`, a
 * parallel array: `LOCK_SALVAGE` a wreck/rock piece, `LOCK_HAULABLE` one
 * this ship can already tow AND store), the group's mining lasers spread
 * over the cuttable pieces instead: lasers ranked big-first
 * (`salvagePrefersBig`, then slot order), pieces by radius descending,
 * laser rank r takes piece rank r % k among the pieces IT can engage (reach +
 * arc, as above; none: it parks on the first cuttable piece). Haulable pieces are left to the
 * tractors (a separate group); with every piece haulable the laser has no
 * aim (`TURRET_NO_LOCK`) and does not fire. A piece flagged `LOCK_CONSUMABLE`
 * (this ship can take it in whole, the factory line) is skipped by lasers AND
 * tractors: a tractor whose locks are all consumable has no aim either, so
 * its lease lapses and the loot pickup takes the piece in.
 *
 * Used by the server's turret aim + fire gate (`LockSubsystem.aimKeyFor`) and
 * the client's predicted aim + ghost gate (`ColyseusClient.fcMountAimKey`), so
 * both sides pick the same target (invariants #12, #15). Pure,
 * allocation-free.
 */
import { inMountArc, type FireControlMount } from './mountFireControl.js';
import { mountInReach, type MountRangeTarget } from './mountReach.js';
import { mountPriority, targetClassOfKind } from './mountTargeting.js';
import { isSalvageWeapon, salvagePrefersBig } from './salvageTargeting.js';
import { getWeapon } from './WeaponCatalogue.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';

/** `pickTurretLock` result: no lock to aim at (the caller's no-aim, so no fire). */
export const TURRET_NO_LOCK = -1;
/** `lockFlags` bit: the lock is a salvage piece (wreck piece, rock, rock piece). */
export const LOCK_SALVAGE = 1;
/** `lockFlags` bit: this ship can already tow AND store the piece (`salvageHaulable`). */
export const LOCK_HAULABLE = 2;
/** `lockFlags` bit: this ship can take the piece in whole (`salvageConsumable`):
 *  no laser and no tractor aims at it; the loot pickup takes it in. */
export const LOCK_CONSUMABLE = 4;
/** Most locks a caller hands `pickTurretLock` (the size of both sides'
 *  per-lock scratch; well above any group's lock capacity). */
export const TURRET_PICK_MAX = 8;

/** A group mount as the salvage share-out reads it. */
export type TurretGroupMount = { readonly weaponId: WeaponMount['weaponId']; readonly size?: WeaponMount['size'] };

/** Cuttable salvage lock indices, biggest first (module scratch, #14; grows
 *  only past its size, never at the 8-lock group cap). */
let salvageOrder = new Int32Array(TURRET_PICK_MAX);

/** Half-width (rad) a fixed gun (arcMin === arcMax) counts as covering. */
const FIXED_GUN_HALF_ARC = 0.3;

/** Can mount `m` engage a lock at offset (dx, dy): in reach and arc. A NaN
 *  offset (the caller has no pose for that lock) never can. */
function canEngage(
  m: FireControlMount, frameAngle: number, dx: number, dy: number, reach: number, shape: MountRangeTarget | undefined,
): boolean {
  if (dx !== dx || dy !== dy) return false;
  if (!mountInReach(dx, dy, reach, shape)) return false;
  if (m.arcMax - m.arcMin < 1e-6) {
    let rel = Math.atan2(-dx, dy) - frameAngle - m.baseAngle - m.arcMin;
    rel -= Math.round(rel / (2 * Math.PI)) * 2 * Math.PI;
    return Math.abs(rel) <= FIXED_GUN_HALF_ARC;
  }
  return inMountArc(m, frameAngle, dx, dy);
}

/**
 * Index (0..n-1) of the lock turret `ordinal` aims at. `mx`/`my` is the
 * mount's world origin, `frameAngle` the hull heading, `tx`/`ty` the world
 * positions of the group's `n` LOCKED targets in lock order, `shapes` their
 * hit shapes (absent = measured to the centre, and no class preference).
 * `lockFlags` (per lock, `LOCK_SALVAGE` | `LOCK_HAULABLE`) with `groupMounts`
 * (the group's mounts in slot order) turns on the mining-laser share-out;
 * absent, the pick is exactly as before. Returns `TURRET_NO_LOCK` only from
 * that share-out.
 */
export function pickTurretLock(
  m: FireControlMount & { readonly size?: WeaponMount['size'] },
  frameAngle: number,
  mx: number,
  my: number,
  reach: number,
  ordinal: number,
  n: number,
  tx: ArrayLike<number>,
  ty: ArrayLike<number>,
  shapes?: ArrayLike<MountRangeTarget>,
  lockFlags?: ArrayLike<number>,
  groupMounts?: ArrayLike<TurretGroupMount>,
): number {
  // Locks this mount may not aim at: a mining laser's salvage (it took the
  // share-out above), a tractor's consumable pieces (the ship takes those in).
  let skipBits = 0;
  if (lockFlags !== undefined && groupMounts !== undefined) {
    const def = getWeapon(groupMounts[ordinal]!.weaponId);
    if (isSalvageWeapon(def)) {
      const s = pickSalvageLock(m, frameAngle, mx, my, reach, ordinal, n, tx, ty, shapes, lockFlags, groupMounts);
      if (s !== SALVAGE_NOT_APPLICABLE) return s;
      skipBits = LOCK_SALVAGE;
    } else if (def.tractor !== undefined) {
      let open = 0;
      for (let i = 0; i < n; i++) if ((lockFlags[i]! & LOCK_CONSUMABLE) === 0) open++;
      if (open === 0) return TURRET_NO_LOCK;
      if (open < n) skipBits = LOCK_CONSUMABLE;
    }
  }
  const skipping = skipBits !== 0;
  if (n <= 1) return 0;
  const start = ordinal % n;
  let best = -1;
  let bestPri = Infinity;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (skipping && (lockFlags![i]! & skipBits) !== 0) continue;
    // Class first (cheap, cached per kind): skip a lock no better than the best.
    const pri = shapes === undefined ? 0 : mountPriority(m.size, targetClassOfKind(shapes[i]!.kindId));
    if (pri >= bestPri) continue;
    if (!canEngage(m, frameAngle, tx[i]! - mx, ty[i]! - my, reach, shapes?.[i])) continue;
    best = i;
    bestPri = pri;
    if (pri === 0) break;
  }
  if (best < 0 && skipping) {
    for (let i = 0; i < n; i++) if ((lockFlags![i]! & skipBits) === 0) return i;
  }
  return best < 0 ? 0 : best;
}

/** `pickSalvageLock`: no salvage lock at all, or only haulable pieces beside
 *  combat locks: the ordinary pick decides (over the non-salvage locks). */
const SALVAGE_NOT_APPLICABLE = -2;

/**
 * The mining-laser share-out. Whether it applies reads the lock flags alone
 * (the same on both sides of the wire, #15): no cuttable piece (salvage, not
 * haulable) means `TURRET_NO_LOCK` when every lock is a piece, else the
 * ordinary pick. Mount rank: the group's mining mounts, big
 * (`salvagePrefersBig`) before small, slot order within each. Lock rank: the
 * cuttable pieces THIS mount can engage (`canEngage`, the ordinary pick's
 * reach + arc test) by `Math.fround(shapes[i].radius)` descending (ties by
 * lock order; float32 so both sides' radii rank alike).
 * Mount rank r takes lock rank r % k; with none engageable the laser parks
 * on the first cuttable piece, as the ordinary pick parks on the first lock.
 * Linear in the group's mounts, an insertion sort over its few (at most 8)
 * locks; no allocation.
 */
function pickSalvageLock(
  m: FireControlMount, frameAngle: number, mx: number, my: number, reach: number,
  ordinal: number, n: number, tx: ArrayLike<number>, ty: ArrayLike<number>,
  shapes: ArrayLike<MountRangeTarget> | undefined, lockFlags: ArrayLike<number>, groupMounts: ArrayLike<TurretGroupMount>,
): number {
  if (salvageOrder.length < n) salvageOrder = new Int32Array(n);
  const order = salvageOrder;
  let k = 0;
  let pieces = 0;
  let firstCut = -1;
  for (let i = 0; i < n; i++) {
    const f = lockFlags[i]!;
    if ((f & LOCK_SALVAGE) === 0) continue;
    pieces++;
    if ((f & (LOCK_HAULABLE | LOCK_CONSUMABLE)) !== 0) continue;
    if (firstCut < 0) firstCut = i;
    if (!canEngage(m, frameAngle, tx[i]! - mx, ty[i]! - my, reach, shapes?.[i])) continue;
    // Insertion by float32 radius, descending; equal radii keep lock order.
    // float32: the server's float64 radius and the client's wire radius rank alike (#15).
    const r = Math.fround(shapes?.[i]?.radius ?? 0);
    let p = k++;
    while (p > 0 && Math.fround(shapes?.[order[p - 1]!]?.radius ?? 0) < r) { order[p] = order[p - 1]!; p--; }
    order[p] = i;
  }
  if (firstCut < 0) return pieces > 0 && pieces === n ? TURRET_NO_LOCK : SALVAGE_NOT_APPLICABLE;
  if (k === 0) return firstCut;
  const big = salvagePrefersBig(groupMounts[ordinal]!.size);
  let rank = 0;
  for (let j = 0; j < groupMounts.length; j++) {
    if (j === ordinal) continue;
    const gm = groupMounts[j]!;
    if (!isSalvageWeapon(getWeapon(gm.weaponId))) continue;
    const gBig = salvagePrefersBig(gm.size);
    if ((gBig && !big) || (gBig === big && j < ordinal)) rank++;
  }
  return order[rank % k]!;
}
