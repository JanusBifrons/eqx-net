/**
 * Locks follow a target's pieces (plan partitioned-chasing-lark): a locked
 * rock or wreck piece that breaks hands each lock held ON it to its pieces,
 * biggest first, so every mining-laser mount keeps working and the lasers
 * spread over the pieces. Same lineage, so a LOCKED target's pieces are
 * LOCKED at once (stage, progress, track and salvage bits copied; the lock
 * step refreshes the bits). A pod is never a lineage member: a piece worn
 * into a pod leaves, and its locks move on like any other leaving piece
 * (cargo pods, owner 2026-11-17: no weapon works a pod; a tractor moves one
 * only on its own lock). Not a hostile act: no ledger, no standing.
 * Runs only on a break, never per tick.
 *
 * A lock ends only with its lineage (`lineageRekey`): while any piece of the
 * locked rock or wreck is alive, a lock whose piece leaves (worn into a
 * pod, taken in, or gone) or that it can't track moves on to another live member
 * the group does not hold yet, one a mount of the group can work first; a
 * group with nothing it may work idles on the lineage. After every break a
 * salvage group's lineage lock it can't work moves to a free member it can
 * (`rekeyUnworkable`): the pieces are handed out biggest first, so without
 * it a tractor group held the uncut pieces too heavy to pull while the
 * haulable ones went unheld (barge-mining take, 2026-11-17).
 */
import { LOCK_TRACK, newLock, type LockEntry } from '../../core/combat/lockState.js';
import { groupWorksSalvage, lockTierOf, type TurretGroupMount } from '../../core/combat/turretLockPick.js';
import { isSalvageWeapon } from '../../core/combat/salvageTargeting.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { lockSalvageFlags, refreshLockSalvage, type LockSalvageDeps } from './lockSalvage.js';
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';

/** A weapon group as the lineage hand-over sees it. */
export interface LineageGroup {
  capacity: number;
  locks: LockEntry[];
  /** The group's mounts in slot order (what it can work: `groupWorksSalvage`). */
  mounts: ReadonlyArray<TurretGroupMount>;
}

/** Who holds the group, for the members' salvage bits (`lockSalvageFlags`). */
export interface LineageCtx {
  d: LockSalvageDeps;
  ship: { kind: ShipKind; activated: ReadonlyArray<WeaponMount> } | null;
  playerId: string;
}

/** The one reused member list of `lineageRekey` (#14). */
const MEMBERS: string[] = [];

/** A member's rank for group `g`: one a mount of it can work first, then the bigger size tier. */
function memberRank(g: LineageGroup, flags: number): number {
  return (groupWorksSalvage(g.mounts, flags) ? 8 : 0) + lockTierOf(flags);
}

function holds(g: { locks: LockEntry[] }, key: string): boolean {
  for (const e of g.locks) if (e.target === key) return true;
  return false;
}

/**
 * Lock `e` of group `g` is losing its target `e.target`: it left (`keep`
 * false) or the group can't track it (`keep`: it stays unless a better
 * member is free). Re-key it to the live member of its lineage the group
 * does not hold that ranks highest: workable by a mount of the group
 * (`groupWorksSalvage`) first, then the bigger size tier (stage, progress
 * and track kept: same lineage). True when the lock lives on (re-keyed, or
 * kept idle on the lineage); false when it should end: not a lineage lock,
 * a released lock line still draining, or no member left. Runs only when a
 * target leaves or can't be tracked, never per steady tick.
 */
export function lineageRekey(
  d: LockSalvageDeps, ship: LineageCtx['ship'], playerId: string, g: LineageGroup, e: LockEntry, keep = false,
): boolean {
  const src = d.lineage;
  if (src === undefined || (e.track === LOCK_TRACK.released && e.stage !== 'locked')) return false;
  const root = e.root >= 0 ? e.root : src.rootOf(e.target);
  if (root < 0) return false;
  MEMBERS.length = 0;
  src.keysOf(root, MEMBERS);
  let best: string | null = null;
  let bestRank = keep ? memberRank(g, e.flags) : -1;
  for (const key of MEMBERS) {
    if (key === e.target || holds(g, key)) continue;
    const r = memberRank(g, lockSalvageFlags(d, ship, playerId, key));
    if (r > bestRank) { best = key; bestRank = r; }
  }
  if (best === null && !keep) return false;
  if (best !== null) e.target = best;
  e.root = root;
  e.lostFor = 0;
  return true;
}

