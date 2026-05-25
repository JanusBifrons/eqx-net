/**
 * @vitest-environment jsdom
 *
 * Refcounted roster-poller — dedupe regression lock.
 *
 * Plan: mobile-perf-investigation (2026-05-24, Probe 4).
 *
 * Pre-fix evidence (capture `n6uznw`): 43 `roster_fetch` events in ~80 s
 * of session with two `ShipRosterPanel` instances mounted (galaxy map +
 * drawer Galaxy tab). Each panel owned its own `setInterval`, so the
 * documented "every 3 s" cadence doubled. The doubled load correlated
 * with raf_gap stalls on the user's Pixel 6.
 *
 * Post-fix contract:
 *   - N panels acquiring the SAME playerId share ONE interval.
 *   - First acquire fires an immediate initial fetch + starts the poll.
 *   - Last release stops the poll.
 *   - PlayerId change restarts the loop with the new id (an immediate
 *     fetch + a fresh interval).
 *   - In-flight requests de-bounce — interval ticks while a fetch is
 *     outstanding skip rather than pile parallel requests.
 *   - Existing `roster_fetch` logEvent semantics are preserved verbatim
 *     so capture-analysis tooling works unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquireRosterPolling,
  releaseRosterPolling,
  forceRefreshRoster,
  __test_resetRosterPoller,
  __test_getRosterPollerState,
} from './rosterPoller';
import { useUIStore } from '../state/store';
import { getRingEntries } from '../debug/ClientLogger';

const POLL_MS = 3000;

// Mock fetch — returns a controllable response.
type FetchFn = typeof fetch;
let mockFetch: ReturnType<typeof vi.fn>;
let originalFetch: FetchFn;

beforeEach(() => {
  __test_resetRosterPoller();
  // Reset Zustand store roster.
  useUIStore.getState().setShipRoster([]);
  // Clear logger ring so tests start clean.
  getRingEntries().length = 0;
  // Mock fetch with a default OK response.
  originalFetch = globalThis.fetch;
  mockFetch = vi.fn(() => Promise.resolve(new Response(
    JSON.stringify({ ships: [{ shipId: 'a', kind: 'fighter', health: 100, lastSectorKey: 'sol-prime' }] }),
    { status: 200 },
  )));
  globalThis.fetch = mockFetch as unknown as FetchFn;
  // Use fake timers for deterministic interval control.
  vi.useFakeTimers();
});

afterEach(() => {
  __test_resetRosterPoller();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('roster poller — refcount + dedupe', () => {
  it('first acquire fires an immediate fetch and starts the interval', async () => {
    acquireRosterPolling('player-1');
    expect(__test_getRosterPollerState().refCount).toBe(1);
    expect(__test_getRosterPollerState().activePlayerId).toBe('player-1');
    expect(__test_getRosterPollerState().intervalHandle).not.toBeNull();
    // Immediate fetch fires synchronously.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('two acquires with the SAME playerId do not start two intervals or fire two fetches', async () => {
    acquireRosterPolling('player-1');
    acquireRosterPolling('player-1');
    expect(__test_getRosterPollerState().refCount).toBe(2);
    // Only one initial fetch — the second acquire detects same id and skips.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('two acquires + advance time: ONE fetch per 3 s interval (not two)', async () => {
    acquireRosterPolling('player-1');
    acquireRosterPolling('player-1');
    expect(mockFetch).toHaveBeenCalledTimes(1); // initial
    // Flush the initial fetch's promise (microtasks only, no timer advance).
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Advance one poll cycle.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(2); // initial + 1 interval tick
    // Two more cycles.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('release leaves polling running while refCount > 0', async () => {
    acquireRosterPolling('player-1');
    acquireRosterPolling('player-1');
    releaseRosterPolling();
    expect(__test_getRosterPollerState().refCount).toBe(1);
    expect(__test_getRosterPollerState().intervalHandle).not.toBeNull();
    expect(__test_getRosterPollerState().activePlayerId).toBe('player-1');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('last release stops the interval and clears activePlayerId', async () => {
    acquireRosterPolling('player-1');
    releaseRosterPolling();
    expect(__test_getRosterPollerState().refCount).toBe(0);
    expect(__test_getRosterPollerState().intervalHandle).toBeNull();
    expect(__test_getRosterPollerState().activePlayerId).toBe('');
    await vi.advanceTimersByTimeAsync(0);
    // After release, no further fetches even when time advances.
    const callsBefore = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(mockFetch).toHaveBeenCalledTimes(callsBefore);
  });

  it('release without prior acquire is a no-op (defensive)', () => {
    expect(() => releaseRosterPolling()).not.toThrow();
    expect(__test_getRosterPollerState().refCount).toBe(0);
  });

  it('changing playerId mid-poll restarts the loop with the new id', async () => {
    acquireRosterPolling('player-1');
    await vi.advanceTimersByTimeAsync(0); // flush initial fetch microtask
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toContain('player-1');
    // Acquire from a "different mount" with a new id — should restart.
    acquireRosterPolling('player-2');
    expect(__test_getRosterPollerState().activePlayerId).toBe('player-2');
    expect(__test_getRosterPollerState().refCount).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]?.[0]).toContain('player-2');
  });

  it('forceRefreshRoster fires an immediate fetch outside the interval cycle', async () => {
    acquireRosterPolling('player-1');
    await vi.advanceTimersByTimeAsync(0); // flush initial fetch microtask
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await forceRefreshRoster();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('in-flight fetch de-bounces: a tick while waiting on response skips rather than piling', async () => {
    // Configure fetch to never resolve so we stay "in-flight".
    let resolveFn: (v: Response) => void = () => { /* unset */ };
    mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFn = resolve; }));
    acquireRosterPolling('player-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(__test_getRosterPollerState().inFlight).toBe(true);
    // Tick the interval while still in-flight — should NOT pile.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Resolve and verify the skipped tick logged a `roster_fetch skip in-flight`.
    resolveFn(new Response(JSON.stringify({ ships: [] }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    const events = getRingEntries().filter((e) => e.tag === 'roster_fetch');
    const skipInFlight = events.find((e) => (e.data as Record<string, unknown>)?.['stage'] === 'skip'
      && (e.data as Record<string, unknown>)?.['reason'] === 'in-flight');
    expect(skipInFlight, 'expected at least one roster_fetch skip in-flight event').toBeDefined();
  });

  it('roster_fetch event semantics preserved (start, ok with count+kinds)', async () => {
    acquireRosterPolling('player-1');
    await vi.advanceTimersByTimeAsync(0);
    const events = getRingEntries().filter((e) => e.tag === 'roster_fetch');
    const startEvt = events.find((e) => (e.data as Record<string, unknown>)?.['stage'] === 'start');
    const okEvt = events.find((e) => (e.data as Record<string, unknown>)?.['stage'] === 'ok');
    expect(startEvt, 'roster_fetch start event must fire').toBeDefined();
    expect(okEvt, 'roster_fetch ok event must fire after success').toBeDefined();
    const okData = okEvt!.data as Record<string, unknown>;
    expect(okData['count']).toBe(1);
    expect(okData['kinds']).toEqual(['fighter']);
  });

  it('successful fetch writes to Zustand shipRoster', async () => {
    acquireRosterPolling('player-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(useUIStore.getState().shipRoster).toEqual([
      { shipId: 'a', kind: 'fighter', health: 100, lastSectorKey: 'sol-prime' },
    ]);
  });

  it('REGRESSION-WATCH: 5 acquires × 30 s = ~10 fetches (was ~50 pre-dedupe)', async () => {
    // Pre-dedupe: 5 panels × (10 ticks + 1 immediate each) = 55 fetches.
    // Post-dedupe: 1 immediate + 10 ticks = 11 fetches max.
    for (let i = 0; i < 5; i++) acquireRosterPolling('player-1');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    // Allow ±1 for boundary jitter on the interval scheduler.
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(12);
  });
});
