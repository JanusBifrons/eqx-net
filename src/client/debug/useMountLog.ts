import { useEffect, useRef } from 'react';
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
 * `extra` is captured by **ref** (not by value as an effect dep) so
 * passing a fresh object literal every render doesn't trigger a fake
 * remount cycle each render. The effect runs exactly once per real
 * mount (twice in StrictMode dev), and `extra` reflects the value at
 * the moment the effect fires.
 */
export function useMountLog(name: string, extra?: Record<string, unknown>): void {
  const extraRef = useRef(extra);
  extraRef.current = extra;
  useEffect(() => {
    logEvent('component_mount', { name, ...(extraRef.current ?? {}) });
    return () => logEvent('component_unmount', { name });
  }, [name]);
}
