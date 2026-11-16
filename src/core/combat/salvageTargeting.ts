/**
 * SALVAGE rules for mining mounts (salvage plan partitioned-chasing-lark
 * PR 16; owner's "smart mining lasers" rule, 2026-11-16). Pure (#14).
 *
 * A mount whose weapon MINES (`isSalvageWeapon`: a 'rock' target factor
 * above 0, the mining laser) aims at the salvage pieces its group LOCKED
 * (wreck pieces, rocks, rock pieces; class `SALVAGE_TARGET_CLASS`). Which
 * piece each mount takes is the group share-out `pickTurretLock`
 * (`turretLockPick.ts`), by the SIZE LADDER (owner 2026-11-16): every piece
 * has a size TIER (`salvageTier`), the rung of the smallest mount size whose
 * tractor can pull it: its mass is at most `salvageTierMass(size)` = the
 * catalogue's strongest tractor at that size (force × the size's `power`,
 * its own falloff `tractorPull`) at `SALVAGE_HAUL_DIST_PER_DREF` × dRef,
 * over `SALVAGE_HAUL_MIN_ACCEL` (accel = F / m). `SALVAGE_TIER_NONE` (0) =
 * too big for any tractor. The tier depends only on the piece's mass and
 * the catalogue, never on the ship. A mining laser on rung k cuts only
 * pieces ABOVE k (`laserCutsTier`: a tractor of its size can take the
 * rest); a tractor on rung k pulls only pieces at or below k
 * (`tractorTakesTier`). So XL/L lasers slice the huge rocks, the L tractors
 * pull L-tier pieces in to the M lasers, and so on down to the small lasers,
 * which cut to hold size. The big/small split: `salvagePrefersBig`.
 *
 * **Consumable by me** (owner 2026-11-16, the factory line): a piece small
 * enough for THIS ship to take in whole: its bounding radius is at most
 * `SALVAGE_CONSUME_FRAC` × the ship's hull radius (`salvageConsumeRadius`;
 * 0 for a ship with no mining tool, which consumes nothing) AND its hold
 * weight fits the free hold (`salvageConsumable`). Nothing targets a
 * consumable piece (no laser, no tractor: `LOCK_CONSUMABLE`); the ship takes
 * it in by proximity through the loot pickup (`LootSubsystem`).
 */
import type { WeaponMount } from '../../shared-types/shipKinds/types.js';
import { MOUNT_SIZE_TUNING, type MountSize } from '../../shared-types/shipScale/tuning.js';
import { WEAPON_IDS, getWeapon, weaponTargetFactor, type WeaponDef } from './WeaponCatalogue.js';
import { weaponIdReach } from './mountReach.js';
import { tractorPull } from './tractorSpec.js';
import { SALVAGE_TARGET_CLASS } from './mountTargeting.js';

export { SALVAGE_TARGET_CLASS };

/** A tractor is judged able to pull a piece when it can accelerate it at
 *  least this much (u/s²) at the haul distance. 10 u/s² brings a piece in
 *  from 500 u in about 10 s; the tractor record's own example ("a 2,000-mass
 *  one at 3 u/s²") is the "barely moves" case this rules out. */
export const SALVAGE_HAUL_MIN_ACCEL = 10;

/** The haul distance, in multiples of the tractor's `dRef`: a piece just
 *  outside the cushion being drawn in, where the inverse-square falloff has
 *  already cut the pull to a quarter. Judging at full force (≤ dRef) would
 *  call pieces pullable that the beam can't start moving from range. */
export const SALVAGE_HAUL_DIST_PER_DREF = 2;

/** A piece is small enough to consume when its bounding radius is at most
 *  this share of the ship's hull radius: a fighter (r 24) consumes nothing
 *  over 3.6 u, a destroyer (r 1,220) a 183 u piece (fighter debris), a
 *  battleship (r 2,876) a 431 u one. Big ships eat the small end of the line. */
export const SALVAGE_CONSUME_FRAC = 0.15;

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

/** Does this weapon mine (and so pick salvage, not hostiles)? Data-driven:
 *  only a weapon naming a 'rock' factor mines (`weaponTargetFactor`). */
export function isSalvageWeapon(def: WeaponDef): boolean {
  return weaponTargetFactor(def, 'rock') > 0;
}

/** Heavy mounts take big pieces, light ones small (mountPriority's split). */
export function salvagePrefersBig(size: WeaponMount['size']): boolean {
  return size === 'M' || size === 'L' || size === 'XL';
}

/** Mount sizes in ladder order: a size's RUNG (`mountTier`) is its index + 1. */
export const SALVAGE_TIER_SIZES: readonly MountSize[] = ['AA', 'S', 'M', 'L', 'XL'];
/** `salvageTier` of a piece too big for any tractor (and of a field rock,
 *  mass Infinity): every mining laser may cut it, no tractor pulls it. */
