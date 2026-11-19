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
 * Mining lasers and tractors (owner 2026-11-16, the SIZE LADDER): when the
 * mount mines (`isSalvageWeapon`) or tractors and the caller flags salvage
 * locks (`lockFlags`, a parallel array: `LOCK_SALVAGE` a wreck/rock piece or an ore pod (tier AA),
 * its size tier in `LOCK_TIER_MASK` (`salvageTier`, ship-independent),
 * `LOCK_CONSUMABLE` one this ship can take in whole), the group's mounts of
 * that tool spread over the pieces their SIZE may work: only the matching
 * size fires, a laser on rung k only pieces of tier k + 1, XL tier none, with
 * the next smaller laser size in the group standing in for a missing one
 * (`laserCutsTier` over `laserRungMask(groupMounts)`),
 * a tractor on rung k only pieces at or below k (`tractorTakesTier`, its
 * pull limit), never a consumable one; a `LOCK_HAUL` rock piece no laser cuts. Pieces rank by radius descending
 * among those the mount can engage (reach + arc, as above; none: it parks on
 * the first workable piece). Big-preferring lasers (`salvagePrefersBig`) and
 * all tractors take from the big end, rank r → piece r % k; small lasers
 * from the small end. Rank: lasers among the same preference in slot order; tractors among
 * same-size tractors in slot order. With no workable piece and every lock a
 * piece, the mount has no aim (`TURRET_NO_LOCK`) and does not fire (a
 * tractor's lease lapses: the loot pickup takes a consumable piece in).
 *
 * Used by the server's turret aim + fire gate (`LockSubsystem.aimKeyFor`) and
 * the client's predicted aim + ghost gate (`ColyseusClient.fcMountAimKey`), so
 * both sides pick the same target (invariants #12, #15). Pure,
 * allocation-free.
 */
import { inMountArc, type FireControlMount } from './mountFireControl.js';
import { mountInReach, type MountRangeTarget } from './mountReach.js';
import { mountPriority, targetClassOfKind } from './mountTargeting.js';
import { isSalvageWeapon, laserCutsTier, laserRungMask, mountTier, salvagePrefersBig, tractorTakesTier } from './salvageTargeting.js';
import { getWeapon } from './WeaponCatalogue.js';
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';

/** `pickTurretLock` result: no lock to aim at (the caller's no-aim, so no fire). */
export const TURRET_NO_LOCK = -1;
/** `lockFlags` bit: the lock is a salvage piece (wreck piece, rock, rock piece). */
export const LOCK_SALVAGE = 1;
/** `lockFlags` bit: a ROCK piece this ship hauls in whole (`rockHaulable`):
 *  no laser cuts it; the tractors still pull it to the hull. */
export const LOCK_HAUL = 2;
/** `lockFlags` bit: this ship can take the piece in whole (`salvageConsumable`):
 *  no laser and no tractor aims at it; the loot pickup takes it in. */
export const LOCK_CONSUMABLE = 4;
/** `lockFlags` bits 3..5: the piece's size tier (`salvageTier`: 0 none,
 *  1 AA … 5 XL). */
export const LOCK_TIER_SHIFT = 3;
export const LOCK_TIER_MASK = 7 << LOCK_TIER_SHIFT;
/** The tier bits of a salvage lock. */
export function lockTierBits(tier: number): number {
  return (tier << LOCK_TIER_SHIFT) & LOCK_TIER_MASK;
}
/** The size tier a lock's flags carry. */
export function lockTierOf(flags: number): number {
  return (flags & LOCK_TIER_MASK) >> LOCK_TIER_SHIFT;
}
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
 * `lockFlags` (per lock, `LOCK_SALVAGE` | tier bits | `LOCK_CONSUMABLE`) with
 * `groupMounts` (the group's mounts in slot order) turns on the salvage share-out;
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
  // Locks this mount may not aim at: a mining laser's or tractor's salvage
  // (it took the share-out above).
  let skipBits = 0;
  if (lockFlags !== undefined && groupMounts !== undefined) {
    const def = getWeapon(groupMounts[ordinal]!.weaponId);
    const laser = isSalvageWeapon(def);
    if (laser || def.tractor !== undefined) {
      const s = pickSalvageLock(m, frameAngle, mx, my, reach, ordinal, n, tx, ty, shapes, lockFlags, groupMounts, laser);
      if (s !== SALVAGE_NOT_APPLICABLE) return s;
      skipBits = LOCK_SALVAGE;
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

/** `pickSalvageLock`: no salvage lock at all, or no piece this mount may work
 *  beside combat locks: the ordinary pick decides (over the non-salvage locks). */
const SALVAGE_NOT_APPLICABLE = -2;

/**
 * The salvage share-out (mining lasers, `laser`; tractors otherwise).
 * Whether it applies reads the lock flags alone (the same on both sides of
 * the wire, #15): no piece this mount may work (salvage, not consumable, its
 * tier on this mount's side of the ladder) means `TURRET_NO_LOCK` when every
 * lock is a piece, else the ordinary pick. Lock rank: the workable pieces
 * THIS mount can engage (`canEngage`, the ordinary pick's reach + arc test)
 * by `Math.fround(shapes[i].radius)` descending (ties by lock order; float32
 * so both sides' radii rank alike). Mount rank r (`peerRank`) takes lock
 * rank r % k from the big end, or from the small end for a small laser;
 * with none engageable the mount parks on the first workable piece, as the
 * ordinary pick parks on the first lock. Linear in the group's mounts, an
 * insertion sort over its few (at most 8) locks; no allocation.
 */
function pickSalvageLock(
  m: FireControlMount, frameAngle: number, mx: number, my: number, reach: number,
  ordinal: number, n: number, tx: ArrayLike<number>, ty: ArrayLike<number>,
  shapes: ArrayLike<MountRangeTarget> | undefined, lockFlags: ArrayLike<number>, groupMounts: ArrayLike<TurretGroupMount>,
  laser: boolean,
): number {
  if (salvageOrder.length < n) salvageOrder = new Int32Array(n);
  const order = salvageOrder;
  const size = groupMounts[ordinal]!.size;
  const rung = mountTier(size);
  const rungs = laser ? laserRungMask(groupMounts) : 0;
  let k = 0;
  let pieces = 0;
  let firstCut = -1;
  for (let i = 0; i < n; i++) {
    const f = lockFlags[i]!;
    if ((f & LOCK_SALVAGE) === 0) continue;
    pieces++;
    if (!mountWorks(laser, rung, rungs, f)) continue;
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
  const r = peerRank(groupMounts, ordinal, laser) % k;
  return order[!laser || salvagePrefersBig(size) ? r : k - 1 - r]!;
}

/** Does a mining laser (`laser`, on rung `rung` of its group's laser
 *  `rungs`) or a tractor on rung `rung` work a salvage lock with bits `f`:
 *  not consumable, its tier on this mount's side of the size ladder. */
function mountWorks(laser: boolean, rung: number, rungs: number, f: number): boolean {
  if ((f & LOCK_SALVAGE) === 0 || (f & LOCK_CONSUMABLE) !== 0) return false;
  const tier = lockTierOf(f);
  if (laser) return (f & LOCK_HAUL) === 0 && laserCutsTier(rung, tier, rungs);
  return tractorTakesTier(rung, tier);
}

/** Does some mining laser or tractor of `groupMounts` (a group's mounts)
 *  work a salvage lock with bits `flags` (the share-out's own test)? The
 *  server's lineage hand-over (lockSplit.ts) re-keys a lock to a piece its
 *  group can work first. Allocates nothing. */
export function groupWorksSalvage(groupMounts: ArrayLike<TurretGroupMount>, flags: number): boolean {
  const rungs = laserRungMask(groupMounts);
  for (let j = 0; j < groupMounts.length; j++) {
    const def = getWeapon(groupMounts[j]!.weaponId);
    const laser = isSalvageWeapon(def);
    if ((laser || def.tractor !== undefined) && mountWorks(laser, mountTier(groupMounts[j]!.size), rungs, flags)) return true;
  }
  return false;
}

/** Mount `ordinal`'s rank among its group's peers of the same tool: lasers
 *  with the same big/small preference (`salvagePrefersBig`: each end of the
 *  piece list is shared out on its own), slot order; a
 *  tractor among the same-size tractors (each size has its own piece set),
 *  slot order. */
function peerRank(groupMounts: ArrayLike<TurretGroupMount>, ordinal: number, laser: boolean): number {
  const size = groupMounts[ordinal]!.size;
  const big = salvagePrefersBig(size);
  const rung = mountTier(size);
  let rank = 0;
  for (let j = 0; j < groupMounts.length; j++) {
    if (j === ordinal) continue;
    const gm = groupMounts[j]!;
    const def = getWeapon(gm.weaponId);
    if (laser) {
      if (!isSalvageWeapon(def)) continue;
      if (salvagePrefersBig(gm.size) === big && j < ordinal) rank++;
    } else if (def.tractor !== undefined && mountTier(gm.size) === rung && j < ordinal) rank++;
  }
  return rank;
}
