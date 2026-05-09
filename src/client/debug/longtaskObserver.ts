/**
 * Mobile main-thread block detector.
 *
 * Diagnosed in cap `2026-05-09T07-23-39-893Z-651792`: a mobile capture
 * showed two ~500–600 ms client-receive gaps in the snapshot stream
 * while the server was emitting at perfect 20 Hz cadence. The deduced
 * cause is main-thread blocks on the mobile client — the server frames
 * arrive at the OS WebSocket buffer but the JS event loop can't drain
 * them. We needed evidence of *what* is blocking before we could fix it.
 *
 * The Performance API's `longtask` entry type is a free signal: any
 * task > 50 ms on the main thread is reported with a duration and
 * (limited) attribution. This module registers a single observer at
 * bootstrap and feeds each entry into the existing `logEvent` ring
 * buffer so it travels with diagnostic captures.
 *
 * Browser support: Chrome / Edge / Safari 18+. Firefox does not yet
 * implement `longtask`. When unsupported, registration silently no-ops
 * — the diag stream just won't contain longtask entries on those
 * browsers and we'll know to look elsewhere.
 *
 * Pure module — no side effects on import. Caller invokes
 * `installLongtaskObserver()` once.
 */
import { logEvent } from './ClientLogger.js';

interface LongTaskAttributionTiming extends PerformanceEntry {
  containerType?: string;
  containerName?: string;
  containerSrc?: string;
  containerId?: string;
}

interface PerformanceLongTaskTiming extends PerformanceEntry {
  attribution?: LongTaskAttributionTiming[];
}

/** Browsers report longtasks at a 50 ms threshold by default. We don't
 *  re-filter — every entry is interesting on a low-end mobile device. */

let installed = false;

/**
 * Register a `PerformanceObserver` for `longtask` entries. Idempotent —
 * calling more than once is a no-op (the second call would create a
 * duplicate observer and double-log every block). Returns whether the
 * observer was successfully installed.
 */
export function installLongtaskObserver(): boolean {
  if (installed) return true;
  if (typeof PerformanceObserver === 'undefined') return false;
  // Older browsers may have PerformanceObserver but not the longtask
  // entry type. `supportedEntryTypes` is the safe feature check.
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes;
  if (supported && !supported.includes('longtask')) return false;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceLongTaskTiming;
        // Attribution is best-effort — cross-origin iframes return
        // `containerType: 'iframe'` with the rest blanked. Capture
        // what we can; the diag analyser falls back to "no attribution"
        // when the array is empty.
        const attribution = (entry.attribution ?? []).map((a) => ({
          containerType: a.containerType ?? null,
          containerName: a.containerName ?? null,
          containerSrc: a.containerSrc ?? null,
        }));
        logEvent('longtask', {
          startTime: Math.round(entry.startTime * 100) / 100,
          durationMs: Math.round(entry.duration * 100) / 100,
          name: entry.name,
          attribution,
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'], buffered: true });
    installed = true;
    return true;
  } catch {
    // Some browsers throw when the entry type is unsupported even
    // after the supportedEntryTypes guard (older Safari). Treat as
    // "not available" and move on.
    return false;
  }
}

/** Test-only: reset the install latch so tests can re-register. */
export function _resetLongtaskObserverForTests(): void {
  installed = false;
}
