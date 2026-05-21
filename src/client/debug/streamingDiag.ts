/**
 * Streaming diagnostic capture — Phase 0 measurement stub.
 *
 * Plan: streaming auto-capture, Phase 0 (2026-05-21). The full plan
 * lives in `C:\Users\alecv\.claude\plans\i-d-like-you-to-zany-narwhal.md`.
 *
 * Phase 0's question: does the network + JS overhead of a continuous
 * streaming POST every CADENCE_MS perturb the netcode metrics this
 * project is built to measure? Until we answer that, the rest of the
 * plan is unsafe to ship.
 *
 * This Phase 0 stub:
 *   - is a no-op unless `?autocapture=1` is set
 *   - when on, every CADENCE_MS POSTs the new ring entries (since the
 *     last successful POST) to `/diag/capture/stream`
 *   - server-side stub accepts + discards (no persistence yet)
 *
 * What this stub deliberately does NOT have yet (deferred to Phase 3):
 *   - pagehide / visibilitychange / beforeunload triggers
 *   - sendBeacon final-flush
 *   - one-in-flight POST lock (best-effort skip via _inFlight latch)
 *   - 404 fail-stop
 *   - bounded pending buffer with oldest-drop overflow + warn event
 *
 * Those land in Phase 3 once Phase 0's measurement validates the
 * cadence + payload shape.
 */
import { isAutoCaptureEnabled, getRingEntries } from './ClientLogger.js';

/** Cadence — chosen as v1 default in plan; subject to Phase 0 finding. */
const CADENCE_MS = 2_000;

let _sessionId: string | null = null;
let _batchSeq = 0;
let _entriesAlreadySent = 0;
let _inFlight = false;
let _disabled = false;
let _timer: ReturnType<typeof setInterval> | null = null;

function makeSessionId(): string {
  // Mirror the manual-capture id format (`<ISO timestamp>-<random>`)
  // so streaming sessions sort naturally alongside manual ones in
  // `diag/captures/`.
  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

async function flushPendingBatch(): Promise<void> {
  if (!_sessionId || _disabled) return;
  if (_inFlight) return; // already sending; this tick will be picked up next time
  const ring = getRingEntries();
  const newEntries = ring.slice(_entriesAlreadySent);
  if (newEntries.length === 0) return;

  _inFlight = true;
  const seq = _batchSeq;
  // First-batch metadata
  const firstBatch = seq === 0;
  try {
    const res = await fetch('/diag/capture/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: _sessionId,
        batchSeq: seq,
        entries: newEntries.slice(0, 5_000), // cap matching the future server schema
        ...(firstBatch
          ? {
              userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
              viewport: typeof window !== 'undefined'
                ? { w: window.innerWidth, h: window.innerHeight }
                : { w: 0, h: 0 },
              clientEpochMs: Date.now(),
            }
          : {}),
      }),
    });
    if (res.status === 404) {
      // Future: production lands here. Disable streaming permanently
      // for this session and stop the timer.
      _disabled = true;
      if (_timer) clearInterval(_timer);
      _timer = null;
      // eslint-disable-next-line no-console
      console.warn('[streamingDiag] /diag/capture/stream returned 404; streaming disabled for this session');
      return;
    }
    if (!res.ok) {
      // Transient error — leave pending entries in place, retry next tick.
      return;
    }
    _entriesAlreadySent += newEntries.length;
    _batchSeq++;
  } catch {
    // Network error — same as transient error path. Retry next tick.
  } finally {
    _inFlight = false;
  }
}

/**
 * Install the streaming diagnostic loop. No-op unless `?autocapture=1`.
 * Call from the same site as `installWindowLogger()` so streaming
 * captures pre-game events (auth / galaxy map / ship picker), not just
 * post-join events.
 */
export function installStreamingDiag(): void {
  if (!isAutoCaptureEnabled()) return;
  if (_timer !== null) return; // already installed
  _sessionId = makeSessionId();
  _entriesAlreadySent = 0;
  _batchSeq = 0;
  _disabled = false;
  _timer = setInterval(() => {
    flushPendingBatch().catch(() => {});
  }, CADENCE_MS);
  // eslint-disable-next-line no-console
  console.log(`[streamingDiag] streaming enabled, sessionId=${_sessionId}, cadence=${CADENCE_MS}ms`);
}

/**
 * Read-only accessor — exposed for tests + for future Phase 4
 * (`captureDiagnostic` short-circuit).
 */
export function getStreamingSessionId(): string | null {
  return _sessionId;
}
