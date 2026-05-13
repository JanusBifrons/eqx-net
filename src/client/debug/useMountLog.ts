import { useEffect } from 'react';
import { logEvent } from './ClientLogger.js';

/**
 * Per-component mount/unmount diagnostic logger (2026-05-13).
 *
 * Drops `component_mount` and `component_unmount` events into the
 * client log ring buffer so the diagnostic capture surfaces "UI
 * remounted unexpectedly" / "screen never appeared" failure modes
 * that smoke-tests alone miss.
 *
 * React's StrictMode in dev double-invokes every effect on mount, so
 * **expect to see two `component_mount` + one intervening
 * `component_unmount` per top-level screen** when running the dev
 * server. That's a baseline, not a bug — but a third unexpected
 * remount cycle on the same component during a single session IS a
 * signal.
 *
 * The hook is a single `useEffect` with an empty dep array — same
 * cost shape as the existing `installWindowLogger` call. Per-event
 * payload is tiny (~80 bytes). Suitable to drop into any top-level
 * screen component without measurable perf impact.
 */
export function useMountLog(name: string, extra?: Record<string, unknown>): void {
  useEffect(() => {
    logEvent('component_mount', { name, ...(extra ?? {}) });
    return () => logEvent('component_unmount', { name });
  }, [name, extra]);
}
