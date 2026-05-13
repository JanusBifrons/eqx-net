/**
 * Server-events assertion API for integration tests (2026-05-13).
 *
 * `SectorRoom` (and friends) write structured events through
 * `serverLogEvent(tag, data)` into a module-level 500-entry ring buffer
 * (`src/server/debug/ServerEventLog.ts`). Production reads it via
 * `GET /dev/events`; tests can read it directly because we run in the
 * same Node process.
 *
 * This module wraps the ring buffer in a test-ergonomic API:
 *   - `events.clear()` — wipe the buffer so subsequent assertions are
 *     scoped to events from THIS test onwards. Called automatically by
 *     `bootSectorTestServer` so each test starts with a clean slate.
 *   - `events.all({ tag, where? })` — return matching events.
 *   - `events.count({ tag, where? })` — count without materialising the
 *     array.
 *   - `events.waitFor({ tag, where? }, timeoutMs?)` — promise-based
 *     wait, polling the buffer at 25 ms. Replaces the
 *     `harness.advance(N)` blind sleeps that depend on wall-clock
 *     timing for event delivery.
 *   - `events.captureWindow(fn)` — run `fn`, return the events that
 *     fired during the call. Handy for "does action X log Y?" assertions.
 *
 * All methods are synchronous reads on a Node module-level ring buffer,
 * so they're effectively free in the hot path.
 */
import { getRecentEvents, clearEvents, type ServerLogEntry } from '../../../src/server/debug/ServerEventLog.js';

/** Filter for matching server log entries. Both fields optional — empty
 *  filter matches everything currently in the buffer. */
export interface EventFilter {
  /** Exact-match the event tag (e.g. `'player_join'`). */
  tag?: string;
  /** Predicate over `data` for fine-grained filtering. Receives the raw
   *  `data: Record<string, unknown>` so the test can type-check fields
   *  as needed. */
  where?: (data: Record<string, unknown>) => boolean;
}

export interface ServerEventsApi {
  clear(): void;
  all(filter?: EventFilter): ServerLogEntry[];
  count(filter?: EventFilter): number;
  /** Wait until at least one event matches the filter. Resolves with the
   *  first matching entry. Rejects on timeout. */
  waitFor(filter: EventFilter, opts?: { timeoutMs?: number; pollMs?: number }): Promise<ServerLogEntry>;
  /** Snapshot the buffer length before running `fn`, then return the
   *  events that arrived during the call. Bounded; doesn't reset the
   *  buffer (so caller-chained assertions still see history). */
  captureWindow<T>(fn: () => Promise<T> | T): Promise<{ result: T; events: ServerLogEntry[] }>;
}

function matches(entry: ServerLogEntry, filter: EventFilter): boolean {
  if (filter.tag !== undefined && entry.tag !== filter.tag) return false;
  if (filter.where !== undefined && !filter.where(entry.data)) return false;
  return true;
}

export function createServerEventsApi(): ServerEventsApi {
  return {
    clear(): void {
      clearEvents();
    },
    all(filter): ServerLogEntry[] {
      const events = getRecentEvents(500);
      if (!filter) return events;
      return events.filter((e) => matches(e, filter));
    },
    count(filter): number {
      const events = getRecentEvents(500);
      if (!filter) return events.length;
      let n = 0;
      for (const e of events) if (matches(e, filter)) n++;
      return n;
    },
    async waitFor(filter, opts = {}): Promise<ServerLogEntry> {
      const timeoutMs = opts.timeoutMs ?? 2000;
      const pollMs = opts.pollMs ?? 25;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const events = getRecentEvents(500);
        for (const e of events) if (matches(e, filter)) return e;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      throw new Error(
        `serverEvents.waitFor timed out after ${timeoutMs}ms: ${JSON.stringify(filter, (_k, v) =>
          typeof v === 'function' ? '<predicate>' : v,
        )}`,
      );
    },
    async captureWindow<T>(fn: () => Promise<T> | T): Promise<{ result: T; events: ServerLogEntry[] }> {
      const before = getRecentEvents(500).length;
      const result = await fn();
      const after = getRecentEvents(500);
      return { result, events: after.slice(before) };
    },
  };
}
