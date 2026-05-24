/**
 * Streaming diagnostic capture — `?autocapture=1`.
 *
 * Plan: streaming auto-capture, Phase 3 (2026-05-21).
 *
 * What this is:
 *   - A continuous background flush of ring entries to
 *     `POST /diag/capture/stream` every CADENCE_MS, so a smoke-test
 *     capture is on-disk before the user even hits "Capture" (and is
 *     resilient to client crashes / OS-reaped tabs).
 *   - No-op unless `?autocapture=1` (zero cost on normal sessions).
 *
 * Robustness (Phase 3 hardening, per hostile-review findings):
 *   - One-in-flight POST lock: prevents stacked concurrent batches if
 *     the server is slow (would otherwise produce duplicate batchSeq
 *     requests).
 *   - Multi-trigger final flush: visibilitychange + pagehide +
 *     beforeunload, in mobile-priority order. Calls
 *     `navigator.sendBeacon()` for the tab-tear-down case (works in
 *     more contexts than fetch).
 *   - sendBeacon 32 KB cap: Chromium silently rejects > 64 KB beacons.
 *     We cap WELL below that and emit `streaming_truncated_final` if
 *     the cap engages.
 *   - 404 fail-stop: if the endpoint is unmounted (e.g., production),
 *     disable streaming permanently for this session after the first
 *     404 so we don't infinite-loop on broken fetch.
 *   - Pending buffer overflow + per-entry sequence: handled in
 *     `ClientLogger.ts`'s `drainPendingStream()`.
 *
 * Bootstrap: `installStreamingDiag()` is called alongside
 * `installWindowLogger()` at module top-level in `App.tsx`. Fires
 * before the React tree mounts so streaming captures EVERY logEvent
 * from boot through tear-down (pre-game UI events too — auth, galaxy
 * map, ship picker).
 */
import { isAutoCaptureEnabled, drainPendingStream, logEvent, type LogEntry } from './ClientLogger.js';

/** Cadence — Phase 0 measurement validated 2_000 as not perturbing
 *  prediction-state metrics under IDLE scenario. Subject to future
 *  measurement under more scenarios. */
const CADENCE_MS = 2_000;

/** sendBeacon hard cap. Chromium rejects > 64 KB silently; we stay
 *  well under so headers + JSON overhead don't push us over. */
const BEACON_MAX_BYTES = 32_768;

let _sessionId: string | null = null;
let _batchSeq = 0;
let _inFlight = false;
let _disabled = false;
let _timer: ReturnType<typeof setInterval> | null = null;
let _flushedFinal = false; // guards against multiple final beacons

