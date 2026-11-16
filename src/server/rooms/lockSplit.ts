/**
 * Locks follow a target's pieces (plan partitioned-chasing-lark): a locked
 * rock or wreck piece that breaks hands each lock held ON it to its pieces,
 * biggest first, so every mining-laser mount keeps working and the lasers
 * spread over the pieces. Same lineage, so a LOCKED target's pieces are
 * LOCKED at once (stage, progress, track and salvage bits copied; the lock
 * step refreshes the bits). Not a hostile act: no ledger, no standing.
 * Runs only on a break, never per tick.
 */
import { newLock, type LockEntry } from '../../core/combat/lockState.js';

/** Re-key one group's lock on `fromKey` to the first piece key it does not
 *  already lock, then add locks on the next ones up to its `capacity`. A
 *  group already locking every piece just drops the old lock. True when the
 *  group changed (the caller re-syncs its wire). */
export function splitGroupLocks(
  g: { capacity: number; locks: LockEntry[] }, fromKey: string, pieceKeys: ReadonlyArray<string>,
): boolean {
  let src: LockEntry | undefined;
  for (const e of g.locks) if (e.target === fromKey) { src = e; break; }
  if (src === undefined) return false;
  let moved = false;
  for (const key of pieceKeys) {
    let held = false;
    for (const e of g.locks) if (e.target === key) { held = true; break; }
    if (held) continue;
    if (!moved) { src.target = key; moved = true; continue; }
    if (g.locks.length >= g.capacity) break;
    const e = newLock(key, true, src.track);
    e.stage = src.stage; e.progress = src.progress; e.lostFor = src.lostFor; e.auto = src.auto; e.flags = src.flags;
    g.locks.push(e);
  }
  if (!moved) g.locks.splice(g.locks.indexOf(src), 1);
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
