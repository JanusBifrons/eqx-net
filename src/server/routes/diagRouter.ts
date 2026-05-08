/**
 * Dev-only diagnostic capture endpoint.
 *
 * Lets a connected client POST a JSON blob (captured ring buffer + UA + stats)
 * to be written to `diag/captures/<timestamp>-<id>.json`. The intent is that
 * the user plays for a bit on a real device, taps a "Capture diagnostic"
 * button, and the file appears server-side where Claude can `Read` it for
 * analysis. No DB; one file per capture; directory is gitignored.
 *
 * Disabled when `NODE_ENV === 'production'` — the index.ts mount is gated.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { matchMaker } from 'colyseus';
import { getRecentEvents } from '../debug/ServerEventLog.js';
import { db } from '../db/Database.js';
import { getLimboStore } from '../db/PersistenceWorker.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';

const CAPTURE_DIR = resolve(process.cwd(), 'diag', 'captures');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB ceiling — a 500-entry log is ~150 KB; this is plenty.

const captureSchema = z.object({
  /** Free-form note from the user (e.g. "corr feels bad"). */
  note: z.string().max(500).optional(),
  /** User agent string from the client. */
  userAgent: z.string().max(500).optional(),
  /** Viewport for spotting mobile vs desktop without parsing UA. */
  viewport: z.object({ w: z.number(), h: z.number() }).optional(),
  /** `gameClient.stats` snapshot (PredictionStats). Free-shape — we just store it. */
  stats: z.record(z.unknown()).optional(),
  /** Ring-buffer entries from `window.__eqxLogs`. Free-shape per entry. */
  logs: z.array(z.record(z.unknown())).max(2000),
}).strict();

export const diagRouter: ExpressRouter = Router();

diagRouter.post('/capture', async (req: Request, res: Response) => {
  // Hard size cap before zod even sees it.
  const rawLength = JSON.stringify(req.body ?? {}).length;
  if (rawLength > MAX_BYTES) {
    res.status(413).json({ error: 'capture too large', bytes: rawLength });
    return;
  }

  const parsed = captureSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid capture', detail: parsed.error.format() });
    return;
  }

  await mkdir(CAPTURE_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = Math.random().toString(36).slice(2, 8);
  const filename = `${ts}-${id}.json`;
  const path = join(CAPTURE_DIR, filename);

  // Pull the matching window of server-side events so the saved file has
  // both perspectives in one place. 500 entries covers ~10 s at typical rates.
  const serverEvents = getRecentEvents(500);

  const payload = {
    capturedAt: ts,
    serverReceivedAtMs: Date.now(),
    ...parsed.data,
    serverEvents,
  };

  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');

  res.json({ ok: true, filename, bytes: rawLength });
});

/** Mirror of CAPTURE_DIR for tests / introspection. */
export const captureDir = CAPTURE_DIR;

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
 * GET /dev/limbo?playerId=foo — Phase 8 sub-phase B inspection + landing-
 * screen lookup. Returns the held-ship summary so the galaxy-map landing
 * screen can render a "your ship is here" card. The summary deliberately
 * omits velocity (vx/vy/angvel) and angle — those are simulation details
 * the player doesn't care about — but does include position, health, and
 * the metadata needed to format a "saved <duration> ago" UI string.
 *
 * NODE_ENV-gated mount in index.ts. The route is the single client-facing
 * lookup for the active-Limbo UX; it's safe to expose pose because the
 * playerId-keyed lookup requires the requester to already know the
 * playerId (which is per-browser localStorage), and pose is broadcast
 * unconditionally to anyone in the same sector anyway.
 */
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
  const entry = getLimboStore().peek(playerId);
  if (!entry) {
    res.json({ exists: false });
    return;
  }
  const p = entry.payload;
  res.json({
    exists: true,
    sectorKey: p.sectorKey,
    expiresAt: entry.expiresAt,
    createdAt: entry.createdAt,
    x: p.x,
    y: p.y,
    health: p.health,
    userId: p.userId,
  });
}