/** Does group `g` carry a mining laser or a tractor (a salvage group)? */
function salvageGroup(g: LineageGroup): boolean {
  for (let i = 0; i < g.mounts.length; i++) {
    const w = getWeapon(g.mounts[i]!.weaponId);
    if (isSalvageWeapon(w) || w.tractor !== undefined) return true;
  }
  return false;
}

/**
 * After a break: each lineage lock of salvage group `g` that no mount of it
 * can work (bits refreshed now) moves to the free member of its lineage it
 * can (`lineageRekey` with `keep`: it stays when none is free). True when
 * a lock moved (the caller re-syncs its wire). Runs only on a break.
 */
export function rekeyUnworkable(g: LineageGroup, c: LineageCtx): boolean {
  if (c.d.lineage === undefined || !salvageGroup(g)) return false;
  let moved = false;
  for (const e of g.locks) {
    refreshLockSalvage(c.d, c.ship, c.playerId, e);
    if (e.root < 0 || e.flags === 0 || groupWorksSalvage(g.mounts, e.flags)) continue;
    const was = e.target;
    if (lineageRekey(c.d, c.ship, c.playerId, g, e, true) && e.target !== was) {
      refreshLockSalvage(c.d, c.ship, c.playerId, e);
      moved = true;
    }
  }
  return moved;
}

/** Re-key one group's lock on `fromKey` to the first of the first `count`
 *  piece keys it does not already lock, then add locks on the next ones up
 *  to its `capacity`. A group already locking every one (or given none)
 *  hands the old lock to another live member of its lineage
 *  (`lineageRekey`, with `c`), else drops it. True when the group changed
 *  (the caller re-syncs its wire). */
export function splitGroupLocks(
  g: LineageGroup, fromKey: string, pieceKeys: ReadonlyArray<string>, count = pieceKeys.length, c?: LineageCtx,
): boolean {
  let src: LockEntry | undefined;
  for (const e of g.locks) if (e.target === fromKey) { src = e; break; }
  if (src === undefined) return false;
  let moved = false;
  for (let i = 0; i < count; i++) {
    const key = pieceKeys[i]!;
    let held = false;
    for (const e of g.locks) if (e.target === key) { held = true; break; }
    if (held) continue;
    if (!moved) { src.target = key; moved = true; continue; }
    if (g.locks.length >= g.capacity) break;
    const e = newLock(key, true, src.track);
    e.stage = src.stage; e.progress = src.progress; e.lostFor = src.lostFor; e.auto = src.auto; e.flags = src.flags; e.root = src.root;
    g.locks.push(e);
  }
  if (!moved && (c === undefined || !lineageRekey(c.d, c.ship, c.playerId, g, src))) g.locks.splice(g.locks.indexOf(src), 1);
  return true;
}

/** The one reused key list and index order of `relayPieceSplit` (#14). */
const KEYS: string[] = [];
const ORDER: number[] = [];

/**
 * SectorRoom's `CapitalWreckDeps.pieceSplit`: map the parent and its piece
 * ids (parallel `masses`) to swarm lock keys (`s:<entityId>`), biggest piece
 * first, and hand them to every lock machine (`targetSplit`). Ids not in the
 * registry are skipped.
 */
export function relayPieceSplit(
  reg: { get(id: string): { entityId: number } | null | undefined },
  parentId: string, ids: ReadonlyArray<string>, masses: ReadonlyArray<number>,
  a: { targetSplit(from: string, keys: ReadonlyArray<string>): void },
  b: { targetSplit(from: string, keys: ReadonlyArray<string>): void } | undefined,
): void {
  const parent = reg.get(parentId);
  if (parent == null) return;
  ORDER.length = 0;
  for (let i = 0; i < ids.length; i++) {
    let j = ORDER.length;
    while (j > 0 && (masses[ORDER[j - 1]!] ?? 0) < (masses[i] ?? 0)) j--;
    ORDER.splice(j, 0, i);
  }
  KEYS.length = 0;
  for (const i of ORDER) {
    const rec = reg.get(ids[i]!);
    if (rec != null) KEYS.push(`s:${rec.entityId}`);
  }
  if (KEYS.length === 0) return;
  const from = `s:${parent.entityId}`;
  a.targetSplit(from, KEYS);
  if (b !== undefined && b !== a) b.targetSplit(from, KEYS);
}
