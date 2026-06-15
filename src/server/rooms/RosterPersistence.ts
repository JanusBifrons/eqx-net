/**
 * Persistence-side roster bridge for `SectorRoom`.
 *
 * Wraps the four `getPlayerShipStore()` calls the room makes — bind on
 * spawn, mark-linger on disconnect, mark-stored on eviction, delete on
 * destruction. Each method is sectorKey-gated (engineering rooms have
 * `sectorKey === null` and no roster).
 *
 * Extracted from SectorRoom (commit 21 partial). Pure adapter over
 * PlayerShipStore — no extra state of its own.
 */

import type { Logger } from 'pino';
import { getPlayerShipStore } from '../db/PersistenceWorker.js';
import { RosterFullError, PLAYER_SHIP_ACTIVE_LINGER_MS } from '../playerShips/PlayerShipStore.js';

export interface RosterPose {
  x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
  health: number; lastFireClientTick: number;
}

export interface RosterPersistenceDeps {
  /** Galaxy sector key (null → engineering room, all roster ops are no-ops). */
  sectorKey: () => string | null;
  /** Colyseus roomId — recorded on roster rows so the persistence
   *  worker can correlate to the room that owns the ship. */
  roomId: () => string;
  logger: Logger;
}

export class RosterPersistence {
  constructor(private readonly deps: RosterPersistenceDeps) {}

  /**
   * Pick or create the player's roster row for spawn. Returns the
   * bound shipInstanceId, or '' when:
   *  - engineering room (sectorKey null),
   *  - roster-full on fresh-create attempt (logged warn).
   */
  bind(
    playerId: string,
    userId: string | null,
    kind: string,
    pose: RosterPose,
    /** When set, bind this specific roster row rather than picking the
     *  most-recent. Caller is responsible for verifying ownership; here
     *  we only mark-active. Falls back to the most-recent path on miss. */
    preferredShipId: string = '',
    /** Phase 3 — when true, skip the most-recent-row fallback and
     *  always create a fresh roster entry. Used by the galaxy-map
     *  sector-click → kind-picker flow so clicking a sector spawns a
     *  *new* ship rather than silently resuming the player's last
     *  ride. Subject to 10-cap; on RosterFullError the ship still
     *  spawns but without a roster row (logged warning). */
    forceFreshCreate: boolean = false,
  ): string {
    const d = this.deps;
    const sectorKey = d.sectorKey();
    if (sectorKey === null) return '';
    const store = getPlayerShipStore();
    const roomId = d.roomId();
    if (preferredShipId !== '') {
      const next = store.markActive(preferredShipId, roomId, pose);
      if (next !== null) {
        d.logger.info({ playerId, shipId: next.shipId, path: 'preferred' }, 'roster bind');
        return next.shipId;
      }
      // Fell through — caller's preferred id didn't exist. Continue
      // with the legacy most-recent path so the player still spawns
      // into something rather than getting a roster-less ship.
    }
    const existing = store.listByPlayer(playerId);
    if (existing.length > 0 && !forceFreshCreate) {
      existing.sort((a, b) => b.updatedAt - a.updatedAt);
      const chosen = existing[0]!;
      const next = store.markActive(chosen.shipId, roomId, pose);
      d.logger.info({ playerId, shipId: next?.shipId, path: 'reuse-recent', existingCount: existing.length }, 'roster bind');
      return next?.shipId ?? '';
    }
    try {
      const rec = store.create({
        playerId,
        userId,
        kind,
        sectorKey,
        x: pose.x,
        y: pose.y,
        health: pose.health,
      });
      store.markActive(rec.shipId, roomId, pose);
      d.logger.info({ playerId, shipId: rec.shipId, path: 'fresh-create', forceFresh: forceFreshCreate }, 'roster bind');
      return rec.shipId;
    } catch (err) {
      if (err instanceof RosterFullError) {
        d.logger.warn({ playerId }, 'Roster full — ship spawned without a roster row');
      } else {
        d.logger.warn({ err, playerId }, 'Failed to create roster row');
      }
      return '';
    }
  }

  /** Linger: pose freeze at disconnect, expiresAt = now + 15 min. The roster
   *  `expiresAt` is unenforced (no prune sweep), so post-WS-B this is the only
   *  "linger window" — effectively forever (R2.26), until combat / respawn-evict
   *  / abandon → scrap. The value is kept for symmetry / a future prune. */
  markLinger(shipInstanceId: string, pose: RosterPose): void {
    const d = this.deps;
    if (d.sectorKey() === null || shipInstanceId === '') return;
    const store = getPlayerShipStore();
    if (store.get(shipInstanceId) === null) return;
    store.markActive(shipInstanceId, d.roomId(), pose, Date.now() + PLAYER_SHIP_ACTIVE_LINGER_MS);
  }

  /** Mirror an eviction — `is_active=true` → `is_active=false` with
   *  frozen pose. The row stays in the table (forever, modulo the
   *  10-cap) so the player can pick it on a future visit. */
  markStored(shipInstanceId: string, pose: RosterPose): void {
    const d = this.deps;
    const sectorKey = d.sectorKey();
    if (sectorKey === null || shipInstanceId === '') return;
    const store = getPlayerShipStore();
    if (store.get(shipInstanceId) === null) return;
    store.markStored(shipInstanceId, { ...pose, sectorKey });
  }

  /** Destruction — drop the row. The abandon→scrap flow handles the
   *  "shatter the hull into scrap" semantics separately. */
  delete(shipInstanceId: string): void {
    const d = this.deps;
    if (d.sectorKey() === null || shipInstanceId === '') return;
    getPlayerShipStore().delete(shipInstanceId);
  }
}
