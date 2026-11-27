/**
 * Roster sealing (docs/features/sandbox.md): a sealed sector's roster rows
 * never cross into the real game and real rows never cross into it. Every
 * check goes through the one predicate, `isSealedSectorKey`.
 *
 * Join-time / boot-time only (allocation is fine here; never on a tick).
 */

import { isSealedSectorKey } from './sealedSectors.js';
import { fittedUid } from '../../shared-types/blueprints.js';

/** May a roster row last seen in `rowSectorKey` be flown in the room whose
 *  sector is `roomSectorKey`? A sealed room takes only its own rows; a real
 *  room takes any row that is not sealed. */
export function rosterRowFitsRoom(rowSectorKey: string | null, roomSectorKey: string): boolean {
  if (isSealedSectorKey(roomSectorKey)) return rowSectorKey === roomSectorKey;
  return !isSealedSectorKey(rowSectorKey);
}

/** The most recently updated row the room may resume (reuse-recent), or null. */
export function pickResumableRow<R extends { lastSectorKey: string; updatedAt: number }>(
  rows: readonly R[],
  roomSectorKey: string,
): R | null {
  let best: R | null = null;
  for (const r of rows) {
    if (!rosterRowFitsRoom(r.lastSectorKey, roomSectorKey)) continue;
    if (best === null || r.updatedAt > best.updatedAt) best = r;
  }
  return best;
}

/** Rows that real-game UI and reads may see (sealed rows filtered out). */
export function unsealedRows<R extends { lastSectorKey: string }>(rows: readonly R[]): R[] {
  return rows.filter((r) => !isSealedSectorKey(r.lastSectorKey));
}

/** The ship list a pilot sees (`/hangar/ships`). In a sealed room (`viewSectorKey`
 *  sealed: the client passes its room's sector) only that room's own rows, so the
 *  sandbox lists its ships and nothing else; anywhere else (any other key, or
 *  none) the real rows only. */
export function rosterRowsForView<R extends { lastSectorKey: string }>(rows: readonly R[], viewSectorKey: string | null): R[] {
  if (viewSectorKey !== null && isSealedSectorKey(viewSectorKey)) return rows.filter((r) => r.lastSectorKey === viewSectorKey);
  return unsealedRows(rows);
}

/** Narrow views of the two stores the boot purge touches. */
export interface PurgeRosterStore {
  all(): ReadonlyArray<{ shipId: string; lastSectorKey: string }>;
  delete(shipId: string): boolean;
}
export interface PurgeHoldStore {
  delete(uid: string): void;
}

/**
 * Boot purge: delete every roster row last seen in a sealed sector, with its
 * ship hold (keyed by ship id, sectorKey null) and fitted-blueprint hold.
 * Sealed rooms are never saved, so nothing of theirs survives a restart.
 * Runs whether or not the sandbox is enabled. Returns the rows removed.
 * `onlySectorKey` (a sealed key) limits it to that one sector: a battle room
 * clears its last run when it is created (battleRooms.ts).
 */
export function purgeSealedRosterRows(roster: PurgeRosterStore, holds: PurgeHoldStore, onlySectorKey?: string): number {
  let removed = 0;
  for (const rec of roster.all()) {
    if (!isSealedSectorKey(rec.lastSectorKey)) continue;
    if (onlySectorKey !== undefined && rec.lastSectorKey !== onlySectorKey) continue;
    holds.delete(rec.shipId);
    holds.delete(fittedUid(rec.shipId));
    if (roster.delete(rec.shipId)) removed++;
  }
  return removed;
}
