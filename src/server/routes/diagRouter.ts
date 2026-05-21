/**
 * Dev-only diagnostic capture endpoint.
 *
 * Writes one capture as a DIRECTORY of sibling NDJSON files grouped by
 * purpose, plus a small `summary.json` with tag histograms and extracted
 * highlights. Read `summary.json` first; it tells you which sibling has
 * the spike. See `docs/architecture/diagnostic-captures.md`.
 *
 * Disabled when `NODE_ENV === 'production'` — the index.ts mount is gated.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import { mkdir, writeFile, appendFile, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureSchema, streamingBatchSchema } from './captureSchema.js';
import { matchMaker } from 'colyseus';
import { getRecentEvents } from '../debug/ServerEventLog.js';
import { db } from '../db/Database.js';
import { getLimboStore, getPlayerShipStore } from '../db/PersistenceWorker.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';

const CAPTURE_DIR = resolve(process.cwd(), 'diag', 'captures');
// 64 MB ceiling. Dev-only diagnostic capture: the client log ring is up
// to 30000 entries when `?diag=1` (ClientLogger `DIAG_MAX_ENTRIES`,
// raised so the sparse `transit_mark` rows survive a warp-out + Capture
// delay) plus the server-events bundle, which exceeds the old 2 MB.
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Tag → bucket. Anything unmapped lands in `other`. Adding a new tag means
 * one line here; keep this list as the single source of truth.
 *
 * Bucket meanings:
 *   - perf:        server-side performance signals (hitches, GC, budget)
 *   - corrections: client reconcile drift events
 *   - combat:      fire path + swarm proximity (laser/overlap diagnostics)
 *   - lifecycle:   join/leave/welcome/error/disconnect (rare, structural)
 *   - snapshots:   client snapshot + server snapshot_broadcast (high vol)
 *   - raf:         per-frame inputs and per-RAF ticks (highest vol — read last)
 */
const BUCKETS: Record<string, string> = {
  // server perf
  tick_hitch: 'perf',
  tick_budget: 'perf',
  gc_pause: 'perf',
  // client perf — main-thread block diagnostics for the mobile-stall
  // pathology captured in `2026-05-09T07-23-39-893Z-651792`.
  longtask: 'perf',
  raf_gap: 'perf',
  // Render-jitter-fix Phase 1c (2026-05-21) — periodic heap sample
  // between stalls. Pairs with `raf_gap`'s new heap fields so the
  // capture shows both growth trajectory AND per-stall heap value.
  heap_sample: 'perf',
  // client perf — F1 per-frame sub-cost markers for the warp-spool
  // investigation (`docs/HANDOFF-warp-spool-perf-followup.md`). Emitted
  // only on `?diag=1` / WebDriver sessions; `scripts/analyze-frame-
  // markers.mjs` reads these from `perf.ndjson`.
  renderer_update: 'perf',
  warp_tick: 'perf',
  grid_update: 'perf',
  mirror_rebuild: 'perf',
  mirror_clone: 'perf',
  // client perf — F-transit-instrument: gated, discrete client-ts
  // timeline across the inter-sector transit (warp-out → arrival →
  // settle) path + the bounded 40-frame post-reveal burst. Emitted
  // only on `?diag=1` / WebDriver. Routed to `perf` so they land in
  // `perf.ndjson` alongside `raf_gap` / `rafTick` for correlation
  // (the ts≈17546 residual-stall localisation —
  // `docs/HANDOFF-warp-spool-perf-followup.md`).
  transit_mark: 'perf',
  transit_frame: 'perf',
  // client corrections
  correction: 'corrections',
  // combat (client + server)
  fire: 'combat',
  fireRejected: 'combat',
  fire_received: 'combat',
  swarm_near_enter: 'combat',
  swarm_near_exit: 'combat',
  // 2026-05-09 — physics-side collisions surfaced into the diag stream
  // so we can correlate combat-phase correction bursts with actual
  // drone-vs-player contacts. See SectorRoom.ts CONTACT_BATCH handler.
  collision_resolved: 'combat',
  // Phase 6b — diagnostic for the same-playerId active+lingering hull
  // self-collisions that we drop at the broadcast site.
  collision_self_filtered: 'combat',
  // lifecycle
  welcome: 'lifecycle',
  disconnected: 'lifecycle',
  room_error: 'lifecycle',
  player_join: 'lifecycle',
  player_leave: 'lifecycle',
  player_rebind: 'lifecycle',
  player_lingered: 'lifecycle',
  ownerless_evicted: 'lifecycle',
  // Phase 6b smoke-test fallout (2026-05-13) — UI diagnostics for
  // "mounted twice / never appeared / Join button did nothing" failure
  // modes. Bucket to lifecycle: low-frequency, structural events.
  component_mount: 'lifecycle',
  component_unmount: 'lifecycle',
  phase_change: 'lifecycle',
  server_health_change: 'lifecycle',
  button_click: 'lifecycle',
  // Living World population (director lifecycle + per-tick report)
  bot_spawn: 'population',
  bot_despawn: 'population',
  bot_transit_start: 'population',
  bot_transit_commit: 'population',
  bot_transit_cancel: 'population',
  bot_respawn: 'population',
  population_report: 'population',
  // snapshots
  snapshot: 'snapshots',
  snapshot_broadcast: 'snapshots',
  // Render-jitter-fix Phase 1b (2026-05-21): WS-receive timing +
  // handler duration. `snapshot_received` fires at the moment the
  // colyseus onMessage handler is entered (with `recvGapMs` =
  // wall-clock since the previous one). `snapshot_applied` fires
  // after `handleSnapshot` returns (with `applyMs` = duration of the
  // handler call). Together they distinguish "server didn't send"
  // from "WS delivered late" from "we couldn't process in time"
  // during a spiral.
  snapshot_received: 'snapshots',
  snapshot_applied: 'snapshots',
  // Drone-triggered warp visuals (Living World hunter migrations
  // across sectors). The handler was silent before render-jitter-fix
  // Phase 1b — fix surfaces every drone warp event so we can correlate
  // its renderer cost with RAF stalls in the same capture window.
  warp_event: 'other',
  // high-volume per-frame noise
  rafTick: 'raf',
  inputSent: 'raf',
  input_received: 'raf',
  // Replay-grade ground-truth tags (plan: capture-driven replay infra,
  // i-d-like-you-to-zany-narwhal.md, Phase A, 2026-05-21). All three are
  // ALWAYS-ON (not diag-gated) and feed the deterministic replay harness:
  //   - input_intent          (per inner tick): raw keyboard/joystick read
  //   - local_pose_predicted  (per inner tick): predWorld state after tick
  //   - local_pose_rendered   (per RAF):        mirror state the renderer drew
  // Routed to `raf` for proximity to `rafTick` (correlation window).
  input_intent: 'raf',
  local_pose_predicted: 'raf',
  local_pose_rendered: 'raf',
};