export const SALVAGE_TIER_NONE = 0;
/** The top rung (XL). */
export const SALVAGE_TIER_MAX = 5;

/** Heaviest pullable mass per rung (index = rung; [0] unused). Built once
 *  from the catalogue. */
let tierMass: Float64Array | null = null;

function tierMasses(): Float64Array {
  if (tierMass !== null) return tierMass;
  const out = new Float64Array(SALVAGE_TIER_MAX + 1);
  for (let t = 1; t <= SALVAGE_TIER_MAX; t++) {
    const size = SALVAGE_TIER_SIZES[t - 1]!;
    const power = MOUNT_SIZE_TUNING[size].power;
    let force = 0;
    for (const id of WEAPON_IDS) {
      const def = getWeapon(id);
      const tr = def.tractor;
      if (tr === undefined) continue;
      // The beam's own reach at this size (`weaponIdReach`, as `renewTractor`
      // sets it). The haul distance (2 × dRef = 500 u) sits far inside every
      // size's reach (AA ≈ 1,091 u), so the range gradient leaves the tiers as they were.
      const pull = tractorPull(tr.force * power, tr.dRef, weaponIdReach(id, size), SALVAGE_HAUL_DIST_PER_DREF * tr.dRef);
      if (pull > force) force = pull;
    }
    out[t] = force / SALVAGE_HAUL_MIN_ACCEL;
  }
  tierMass = out;
  return out;
}

/** The heaviest piece a tractor of mount size `size` can pull: the
 *  catalogue's strongest tractor at that size (force × `power`) at the haul
 *  distance, over `SALVAGE_HAUL_MIN_ACCEL` (AA 60, S 150, M 375, L 900,
 *  XL 2,250 with today's tractor). */
export function salvageTierMass(size: MountSize): number {
  return tierMasses()[mountTier(size)]!;
}

/** A piece's size TIER: the rung (1 AA … 5 XL) of the smallest mount size
 *  whose tractor can pull a body of `mass`, or `SALVAGE_TIER_NONE` (0) when
 *  none can (also NaN / Infinity). Ship-independent. Pure, allocation-free. */
export function salvageTier(mass: number): number {
  const lim = tierMasses();
  for (let t = 1; t <= SALVAGE_TIER_MAX; t++) if (mass <= lim[t]!) return t;
  return SALVAGE_TIER_NONE;
}

/** A mount's rung on the ladder: 1 AA … 5 XL; unsized counts as S (the
 *  tractor's own `size ?? 'S'` power rule). */
export function mountTier(size: WeaponMount['size']): number {
  switch (size) {
    case 'AA': return 1;
    case 'M': return 3;
    case 'L': return 4;
    case 'XL': return 5;
    default: return 2;
  }
}

/** Does a mining laser on rung `rung` cut a piece of tier `tier`? Only a
 *  piece above its rung: a tractor of its own size can take the rest. */
export function laserCutsTier(rung: number, tier: number): boolean {
  return tier === SALVAGE_TIER_NONE || tier > rung;
}

/** Does a tractor on rung `rung` pull a piece of tier `tier`? Only one at or
 *  below its rung (its pull limit). */
export function tractorTakesTier(rung: number, tier: number): boolean {
  return tier !== SALVAGE_TIER_NONE && tier <= rung;
}

const toolCache = new WeakMap<ReadonlyArray<WeaponMount>, boolean>();

/** Does this mount list carry a mining tool (a mining laser or a tractor)?
 *  Cached per mount list. */
export function hasMiningTool(mounts: ReadonlyArray<WeaponMount>): boolean {
  const hit = toolCache.get(mounts);
  if (hit !== undefined) return hit;
  let yes = false;
  for (const m of mounts) {
    const def = getWeapon(m.weaponId);
    if (def.tractor !== undefined || isSalvageWeapon(def)) { yes = true; break; }
  }
  toolCache.set(mounts, yes);
  return yes;
}

/** The biggest piece radius this ship consumes: `SALVAGE_CONSUME_FRAC` × its
 *  hull radius, or 0 with no mining tool among its kind's mounts (a ship
 *  with no mining tools behaves as before: it never takes a piece in). */
export function salvageConsumeRadius(kind: { readonly radius: number; readonly mounts?: ReadonlyArray<WeaponMount> }): number {
  return kind.mounts !== undefined && hasMiningTool(kind.mounts) ? SALVAGE_CONSUME_FRAC * kind.radius : 0;
}

/** Can this ship take `c` in whole: small enough (`consumeRadius`, from
 *  `salvageConsumeRadius`) AND its hold weight fits the free hold? Then
 *  nothing targets it and the loot pickup takes it in. */
export function salvageConsumable(c: Pick<SalvageCandidate, 'radius' | 'holdWeight'>, consumeRadius: number, freeHold: number): boolean {
  return consumeRadius > 0 && c.radius <= consumeRadius && c.holdWeight <= freeHold;
}
