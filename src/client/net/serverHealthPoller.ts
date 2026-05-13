import { HealthResponseSchema, type HealthResponse } from '../../shared-types/serverHealth.js';

/**
 * Server-health poller for the pre-game UI gate (2026-05-13).
 *
 * Polls `GET /healthz` on an adaptive interval — faster while
 * unreachable so the player sees the banner clear within ~2 s of the
 * server coming back, slower while healthy so we don't spam the
 * endpoint in steady state.
 *
 * Pure factory — no React, no Zustand, no MUI. Tests construct it with
 * a fake `fetchImpl` + fake `setTimeoutImpl` to drive deterministic
 * transitions. Production code wires the browser's `fetch` and
 * `window.setTimeout` at the call site.
 *
 * The factory returns `start()` / `stop()` — calling `start` more than
 * once or `stop` without a prior `start` is a no-op (idempotent), so a
 * React effect that mounts + unmounts under StrictMode doesn't break.
 */

export type HealthState = 'unknown' | 'healthy' | 'unreachable';

export interface HealthSnapshot {
  state: HealthState;
  /** Last successful parsed response. Cleared when the state goes
   *  `unreachable`, so consumers don't show a stale `playersOnline`
   *  while the banner says "offline". */
  data: HealthResponse | null;
}

export interface ServerHealthPollerOpts {
  /** Where to fetch. Usually `'/healthz'` — relative paths land on
   *  the same origin in dev (Vite proxies) and prod. */
  url: string;
  /** Called once on every transition AND once on each poll regardless
   *  (so a consumer can refresh `playersOnline` without a state
   *  change). The consumer is responsible for diff-ing snapshots if
   *  it wants to suppress no-op work. */
  onChange: (snapshot: HealthSnapshot) => void;
  /** Override for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override for tests. Defaults to `window.setTimeout`. */
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Poll interval when the last response was healthy. */
  healthyIntervalMs?: number;
  /** Poll interval when the last attempt failed. */
  unreachableIntervalMs?: number;
  /** Per-attempt fetch timeout. Distinct from the poll interval —
   *  if the server hangs for longer than this we abort and treat the
   *  attempt as unreachable. */
  fetchTimeoutMs?: number;
}

export interface ServerHealthPoller {
  start(): void;
  stop(): void;
}

const DEFAULT_HEALTHY_INTERVAL_MS = 8_000;
const DEFAULT_UNREACHABLE_INTERVAL_MS = 2_000;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

export function createServerHealthPoller(opts: ServerHealthPollerOpts): ServerHealthPoller {
  const {
    url,
    onChange,
    fetchImpl = fetch,
    setTimeoutImpl = ((cb: () => void, ms: number) => setTimeout(cb, ms)) as typeof setTimeout,
    clearTimeoutImpl = (h) => clearTimeout(h),
    healthyIntervalMs = DEFAULT_HEALTHY_INTERVAL_MS,
    unreachableIntervalMs = DEFAULT_UNREACHABLE_INTERVAL_MS,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  } = opts;

  let running = false;
  let pendingHandle: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (!running) return;
    pendingHandle = setTimeoutImpl(() => { void poll(); }, delayMs);
  };

  const poll = async (): Promise<void> => {
    if (!running) return;
    pendingHandle = null;

    const controller = new AbortController();
    const timeoutHandle = setTimeoutImpl(() => controller.abort(), fetchTimeoutMs);

    let snapshot: HealthSnapshot = { state: 'unreachable', data: null };
    try {
      const res = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
      clearTimeoutImpl(timeoutHandle);
      if (res.ok) {
        const json: unknown = await res.json();
        const parsed = HealthResponseSchema.safeParse(json);
        if (parsed.success) {
          snapshot = { state: 'healthy', data: parsed.data };
        }
      }
    } catch {
      clearTimeoutImpl(timeoutHandle);
      // network error / abort — fall through to 'unreachable'
    }

    if (!running) return;
    onChange(snapshot);

    const nextDelay = snapshot.state === 'healthy' ? healthyIntervalMs : unreachableIntervalMs;
    scheduleNext(nextDelay);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      void poll();
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (pendingHandle !== null) {
        clearTimeoutImpl(pendingHandle);
        pendingHandle = null;
      }
    },
  };
}