const ALL_BUCKETS = ['perf', 'corrections', 'combat', 'lifecycle', 'population', 'snapshots', 'raf', 'other'] as const;
type BucketName = typeof ALL_BUCKETS[number];

// `captureSchema` + `DIAG_CAPTURE_MAX_LOG_ENTRIES` live in
// `./captureSchema` (pure, zod-only, unit-testable — extracted
// 2026-05-16 to fix the stale 2000-entry cap that 400'd every
// >2000-entry warp-out capture, and to give the diag upload real
// unit coverage without the server's node:sqlite transitive load).

interface RoutedEntry {
  source: 'client' | 'server';
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

function routeBucket(tag: string): BucketName {
  const b = BUCKETS[tag];
  return (b ?? 'other') as BucketName;
}

function asEntry(source: 'client' | 'server', raw: Record<string, unknown>): RoutedEntry | null {
  const ts = typeof raw['ts'] === 'number' ? raw['ts'] : NaN;
  const tag = typeof raw['tag'] === 'string' ? raw['tag'] : '';
  const data = (raw['data'] && typeof raw['data'] === 'object') ? raw['data'] as Record<string, unknown> : {};
  if (!Number.isFinite(ts) || tag.length === 0) return null;
  return { source, ts, tag, data };
}

/**
 * Pull out the small set of payloads that anyone reading the capture should
 * see immediately, without skimming the bulk NDJSON files. These are the
 * "first place to look" datapoints for the recurring questions:
 *   - Did the server hitch?     → topTickHitches, topTickBudgets
 *   - Did GC pause?              → gcPauses (rare; include all)
 *   - Did the client correct hard? → topCorrections
 *   - Did anything go wrong?     → firstError
 */
function extractHighlights(entries: RoutedEntry[]): Record<string, unknown> {
  const tickHitches = entries.filter((e) => e.tag === 'tick_hitch');
  const tickBudgets = entries.filter((e) => e.tag === 'tick_budget');
  const gcPauses = entries.filter((e) => e.tag === 'gc_pause');
  const corrections = entries.filter((e) => e.tag === 'correction');
  const firstError = entries.find((e) => e.tag === 'room_error' || e.tag === 'disconnected');

  const topBy = <T extends RoutedEntry>(arr: T[], key: string, n: number): T[] =>
    [...arr]
      .sort((a, b) => Number((b.data?.[key] ?? 0)) - Number((a.data?.[key] ?? 0)))
      .slice(0, n);

  return {
    topTickHitches: topBy(tickHitches, 'totalMs', 5),
    topTickBudgets: topBy(tickBudgets, 'totalMs', 3),
    gcPauses,
    topCorrections: topBy(corrections, 'driftUnits', 5),
    firstError: firstError ?? null,
  };
}

function tagHistogram(entries: RoutedEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const k = `${e.source}/${e.tag}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function timeBounds(entries: RoutedEntry[], source: 'client' | 'server'): { firstTs: number | null; lastTs: number | null; durationMs: number | null } {
  const xs = entries.filter((e) => e.source === source).map((e) => e.ts);
  if (xs.length === 0) return { firstTs: null, lastTs: null, durationMs: null };
  const firstTs = Math.min(...xs);
  const lastTs = Math.max(...xs);
  return { firstTs, lastTs, durationMs: lastTs - firstTs };
}

export const diagRouter: ExpressRouter = Router();

/**
 * Streaming capture endpoint — real persistence (plan: streaming
 * auto-capture, Phase 2, 2026-05-21).
 *
 * Each batch is appended to `diag/captures/<sessionId>/<bucket>.ndjson`
 * using the same BUCKETS routing as manual captures, so the directory
 * shape is identical and the replay harness consumes streaming sessions
 * unchanged. The first batch (batchSeq=0) also writes `session.json`
 * with the client metadata.
 *
 * Idempotency: `lastAppliedSeq` is tracked in `session.json` (durable
 * across `tsx watch` restarts) AND in memory (fast path). Duplicate /
 * out-of-order batches return 409.
 *
 * Per-session write serialisation: a per-sessionId Promise chain
 * ensures concurrent batches for the same session serialise their
 * disk writes (Windows `appendFile` is not concurrent-safe).
 *
 * NODE_ENV-gated by the existing `/diag/*` mount in `src/server/index.ts`.
 *
 * Out of scope for this commit (deferred):
 *   - Idle-timeout sweep + automatic summary.json finalize
 *   - Per-bucket running counters (for summary.json without disk re-sweep)
 *   - LRU eviction of the in-memory session map
 *   Those land in a follow-up commit if/when needed. Replay harness
 *   doesn't depend on summary.json; the streaming directory is usable
 *   as-is for `replayCapture()`.
 */

interface StreamingSessionState {
  /** Highest applied batchSeq. Loaded from session.json on first batch. */
  lastAppliedSeq: number;
  /** Promise chain head for write serialisation. Resolves when the last
   *  write completed. New writes await this then push themselves on. */
  writeChain: Promise<void>;
  /** Sticky metadata from the first batch. */
  startedAtMs: number;
}

const _streamingSessions = new Map<string, StreamingSessionState>();

async function loadStateFromDisk(
  sessionId: string,
): Promise<StreamingSessionState | null> {
  const sessionDir = join(CAPTURE_DIR, sessionId);
  const sessionPath = join(sessionDir, 'session.json');
  if (!existsSync(sessionPath)) return null;
  try {
    const raw = await readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw) as { lastAppliedSeq?: number; startedAtMs?: number };
    if (typeof parsed.lastAppliedSeq !== 'number') return null;
    return {
      lastAppliedSeq: parsed.lastAppliedSeq,
      writeChain: Promise.resolve(),
      startedAtMs: parsed.startedAtMs ?? Date.now(),
    };
  } catch {
    return null;
  }
}

/** Atomic write: write to `<path>.tmp`, then rename. POSIX + Windows
 *  both guarantee rename atomicity on the same filesystem. */
async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

diagRouter.post('/capture/stream', async (req: Request, res: Response) => {
  const parsed = streamingBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid streaming batch', detail: parsed.error.format() });
    return;
  }
  const body = parsed.data;
  const sessionId = body.sessionId;
  const sessionDir = join(CAPTURE_DIR, sessionId);
  const sessionPath = join(sessionDir, 'session.json');

  // Hydrate session state (lazy — on first request for this sessionId).
  // Reads session.json from disk if present (survives `tsx watch`
  // restarts; the in-memory map dies but the durable seq counter lives
  // on disk).
  let state = _streamingSessions.get(sessionId);
  if (!state) {
    const fromDisk = await loadStateFromDisk(sessionId);
    if (fromDisk) {
      state = fromDisk;
    } else {
      // Brand-new session — directory may or may not exist yet.
      state = {
        lastAppliedSeq: -1, // first batch has seq 0; rule is batchSeq > lastAppliedSeq
        writeChain: Promise.resolve(),
        startedAtMs: Date.now(),
      };
    }
    _streamingSessions.set(sessionId, state);
  }

  // Idempotency: batchSeq must be strictly greater than lastAppliedSeq.
  if (body.batchSeq <= state.lastAppliedSeq) {
    res.status(409).json({
      error: 'duplicate or out-of-order batch',
      lastAppliedSeq: state.lastAppliedSeq,
      receivedSeq: body.batchSeq,
    });
    return;
  }

  // Chain this batch's writes onto the per-session promise so concurrent
  // batches for the same session serialise (Windows appendFile is not
  // concurrent-safe).
  const writeOp = async (): Promise<void> => {
    // mkdir is idempotent with `recursive: true`. Always cheap.
    await mkdir(sessionDir, { recursive: true });

    // Group entries by bucket using the existing BUCKETS map.
    const buckets = new Map<BucketName, string[]>();
    for (const entry of body.entries) {
      const tag = typeof entry['tag'] === 'string' ? entry['tag'] : '';
      const bucket = (BUCKETS[tag] as BucketName | undefined) ?? 'other';
      // Stamp each entry with the source ('client') so downstream tooling
      // (replay harness, ingest script) can distinguish.
      const line = JSON.stringify({ source: 'client', ...entry });
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(line);
    }

    // Append each bucket's lines.
    for (const [bucket, lines] of buckets) {
      const file = join(sessionDir, `${bucket}.ndjson`);
      await appendFile(file, lines.join('\n') + '\n', 'utf8');
    }

    // Update session.json (atomic write) AFTER the ndjson appends so a
    // partial-write crash leaves the seq counter behind, not ahead.
    state!.lastAppliedSeq = body.batchSeq;
    await atomicWriteJson(sessionPath, {
      sessionId,
      streaming: true,
      hasFinalized: body.final === true,
      lastAppliedSeq: state!.lastAppliedSeq,
      lastBatchAtMs: Date.now(),
      startedAtMs: state!.startedAtMs,
      // First-batch metadata, sticky.
      ...(body.userAgent ? { userAgent: body.userAgent } : {}),
      ...(body.viewport ? { viewport: body.viewport } : {}),
      ...(body.clientEpochMs ? { clientEpochMs: body.clientEpochMs } : {}),
    });
  };

  // Push onto the per-session write chain; the chain handles
  // serialisation, and rejections are caught so a write failure on one
  // batch doesn't poison subsequent ones.
  state.writeChain = state.writeChain.then(writeOp, writeOp);
  try {
    await state.writeChain;
  } catch (err) {
    res.status(500).json({ error: 'write failed', detail: String((err as Error).message) });
    return;
  }

  res.json({ ok: true, lastAppliedSeq: state.lastAppliedSeq });
});