function makeSessionId(): string {
  // Mirror the manual-capture id format (`<ISO timestamp>-<random>`)
  // so streaming sessions sort naturally alongside manual ones.
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

interface BatchBody {
  sessionId: string;
  batchSeq: number;
  final?: boolean;
  userAgent?: string;
  viewport?: { w: number; h: number };
  clientEpochMs?: number;
  entries: readonly LogEntry[];
}

function buildBatchBody(entries: readonly LogEntry[], final: boolean): BatchBody {
  const firstBatch = _batchSeq === 0;
  return {
    sessionId: _sessionId!,
    batchSeq: _batchSeq,
    ...(final ? { final: true } : {}),
    entries,
    ...(firstBatch
      ? {
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
          viewport:
            typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : { w: 0, h: 0 },
          clientEpochMs: Date.now(),
        }
      : {}),
  };
}

/**
 * Async flush via fetch. Returns true on success (or on a transient
 * failure where the buffer was already drained — in either case the
 * next interval picks up). False on 404 (permanent fail-stop) only.
 */
async function flushFetch(): Promise<void> {
  if (!_sessionId || _disabled || _inFlight) return;
  const pending = drainPendingStream();
  if (pending.length === 0) return;

  _inFlight = true;
  const body = buildBatchBody(pending, false);
  try {
    const res = await fetch('/diag/capture/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      _disabled = true;
      if (_timer) clearInterval(_timer);
      _timer = null;
      logEvent('streaming_unavailable', { reason: '404', batchSeq: _batchSeq });
      // eslint-disable-next-line no-console
      console.warn('[streamingDiag] /diag/capture/stream returned 404 — streaming disabled for this session');
      return;
    }
    if (res.status === 409) {
      // Server already applied this seq (duplicate retry). Bump our
      // seq forward and continue — the entries we just sent were
      // accepted by an earlier in-flight POST that timed out at the
      // client.
      _batchSeq++;
      return;
    }
    if (!res.ok) {
      // Transient error — entries are already drained and lost from
      // the pending buffer, but they remain in the main ring (manual
      // Capture fallback). The next interval will send fresh entries.
      // Plan accepts this trade-off.
      return;
    }
    _batchSeq++;
  } catch {
    // Network error / abort. Same as transient — drained entries are
    // lost to streaming but stay in the ring.
  } finally {
    _inFlight = false;
  }
}

/**
 * Synchronous-ish final flush via `navigator.sendBeacon()`. Fires on
 * page-hide / tab-close / beforeunload. Best-effort — sendBeacon
 * returns immediately and the browser handles delivery in the
 * background as the tab dies. Cross-browser more reliable than fetch
 * during unload, especially on mobile.
 */
function flushFinalBeacon(): void {
  if (!_sessionId || _disabled || _flushedFinal) return;
  _flushedFinal = true;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;

  const pending = drainPendingStream();
  if (pending.length === 0) return;

  // Cap the entries array so the serialised body stays well under the
  // 64 KB beacon ceiling. Keep the FRESHEST entries (those closest to
  // the crash moment) — drop oldest.
  let kept: LogEntry[] = pending.slice();
  let body = buildBatchBody(kept, true);
  let serialised = JSON.stringify(body);
  if (serialised.length > BEACON_MAX_BYTES) {
    // Binary search-ish reduction. ~200 bytes/entry typical → halve.
    let droppedFromHead = 0;
    while (serialised.length > BEACON_MAX_BYTES && kept.length > 100) {
      const half = Math.floor(kept.length / 2);
      droppedFromHead += half;
      kept = kept.slice(half);
      body = buildBatchBody(kept, true);
      serialised = JSON.stringify(body);
    }
    if (droppedFromHead > 0) {
      // Prepend a marker so the resulting capture's ndjson shows the
      // truncation event. (One last logEvent so it lands in the ring;
      // the beacon body itself ALREADY EXCLUDES it because we already
      // drained.)
      logEvent('streaming_truncated_final', {
        droppedFromHead,
        keptCount: kept.length,
        cap: BEACON_MAX_BYTES,
      });
    }
  }

  // sendBeacon Blob is more cross-browser than raw string for some
  // setups; both work in Chromium.
  const blob = new Blob([serialised], { type: 'application/json' });
  const sent = navigator.sendBeacon('/diag/capture/stream', blob);
  if (!sent) {
    // eslint-disable-next-line no-console
    console.warn('[streamingDiag] sendBeacon returned false — final batch may not have been queued');
  }
  _batchSeq++;
}

/**
 * Install the streaming diagnostic loop. No-op unless `?autocapture=1`.
 *
 * Call from `App.tsx` (module top-level, alongside
 * `installWindowLogger()`) so streaming captures the FULL session
 * including pre-game events (auth / galaxy map / ship picker).
 */
export function installStreamingDiag(): void {
  if (!isAutoCaptureEnabled()) return;
  if (_timer !== null) return; // already installed
  _sessionId = makeSessionId();
  _batchSeq = 0;
  _disabled = false;
  _flushedFinal = false;

  _timer = setInterval(() => {
    flushFetch().catch(() => {
      /* errors handled inside flushFetch */
    });
  }, CADENCE_MS);

  if (typeof document !== 'undefined') {
    // PRIMARY (mobile-reliable): visibilitychange fires on iOS swipe-
    // kill, Android tab-discard, tab-switch, OS reap. Most reliable
    // signal that the page is going away.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushFinalBeacon();
    });
  }
  if (typeof window !== 'undefined') {
    // SECONDARY (Safari pagehide): explicit page-hide event. Some
    // browsers fire this but not visibilitychange first; idempotent
    // safe (the _flushedFinal latch).
    window.addEventListener('pagehide', () => flushFinalBeacon());
    // TERTIARY (desktop): beforeunload, fires on clean close.
    window.addEventListener('beforeunload', () => flushFinalBeacon());
  }

  // eslint-disable-next-line no-console
  console.log(
    `[streamingDiag] streaming enabled, sessionId=${_sessionId}, cadence=${CADENCE_MS}ms, ` +
      'triggers=[visibilitychange, pagehide, beforeunload]',
  );
}

/**
 * Read-only accessor — exposed for tests + for the Phase 4
 * `captureDiagnostic` short-circuit.
 */
export function getStreamingSessionId(): string | null {
  return _sessionId;
}
