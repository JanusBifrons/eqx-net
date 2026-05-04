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
import { getRecentEvents } from '../debug/ServerEventLog.js';
import { db } from '../db/Database.js';

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
