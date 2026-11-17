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
 * the catalogue, never on the ship. Only the MATCHING size fires (owner
 * 2026-11-16): a mining laser on rung k cuts only pieces of tier k + 1, the
 * XL laser the pieces of tier none (`laserCutsTier`); with no laser of the
 * needed size in the group (`laserRungMask`), the next smaller size it has
 * takes them (the barge has no S laser: its AA lasers cut the M-tier
 * pieces). A tractor on rung k pulls only pieces at or below k
 * (`tractorTakesTier`). Nothing cuts an AA-tier piece. A rock piece of any
 * size goes into a hold whole as one rock chunk when it touches the hull
 * and its weight fits (`rockChunkWeight`; owner 2026-11-17: mined rock is
 * never a pod). The big/small split: `salvagePrefersBig`.
 *
 * **Consumable by me** (owner 2026-11-16, the factory line): a WRECK piece at hold
 * size, the SMALLEST tier (AA: an AA tractor could pull it), the same on every
 * ship (`salvageConsumeMass`: the AA tier's mass; 0 for a ship with no mining
 * tool, which consumes nothing), AND its hold weight fits the free hold
 * (`salvageConsumable`). So every ship works the whole ladder down to AA. Nothing targets a
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
 *  mass Infinity): only an XL laser cuts it (the matching size), no tractor pulls it. */
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
export function laserCutsTier(rung: number, tier: number, rungs: number): boolean {
  let need = tier === SALVAGE_TIER_NONE ? SALVAGE_TIER_MAX : tier - 1;
  while (need >= 1 && (rungs & (1 << need)) === 0) need--;
  return need >= 1 && need === rung;
}

const rungCache = new WeakMap<object, number>();

/** Bit `1 << rung` per mining-laser size among `mounts` (a group's mounts):
 *  the sizes `laserCutsTier` falls back over. Cached per mount list (the
 *  server's and client's group lists are built once per kind), so the
 *  share-out allocates nothing per tick (#14). */
export function laserRungMask(mounts: ArrayLike<{ readonly weaponId: WeaponMount['weaponId']; readonly size?: WeaponMount['size'] }>): number {
  const hit = rungCache.get(mounts);
  if (hit !== undefined) return hit;
  let mask = 0;
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]!;
    if (isSalvageWeapon(getWeapon(m.weaponId))) mask |= 1 << mountTier(m.size);
  }
  rungCache.set(mounts, mask);
  return mask;
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

/** The heaviest piece this ship takes in whole (hold size): the smallest
 *  tier's mass (`salvageTierMass('AA')`), the same on every ship (owner
 *  2026-11-16), or 0 with no mining tool among its kind's mounts (a ship with
 *  no mining tools behaves as before: it never takes a piece in). */
export function salvageConsumeMass(kind: { readonly mounts?: ReadonlyArray<WeaponMount> }): number {
  return kind.mounts !== undefined && hasMiningTool(kind.mounts) ? tierMasses()[1]! : 0;
}

/** Can this ship take `c` in whole? A WRECK piece: at hold size (mass ≤
 *  `consumeMass`, from `salvageConsumeMass`: the AA tier) and its hold
 *  weight fits the free hold. A ROCK piece (`ore` set) goes in as a chunk
 *  of any size: only its weight (`rockChunkWeight`) must fit (owner
 *  2026-11-17: weight is the only limit). Either way the ship needs a mining
 *  tool (`consumeMass > 0`). Then nothing targets it and the loot pickup
 *  takes it in when it touches the hull. */
export function salvageConsumable(
  c: Pick<SalvageCandidate, 'mass' | 'holdWeight'> & { readonly ore?: unknown }, consumeMass: number, freeHold: number,
): boolean {
  if (!(consumeMass > 0) || !(c.holdWeight <= freeHold)) return false;
  return c.ore !== undefined || c.mass <= consumeMass;
}

/** The lightest rock chunk (owner 2026-11-17: a scout carries 1, a fighter 2). */
export const ROCK_CHUNK_MIN_WEIGHT = 250;

/** A cut rock piece's cargo weight as a chunk: `ROCK_CHUNK_MIN_WEIGHT` per
 *  AA-tier mass of body (the smallest tractor's load), never under the
 *  minimum, so a chunk an S tractor drags weighs about 4× one an AA drags.
 *  Pure, allocation-free. */
export function rockChunkWeight(mass: number): number {
  const aa = tierMasses()[1]!;
  return Math.max(ROCK_CHUNK_MIN_WEIGHT, Math.round((ROCK_CHUNK_MIN_WEIGHT * Math.max(0, mass)) / aa));
}
