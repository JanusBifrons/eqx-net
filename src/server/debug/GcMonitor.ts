/**
 * Process-wide V8 GC pause monitor.
 *
 * Emits a `gc_pause` server-event whenever a GC entry exceeds
 * GC_PAUSE_THRESHOLD_MS. Diagnostic purpose only — used to confirm or
 * refute the "tick_hitch is GC-induced" hypothesis. Cross-reference
 * `gc_pause` timestamps with `tick_hitch` timestamps in a captured
 * diagnostic; correlation within ~10 ms confirms the GC theory and
 * makes allocation-reduction fixes a priority.
 *
 * Node's `PerformanceObserver` for type `gc` is process-wide — install
 * exactly once at server boot from `index.ts main()`. The observer
 * itself does not allocate per GC; the cost is one comparison per GC
 * entry against the threshold and (rarely) one `serverLogEvent` push.
 *
 * GC `kind` values from `perf_hooks` (NodePerformanceGCEntry):
 *   1 = Scavenge / minor   (most common, fast — usually < 1 ms)
 *   2 = Mark-sweep-compact (major, can pause 5–50 ms on a busy heap)
 *   4 = Incremental marking (concurrent, but the JS-thread slice is reported)
 *   8 = Weak callbacks
 */
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { serverLogEvent } from './ServerEventLog.js';

/** Pauses below this threshold are noise (most minor GCs are < 1 ms).
 *  Above this, the pause has a chance of stalling a 16.67 ms physics
 *  budget on whichever phase is currently executing. */
const GC_PAUSE_THRESHOLD_MS = 5;

let installed = false;

/**
 * Subscriber surface for clients that want a live `gc_pause` feed (the
 * paradigm-plan Phase 6 client diagnostic surface uses this — each
 * `SectorRoom` registers in `onCreate` and broadcasts the event to its
 * own clients).
 *
 * Subscribers are called synchronously inside the `PerformanceObserver`
 * callback. Keep them cheap; the observer fires on the JS-thread GC
 * tail and a slow subscriber is added directly to the pause we just
 * measured. The room broadcast path satisfies this by design — it
 * enqueues the message into the WebSocket buffer and returns.
 *
 * The subscriber set is module-scoped, not per-monitor — there is only
 * one GC monitor per process, mirroring `GC` itself.
 */
export interface GcPauseEvent {
  /** Pause duration in ms, rounded to 3 decimals. */
  readonly durationMs: number;
  /** Human-readable GC kind. Same labels `serverLogEvent('gc_pause')`
   *  emits — 'scavenge', 'mark-sweep-compact', 'incremental', 'weakcb',
   *  'mixed:<bits>', or 'unknown'. */
  readonly kind: string;
}
type GcPauseSubscriber = (event: GcPauseEvent) => void;
const gcSubscribers = new Set<GcPauseSubscriber>();

export function subscribeGcPause(fn: GcPauseSubscriber): void {
  gcSubscribers.add(fn);
}

export function unsubscribeGcPause(fn: GcPauseSubscriber): void {
  gcSubscribers.delete(fn);
}

/** Test-only: drop every subscriber. */
export function _resetGcPauseSubscribersForTests(): void {
  gcSubscribers.clear();
}

interface NodeGcEntry extends PerformanceEntry {
  /** Bitfield: 1=scavenge, 2=mark-sweep-compact, 4=incremental, 8=weakcb */
  readonly kind?: number;
  /** Reason for the GC — Node 16+ supplies this as a structured detail. */
  readonly detail?: { kind?: number; flags?: number };
}

/** Map a Node GC kind bitfield to a human-readable label for the event
 *  payload. Falls back to the raw number if the kind is unrecognised
 *  (Node's bit values are stable but new ones can appear). */
function kindLabel(kind: number | undefined): string {
  if (kind === undefined) return 'unknown';
  if (kind === 1) return 'scavenge';
  if (kind === 2) return 'mark-sweep-compact';
  if (kind === 4) return 'incremental';
  if (kind === 8) return 'weakcb';
  return `mixed:${kind}`;
}

/** Install the GC pause observer. Idempotent. Safe to call from
 *  bootstrap; cheap (single-process global). */
export function installGcMonitor(): void {
  if (installed) return;
  installed = true;
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as NodeGcEntry[]) {
      if (entry.duration < GC_PAUSE_THRESHOLD_MS) continue;
      const kind = entry.kind ?? entry.detail?.kind;
      const durationMs = parseFloat(entry.duration.toFixed(3));
      const kindStr = kindLabel(kind);
      serverLogEvent('gc_pause', {
        durationMs,
        kind: kindStr,
        kindBits: kind,
        // startTime is from process performance.now(). tick_hitch
        // events carry the same clock implicitly via Date.now() in
        // serverLogEvent's ts field. Diagnostic consumers correlate
        // by comparing nearby timestamps within ~10 ms.
        startTime: parseFloat(entry.startTime.toFixed(3)),
      });
      // Fan out to subscribers (paradigm plan: quirky-rabbit, Phase 6 —
      // SectorRoom registers a broadcaster). Synchronous; subscribers
      // must be cheap (just enqueue into a wire buffer).
      if (gcSubscribers.size > 0) {
        const evt: GcPauseEvent = { durationMs, kind: kindStr };
        for (const fn of gcSubscribers) {
          try { fn(evt); } catch { /* swallow — never throw from the GC observer */ }
        }
      }
    }
  });
  // `gc` is the entry type for V8 GC stats. `buffered: true` flushes
  // any GC entries that fired before observe() returned so we don't
  // miss boot-time GCs.
  obs.observe({ entryTypes: ['gc'], buffered: true });
}