diagRouter.post('/capture', async (req: Request, res: Response) => {
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

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = Math.random().toString(36).slice(2, 8);
  const dirName = `${ts}-${id}`;
  const dirPath = join(CAPTURE_DIR, dirName);
  await mkdir(dirPath, { recursive: true });

  const serverEvents = getRecentEvents(500);

  const entries: RoutedEntry[] = [];
  for (const raw of parsed.data.logs) {
    const e = asEntry('client', raw);
    if (e) entries.push(e);
  }
  for (const raw of serverEvents) {
    const e = asEntry('server', raw as unknown as Record<string, unknown>);
    if (e) entries.push(e);
  }

  // Bucket and write NDJSON siblings.
  const buckets: Record<BucketName, RoutedEntry[]> = {
    perf: [], corrections: [], combat: [], lifecycle: [], population: [], snapshots: [], raf: [], other: [],
  };
  for (const e of entries) buckets[routeBucket(e.tag)].push(e);

  const bucketSizes: Record<string, number> = {};
  await Promise.all(ALL_BUCKETS.map(async (b) => {
    const rows = buckets[b];
    bucketSizes[b] = rows.length;
    if (rows.length === 0) return; // skip empty siblings to keep the dir scannable
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(join(dirPath, `${b}.ndjson`), ndjson, 'utf8');
  }));

  const summary = {
    capturedAt: ts,
    dirName,
    note: parsed.data.note ?? null,
    userAgent: parsed.data.userAgent ?? null,
    viewport: parsed.data.viewport ?? null,
    clientEpochMs: parsed.data.clientEpochMs ?? null,
    serverReceivedAtMs: Date.now(),
    timing: {
      note: 'client ts is performance.now() (relative to client boot); server ts is Date.now() wall-clock ms.',
      client: timeBounds(entries, 'client'),
      server: timeBounds(entries, 'server'),
    },
    counts: {
      total: entries.length,
      buckets: bucketSizes,
      tags: tagHistogram(entries),
    },
    highlights: extractHighlights(entries),
    stats: parsed.data.stats ?? null,
    files: ALL_BUCKETS.filter((b) => bucketSizes[b]! > 0).map((b) => `${b}.ndjson`),
  };

  await writeFile(join(dirPath, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  res.json({ ok: true, dir: dirName, filename: dirName, bytes: rawLength });
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
