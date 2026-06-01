/**
 * Reads diag/captures/ directories that the client's autocapture
 * stream writes to (via POST /diag/capture, every 2 s when
 * ?autocapture=1). Used by phone-driven specs to detect the capture
 * produced by *this* test run and parse its NDJSON files.
 *
 * Capture file layout (confirmed against capture jfd81u 2026-05-31):
 *   diag/captures/<ISO-ts>-<rand-id>/
 *     ├ session.json
 *     ├ combat.ndjson
 *     ├ corrections.ndjson
 *     ├ lifecycle.ndjson
 *     ├ other.ndjson
 *     ├ perf.ndjson     ← recv_gap_long events
 *     └ snapshots.ndjson
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURES_ROOT = 'diag/captures';

function listCaptureDirs(): string[] {
  if (!existsSync(CAPTURES_ROOT)) return [];
  return readdirSync(CAPTURES_ROOT).filter((name) => {
    try {
      return statSync(join(CAPTURES_ROOT, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Snapshot the set of existing capture-dir names so a later call to
 * findNewestCaptureSince() can identify which one this test run produced.
 */
export function snapshotCaptures(): Set<string> {
  return new Set(listCaptureDirs());
}

/**
 * Diff the captures dir against a prior snapshot. Returns the path to
 * the single new entry. If multiple new dirs appeared (parallel session
 * also wrote, or autocapture started + restarted), picks the newest by
 * mtime. Throws if no new entry appeared.
 */
export function findNewestCaptureSince(prev: Set<string>): string {
  if (!existsSync(CAPTURES_ROOT)) {
    throw new Error(
      `[captureFetcher] ${CAPTURES_ROOT} does not exist — autocapture=1 did not write anything. ` +
        `Check the dev server's POST /diag/capture handler is alive and that the URL actually carries ?autocapture=1.`,
    );
  }
  const current = listCaptureDirs();
  const fresh = current.filter((name) => !prev.has(name));
  if (fresh.length === 0) {
    throw new Error(
      `[captureFetcher] No new capture directory appeared in ${CAPTURES_ROOT}. ` +
        `Either the autocapture stream never flushed (wait window too short?) or the server didn't accept the POST.`,
    );
  }
  fresh.sort((a, b) => {
    const am = statSync(join(CAPTURES_ROOT, a)).mtimeMs;
    const bm = statSync(join(CAPTURES_ROOT, b)).mtimeMs;
    return bm - am;
  });
  return join(CAPTURES_ROOT, fresh[0]);
}

export interface NdjsonEvent {
  source?: string;
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

/**
 * Line-by-line JSON.parse of an NDJSON file. Bad lines (partial flush,
 * stream interrupted) are silently skipped — autocapture streams in
 * 2-s ticks, so a mid-line tail is normal at session end.
 */
export function readNdjson(file: string): NdjsonEvent[] {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf8');
  const out: NdjsonEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NdjsonEvent);
    } catch {
      // Skip bad lines silently.
    }
  }
  return out;
}

export interface ServerLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

/**
 * Fetch /dev/events from the dev server's event ring buffer. Returns
 * server-side log entries (ts is Date.now() epoch ms, not performance.now()).
 * Limit caps at 500 per the server's MAX_DEV_EVENTS.
 */
export async function fetchDevEvents(
  serverBaseUrl: string,
  limit = 500,
): Promise<ServerLogEntry[]> {
  const res = await fetch(`${serverBaseUrl}/dev/events?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`[captureFetcher] /dev/events returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { events: ServerLogEntry[] };
  return body.events ?? [];
}

export interface RecvGapEvent {
  ts: number;
  via: string;
  recvGapMs: number;
  heapUsedMb: number;
  serverSendPerfNow: number;
  clientRecvPerfNow: number;
  serverToClientDeltaMs: number;
  wsBufferedAmountBytes: number;
}

/**
 * Find recv_gap_long events in a capture's perf.ndjson, filtered by
 * minimum recvGapMs. Returns them in occurrence order.
 */
export function findRecvGapLongs(captureDir: string, minMs: number): RecvGapEvent[] {
  const perfFile = join(captureDir, 'perf.ndjson');
  const events = readNdjson(perfFile);
  const out: RecvGapEvent[] = [];
  for (const e of events) {
    if (e.tag !== 'recv_gap_long') continue;
    const recvGapMs = Number(e.data['recvGapMs']);
    if (!Number.isFinite(recvGapMs) || recvGapMs < minMs) continue;
    out.push({
      ts: e.ts,
      via: String(e.data['via'] ?? 'unknown'),
      recvGapMs,
      heapUsedMb: Number(e.data['heapUsedMb'] ?? 0),
      serverSendPerfNow: Number(e.data['serverSendPerfNow'] ?? 0),
      clientRecvPerfNow: Number(e.data['clientRecvPerfNow'] ?? 0),
      serverToClientDeltaMs: Number(e.data['serverToClientDeltaMs'] ?? 0),
      wsBufferedAmountBytes: Number(e.data['wsBufferedAmountBytes'] ?? 0),
    });
  }
  return out;
}
