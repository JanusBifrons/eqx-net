/**
 * Refcounted roster-poll singleton (Probe 4, mobile-perf-investigation
 * 2026-05-24).
 *
 * Pre-fix: every `ShipRosterPanel` mount owned its own `setInterval`
 * polling `/dev/player-ships?playerId=X` at 3 Hz. With two panels mounted
 * (galaxy-map landing + drawer Galaxy tab), the poll fired twice per
 * 3-second window — visible in capture `n6uznw` as 43 `roster_fetch`
 * events in ~80 s of session (vs the documented "every 3 s"). The
 * doubled fetch volume correlated with raf_gap stalls on the user's
 * Pixel 6 (likely Zustand `setShipRoster` → React reconciliation cost
 * doubling).
 *
 * Post-fix: panels call `acquireRosterPolling(playerId)` on mount and
 * `releaseRosterPolling()` on unmount. A module-level refcount tracks
 * active subscribers; the first acquire starts the interval, the last
 * release stops it. PlayerId changes restart the loop with the new id.
 * `forceRefreshRoster()` is exposed for the Abandon path which needs
 * an immediate re-fetch.
 *
 * The fetch + Zustand-write logic moved from the component into this
 * module so a single instance owns the network round-trip. Observability
 * (logEvent calls) is preserved verbatim so existing analysis tooling
 * works unchanged.
 *
 * Test seam: `__test_resetRosterPoller` lets tests start each case from
 * a known state without module-cache shenanigans.
 */
import { logEvent } from '../debug/ClientLogger';
import { useUIStore } from '../state/store';
import type { RosterShipEntry } from './ShipRosterCard';

const POLL_MS = 3000;
const ENDPOINT_LIST = '/dev/player-ships';

interface PollerState {
  refCount: number;
  activePlayerId: string;
  intervalHandle: number | null;
  inFlight: boolean;
}

const state: PollerState = {
  refCount: 0,
  activePlayerId: '',
  intervalHandle: null,
  inFlight: false,
};

/** Test-only seam — resets module state between cases. */
export function __test_resetRosterPoller(): void {
  if (state.intervalHandle !== null) {
    window.clearInterval(state.intervalHandle);
  }
  state.refCount = 0;
  state.activePlayerId = '';
  state.intervalHandle = null;
  state.inFlight = false;
}

/** Test-only — observe the internal state. */
export function __test_getRosterPollerState(): Readonly<PollerState> {
  return state;
}

async function performFetch(playerId: string): Promise<void> {
  if (state.inFlight) {
    // De-bounce: a previous fetch hasn't returned yet. Skip rather than
    // pile a parallel request on top — under network stress this prevents
    // unbounded fan-out.
    logEvent('roster_fetch', { stage: 'skip', reason: 'in-flight' });
    return;
  }
  if (playerId === '') {
    logEvent('roster_fetch', { stage: 'skip', reason: 'no-pid' });
    return;
  }
  state.inFlight = true;
  try {
    const url = `${ENDPOINT_LIST}?playerId=${encodeURIComponent(playerId)}`;
    logEvent('roster_fetch', { stage: 'start', url, playerId });
    const res = await fetch(url);
    if (!res.ok) {
      logEvent('roster_fetch', { stage: 'http-error', status: res.status });
      return;
    }
    const body = (await res.json()) as { ships?: RosterShipEntry[] };
    const out = Array.isArray(body.ships) ? body.ships : [];
    useUIStore.getState().setShipRoster(out);
    logEvent('roster_fetch', { stage: 'ok', count: out.length, kinds: out.map((s) => s.kind) });
  } catch (err) {
    logEvent('roster_fetch', { stage: 'exception', message: (err as Error).message ?? 'unknown' });
  } finally {
    state.inFlight = false;
    // 2026-06-19 pop-in fix — the galaxy landing reveal gate waits on this (for a
    // logged-in player) so OWN SHIP badges don't pop in after the map reveals
    // (the user's "ships still pop in"). Flip on the first COMPLETED fetch
    // (success OR failure) so a roster hiccup never keeps the opaque gate up
    // forever (mirrors useGalaxyStats / useGalaxyPresence).
    if (!useUIStore.getState().rosterLoaded) {
      useUIStore.getState().setRosterLoaded(true);
    }
  }
}

function startInterval(): void {
  if (state.intervalHandle !== null) return;
  state.intervalHandle = window.setInterval(() => {
    void performFetch(state.activePlayerId);
  }, POLL_MS);
}

function stopInterval(): void {
  if (state.intervalHandle === null) return;
  window.clearInterval(state.intervalHandle);
  state.intervalHandle = null;
}

/**
 * Acquire a refcount on the roster poller. The first acquire starts the
 * 3 Hz polling interval and fires an immediate initial fetch. Subsequent
 * acquires only increment the count.
 *
 * If `playerId` differs from the currently-polled id, the loop restarts
 * with the new id (an immediate fetch + a fresh interval). This covers
 * the case of two panels with the same id (no restart) AND the case of
 * a logout/login flow where the id legitimately changes mid-session.
 */
export function acquireRosterPolling(playerId: string): void {
  state.refCount++;
  if (playerId !== state.activePlayerId) {
    state.activePlayerId = playerId;
    // Restart the interval so the new id is polled on the same cadence.
    stopInterval();
    startInterval();
    void performFetch(playerId);
  } else if (state.intervalHandle === null) {
    // First-ever acquire for this id.
    startInterval();
    void performFetch(playerId);
  }
  // Subsequent acquires with the same id: no-op (already polling).
}

/** Release one refcount. The last release stops the poll loop. */
export function releaseRosterPolling(): void {
  if (state.refCount <= 0) return; // defensive — release without acquire
  state.refCount--;
  if (state.refCount === 0) {
    stopInterval();
    state.activePlayerId = '';
  }
}

/** Force an immediate refresh. Used by the Abandon path which needs
 *  the next render to reflect the now-deleted ship. */
export function forceRefreshRoster(): Promise<void> {
  return performFetch(state.activePlayerId);
}
