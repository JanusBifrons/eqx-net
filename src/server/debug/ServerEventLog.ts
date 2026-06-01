/**
 * In-memory ring buffer of server-side debug events.
 * Exposed at GET /dev/events (dev builds only) so E2E tests can query
 * server state without scraping stdout.
 *
 * Usage in tests:
 *   const res = await fetch('http://localhost:2567/dev/events');
 *   const { events } = await res.json();
 *   const broadcasts = events.filter(e => e.tag === 'snapshot_broadcast');
 */

// Default 500; tests can opt into a larger ring via `EQX_DEV_EVENTS_MAX`
// to retain longer windows for cross-correlation against client captures
// (see tests/mobile-perf/phone-galaxy-stall-repro.spec.ts).
const MAX_ENTRIES = Number(process.env['EQX_DEV_EVENTS_MAX'] ?? 500);

export interface ServerLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

const entries: ServerLogEntry[] = [];

export function serverLogEvent(tag: string, data: Record<string, unknown>): void {
  entries.push({ ts: Date.now(), tag, data });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function getRecentEvents(limit = 200): ServerLogEntry[] {
  return entries.slice(-limit);
}

export function clearEvents(): void {
  entries.splice(0);
}
