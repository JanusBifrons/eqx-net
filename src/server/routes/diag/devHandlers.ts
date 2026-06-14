/**
 * Dev-only diagnostic + introspection HTTP handlers. Extracted from the
 * monolithic `diagRouter.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 9). The capture-stream
 * pipeline + the `/capture` POST routes remain in `diagRouter.ts`
 * (they share the on-disk retention state).
 *
 * Each handler is mounted directly on the Express app from
 * `src/server/index.ts` (NOT on the `diagRouter` Router) — the
 * existing convention. All routes are NODE_ENV-gated at the mount site.
 */

import type { Request, Response } from 'express';
import { matchMaker } from 'colyseus';
import { db } from '../../db/Database.js';
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import { GALAXY_SECTORS } from '../../../core/galaxy/galaxy.js';

/**
 * GET /dev/stats?email=foo — kills/deaths counts for a user. Mounted directly
 * on `app` in index.ts (matches the /dev/events convention). Phase 7 E2E gate.
 */
export function devStatsHandler(req: Request, res: Response): void {
  const email = String(req.query['email'] ?? '').toLowerCase();
  if (!email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  try {
    const row = db.prepare(`
      SELECT
        u.id,
        u.email,
        u.display_name,
        (SELECT count(*) FROM player_kills WHERE killer_user_id = u.id) AS kills,
        (SELECT count(*) FROM player_kills WHERE victim_user_id = u.id) AS deaths
      FROM users u
      WHERE u.email = ?
    `).get(email) as {
      id: string;
      email: string;
      display_name: string | null;
      kills: number;
      deaths: number;
    } | undefined;
    if (!row) {
      res.status(404).json({ error: 'user not found', email });
      return;
    }
    res.json({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      kills: Number(row.kills),
      deaths: Number(row.deaths),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * POST /dev/reset-sector?key=<roomName> — surgical reset for smoke testing.
 *
 * Wipes a sector's in-memory swarm state AND its persisted snapshot row,
 * then re-creates the room (for galaxy sectors which are eagerly created
 * at boot). Engineering rooms (`sector`, `test-sector`, `swarm-*`) lazy-
 * spawn on next join, so disposal alone is enough.
 *
 * `key` matches the Colyseus room name:
 *   - `sector`            — legacy engineering drone-ring room
 *   - `galaxy-sol-prime`  — a specific galaxy sector
 *   - `all-galaxy`        — every galaxy sector at once
 *
 * Returns: { ok, deletedSnapshots, disposedRooms, recreated }.
 *
 * Connected clients in the affected room(s) get disconnected — they'll
 * need to rejoin to see the fresh state. NODE_ENV-gated mount in
 * index.ts (same gate as the other /dev/* routes).
 */
export async function devResetSectorHandler(req: Request, res: Response): Promise<void> {
  const key = String(req.query['key'] ?? '');
  if (!key) {
    res.status(400).json({
      error: 'key required',
      examples: ['key=sector', 'key=galaxy-sol-prime', 'key=all-galaxy'],
    });
    return;
  }

  // Resolve which room names we're targeting.
  const targetRooms: string[] = [];
  let isGalaxyReset = false;
  if (key === 'all-galaxy') {
    for (const s of GALAXY_SECTORS) targetRooms.push(`galaxy-${s.key}`);
    isGalaxyReset = true;
  } else {
    targetRooms.push(key);
    if (key.startsWith('galaxy-')) isGalaxyReset = true;
  }

  // Step 1: delete persisted snapshots (galaxy sectors only — engineering
  // rooms don't persist).
  let deletedSnapshots = 0;
  if (isGalaxyReset) {
    try {
      const sectorKeys =
        key === 'all-galaxy'
          ? GALAXY_SECTORS.map((s) => s.key)
          : [key.replace(/^galaxy-/, '')];
      for (const sectorKey of sectorKeys) {
        const result = db
          .prepare('DELETE FROM game_snapshots WHERE sector_id = ?')
          .run(sectorKey);
        deletedSnapshots += Number(result.changes);
      }
    } catch (err) {
      res.status(500).json({ error: 'snapshot delete failed', detail: (err as Error).message });
      return;
    }
  }

  // Step 2: dispose any running room instances so fresh-spawn happens next.
  let disposedRooms = 0;
  for (const roomName of targetRooms) {
    try {
      const rooms = await matchMaker.query({ name: roomName });
      for (const room of rooms) {
        try {
          await matchMaker.remoteRoomCall(room.roomId, 'disconnect');
          disposedRooms++;
        } catch {
          /* room may already be disposing — best effort */
        }
      }
    } catch {
      /* ignore — room name may not be registered */
    }
  }

  // Step 3: re-create galaxy sectors so they hydrate from the now-empty DB
  // (they're eagerly created at boot; disposing them above leaves a hole
  // that has to be re-filled). Engineering rooms aren't pre-created, so
  // they'll lazy-spawn on next join naturally.
  let recreated = 0;
  if (isGalaxyReset) {
    const recreateKeys =
      key === 'all-galaxy'
        ? GALAXY_SECTORS.map((s) => s.key)
        : [key.replace(/^galaxy-/, '')];
    for (const sectorKey of recreateKeys) {
      try {
        await matchMaker.createRoom(`galaxy-${sectorKey}`, {});
        recreated++;
      } catch {
        /* createRoom may race with the dispose above; ignore */
      }
    }
  }

  res.json({ ok: true, key, deletedSnapshots, disposedRooms, recreated });
}

export function devLimboHandler(req: Request, res: Response): void {
  const playerId = String(req.query['playerId'] ?? '');
  if (!playerId) {
    res.status(400).json({ error: 'playerId required' });
    return;
  }
  // WS-B (Phase 5): the LimboStore is retired — the roster (/dev/player-ships)
  // is the source of truth for lingering ships now. Kept as a back-compat stub
  // for the client's GalaxyPickerChrome fetch + E2E; always reports no entry.
  res.json({ exists: false });
}

/**
 * POST /dev/player-ships/:shipId/abandon — Phase 3 multi-ship roster.
 * Drop a ship from the player's roster. Requires `playerId` in the JSON
 * body (the dev endpoint trusts the caller — the client sends its own
 * playerId; a malicious client could only abandon its own ships). 404
 * if no such ship; 403 if the ship is not owned by the supplied
 * playerId. Active and lingering ships are both abandonable — the
 * roster row vanishes immediately; if the ship is still in a sector
 * room, the room will continue to host it until the standard
 * disconnect/eviction path runs, but it will not be remembered after.
 * Phase 4 replaces this with a wreck-spawn flow.
 */
export function devPlayerShipsAbandonHandler(req: Request, res: Response): void {
  const shipId = String(req.params['shipId'] ?? '');
  const body = (req.body ?? {}) as { playerId?: unknown };
  const playerId = typeof body.playerId === 'string' ? body.playerId : '';
  if (!shipId || !playerId) {
    res.status(400).json({ error: 'shipId and playerId required' });
    return;
  }
  const store = getPlayerShipStore();
  const ship = store.get(shipId);
  if (ship === null) {
    res.status(404).json({ error: 'ship not found' });
    return;
  }
  if (ship.playerId !== playerId) {
    res.status(403).json({ error: 'ship not owned by caller' });
    return;
  }
  const removed = store.delete(shipId);
  res.json({ ok: removed, shipId });
}

/**
 * POST /dev/reset-roster — wipe every roster row for the caller's
 * playerId. Test-only fixture-prep helper (added 2026-05-13 for the
 * UI happy-path E2E so multi-spawn tests start from a known-empty
 * roster). Requires `playerId` in the JSON body. Returns the number
 * of rows deleted.
 *
 * This does NOT touch the in-room ShipState — only the persistent
 * roster table. Use alongside `/dev/reset-sector` if you also need
 * the in-room state cleared.
 */
export function devResetRosterHandler(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { playerId?: unknown };
  const playerId = typeof body.playerId === 'string' ? body.playerId : '';
  if (!playerId) {
    res.status(400).json({ error: 'playerId required' });
    return;
  }
  const store = getPlayerShipStore();
  const rows = store.listByPlayer(playerId);
  for (const row of rows) {
    store.delete(row.shipId);
  }
  res.json({ ok: true, deleted: rows.length });
}

/**
 * GET /dev/webrtc-counters?roomId=<colyseus-roomId> — Phase 4 iteration 3
 * swift-otter diagnostic. Returns the room's per-session WebRTC counter
 * snapshot via `matchMaker.remoteRoomCall`, used by the Phase 4 E2E to
 * compare server-side `sentViaDc` against client-side `snapshot_received`
 * via='dc' counts. Localises whether DC throughput variance is server-
 * side, libdatachannel-wire-side, or browser-side.
 *
 * Single roomId variant (preferred for the E2E): the test captures
 * `gameClient.room.id` and asks for that room's counters directly. Errors
 * with 404 when the room is unknown (e.g. already disposed) — the test
 * treats that as "no diagnostic data, log only" rather than failing.
 */
export async function devWebrtcCountersHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const roomId = String(req.query['roomId'] ?? '');
  if (!roomId) {
    res.status(400).json({ error: 'roomId required' });
    return;
  }
  try {
    const result = await matchMaker.remoteRoomCall(roomId, 'getWebRtcCounters');
    if (result === null || result === undefined) {
      res.status(404).json({ error: 'room has no webrtc manager', roomId });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: 'room not found or call failed', roomId, detail: (err as Error).message });
  }
}

/**
 * GET /dev/player-ships?playerId=foo — Phase 2 multi-ship roster.
 * Returns the player's full roster (up to 10 entries). Empty array if the
 * player has never spawned. Read-only; mutations flow through gameplay
 * paths (sector-room onJoin/onLeave/transit) which are wired in Phase 3.
 */
export function devPlayerShipsHandler(req: Request, res: Response): void {
  const playerId = String(req.query['playerId'] ?? '');
  if (!playerId) {
    res.status(400).json({ error: 'playerId required' });
    return;
  }
  const ships = getPlayerShipStore().listByPlayer(playerId).map((rec) => ({
    shipId: rec.shipId,
    kind: rec.kind,
    kindVersion: rec.kindVersion,
    health: rec.health,
    sectorKey: rec.lastSectorKey,
    x: rec.lastX,
    y: rec.lastY,
    isActive: rec.isActive,
    activeRoomId: rec.activeRoomId,
    expiresAt: rec.expiresAt,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  }));
  res.json({ playerId, ships });
}
