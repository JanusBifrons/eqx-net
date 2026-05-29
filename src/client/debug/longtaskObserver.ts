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
 * plan: imperative-taco-r2 (evidence pass) — ALSO registers a Long
 * Animation Frame Timing (LoAF) observer when available. LoAF
 * supersedes longtask: instead of generic `[{containerType:"window"}]`
 * attribution, each entry exposes a `scripts[]` array with per-script
 * `executionStart`, `duration`, `sourceURL`, `sourceFunctionName`, plus
 * `renderStart` / `styleAndLayoutStart` breakdown. This converts the
 * "we don't know what blocked" theory of phone-side cascades into
 * direct evidence with named call frames. Available in Chrome 123+
 * (covers the capture device's Chrome 148). Older browsers fall back
 * to longtask-only.
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
import { recordLongtask } from './healthStats.js';

interface LongTaskAttributionTiming extends PerformanceEntry {
  containerType?: string;
  containerName?: string;
  containerSrc?: string;
  containerId?: string;
}

interface PerformanceLongTaskTiming extends PerformanceEntry {
  attribution?: LongTaskAttributionTiming[];
}

/** Long Animation Frame Timing API entry shape (Chrome 123+). The spec is
 *  https://w3c.github.io/long-animation-frame/ — each LoAF entry covers a
 *  single animation frame and exposes per-script timing for the scripts
 *  that ran during the frame. The `scripts[]` array is what makes this
 *  observer actually useful for naming a blocker. */
interface LoAFScriptEntry {
  /** Time the script started executing, ms since timeOrigin. */
  executionStart?: number;
  /** Time the script's invocation finished, ms since timeOrigin. */
  duration?: number;
  /** Forced style / layout the script triggered during its run. */
  forcedStyleAndLayoutDuration?: number;
  /** Original event-listener invocation time (for event-driven scripts). */
  startTime?: number;
  /** Name of the invoker (e.g. 'IntersectionObserver', 'EventListener', 'requestAnimationFrame'). */
  invoker?: string;
  /** Type discriminator the spec uses for the invoker. */
  invokerType?: string;
  /** Best-effort script function name. */
  sourceFunctionName?: string;
  /** Best-effort source URL. */
  sourceURL?: string;
  /** Best-effort line + column in sourceURL. */
  sourceCharPosition?: number;
}

interface PerformanceLongAnimationFrameTiming extends PerformanceEntry {
  /** Time the frame's blocking work started, ms since timeOrigin. */
  blockingDuration?: number;
  /** Time the render phase (paint/composite) of this frame started. */
  renderStart?: number;
  /** Time the style+layout phase started. */
  styleAndLayoutStart?: number;
  /** Per-script breakdown of what ran during this frame. */
  scripts?: LoAFScriptEntry[];
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
        const durationMs = Math.round(entry.duration * 100) / 100;
        logEvent('longtask', {
          startTime: Math.round(entry.startTime * 100) / 100,
          durationMs,
          name: entry.name,
          attribution,
        });
        // Paradigm plan (quirky-rabbit) Phase 6 — also feed the rolling
        // 30 s aggregator that the DevOverlay surfaces.
        recordLongtask(durationMs);
      }
    });
    observer.observe({ entryTypes: ['longtask'], buffered: true });
    installed = true;
    // plan: imperative-taco-r2 — also install a LoAF observer when
    // available. Same install latch guards re-entry; failure to install
    // LoAF is silent (browsers older than Chrome 123 fall back to
    // longtask-only). Returns true as long as the primary longtask
    // observer worked.
    installLoafObserver();
    return true;
  } catch {
    // Some browsers throw when the entry type is unsupported even
    // after the supportedEntryTypes guard (older Safari). Treat as
    // "not available" and move on.
    return false;
  }
}

/**
 * Install a Long Animation Frame Timing (LoAF) observer when available.
 * Emits `loaf` events whose data carries per-script call frames — the
 * actionable evidence that the generic `longtask` `[{containerType:"window"}]`
 * attribution doesn't surface.
 *
 * Caps `scripts[]` to the top-5 by duration. A single LoAF can fire on
 * a frame that ran tens of small scripts; the top-5 captures the bulk
 * cost without flooding the diag stream.
 */
function installLoafObserver(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes;
  if (supported && !supported.includes('long-animation-frame')) return;
  try {
    const loafObserver = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceLongAnimationFrameTiming;
        const scripts = (entry.scripts ?? [])
          .map((s) => ({
            duration: typeof s.duration === 'number' ? Math.round(s.duration * 100) / 100 : 0,
            invoker: s.invoker ?? null,
            invokerType: s.invokerType ?? null,
            sourceFunctionName: s.sourceFunctionName ?? null,
            sourceURL: s.sourceURL ?? null,
            forcedStyleAndLayoutDuration: typeof s.forcedStyleAndLayoutDuration === 'number'
              ? Math.round(s.forcedStyleAndLayoutDuration * 100) / 100
              : 0,
          }))
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 5);
        logEvent('loaf', {
          startTime: Math.round(entry.startTime * 100) / 100,
          durationMs: Math.round(entry.duration * 100) / 100,
          blockingDurationMs: typeof entry.blockingDuration === 'number'
            ? Math.round(entry.blockingDuration * 100) / 100
            : null,
          renderStart: typeof entry.renderStart === 'number'
            ? Math.round(entry.renderStart * 100) / 100
            : null,
          styleAndLayoutStart: typeof entry.styleAndLayoutStart === 'number'
            ? Math.round(entry.styleAndLayoutStart * 100) / 100
            : null,
          scriptCount: entry.scripts?.length ?? 0,
          topScripts: scripts,
        });
      }
    });
    loafObserver.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit);
  } catch {
    // Older Chrome / non-Chromium browsers don't accept the type; the
    // longtask observer above keeps providing the basic signal.
  }
}

/** Test-only: reset the install latch so tests can re-register. */
export function _resetLongtaskObserverForTests(): void {
  installed = false;
}
