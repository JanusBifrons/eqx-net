/**
 * Structured event ring buffer accessible from browser devtools and Playwright tests.
 *
 * Usage in tests:
 *   const logs = await page.evaluate(() => window.__eqxLogs);
 *   const corrections = logs.filter(e => e.tag === 'snapshot' && e.data.driftUnits > 0.05);
 *
 * Usage in devtools:
 *   window.__eqxLogs          // inspect entries
 *   window.__eqxClearLogs()   // reset
 */

// 2026-05-21: 8000 → 25000 for the replay-infrastructure plan
// (i-d-like-you-to-zany-narwhal.md, Phase A). On TOP of the existing
// in-combat ~450/s event rate, captures now ALSO carry the replay-
// grade ground-truth + input-intent streams:
//   - `local_pose_rendered` per RAF (~60/s)
//   - `local_pose_predicted` per inner tick (~60-240/s under catch-up)
//   - `input_intent` per inner tick (~60-240/s)
//   - `rafTick` is now unsampled (was every 6th, now every RAF — +50/s)
// Total steady-state on phone: ~750/s. 25000 entries ≈ ~33 s of
// in-combat history at the worst combat case, much longer under calm.
// 30-second phone smoke sessions need to retain the whole window for
// deterministic replay; 8000 only spanned ~10 s at the new rate.
//
// Earlier history (the 2000-/8000-entry rings):
// "2000-entry ring keeps ~20 s of per-frame events… 2026-05-17:
// 2000 → 8000 because the in-combat event rate (~450/s, dominated by
// per-drone `swarm_snap_diagnostics`) only spanned ~5 s at 2000, so
// sparse INTERMITTENT network-bunching spikes routinely rotated out
// before the user could hit Capture."
//
// Cost trade-off: ~25000 small objects/tab — acceptable dev-stage cost,
// trivially revertable pre-release. The new ground-truth/input streams
// are what enable the smoke-test → capture → deterministic replay loop.
const PROD_MAX_ENTRIES = 25000;
// Diagnostic sessions (`?diag=1` / WebDriver — see `isDiagEnabled`) add
// the F1 per-frame sub-cost markers + the F-transit `transit_mark` /
// `transit_frame` rows on top of the steady spam. Combined with the
// replay-grade ground-truth tags added 2026-05-21, the steady-state
// rate under diag is ~1000-1200 ev/s; 60000 retains ~50 s of history.
// ZERO production cost — only used when `?diag=1` / WebDriver.
const DIAG_MAX_ENTRIES = 60000;

export interface LogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

const entries: LogEntry[] = [];

// Resolved once on first `logEvent`. `isDiagEnabled()` is cached and the
// URL/WebDriver state is fixed for the document's lifetime, so the cap
// cannot change mid-session. Lazy (not module-init) so it is robust to
// `logEvent` firing before `installWindowLogger()`. `isDiagEnabled` is a
// hoisted function declaration below — safe to call from here at runtime.
let _maxEntries = -1;

/**
 * Pending-stream buffer — Phase 3 of the streaming auto-capture plan.
 *
 * When `?autocapture=1` is set, every `logEvent` also pushes into this
 * buffer, which is drained by `streamingDiag.ts`'s timer every
 * CADENCE_MS. Kept separate from the main `entries` ring so:
 *   - The main ring stays available for manual Capture / devtools
 *     inspection at all times.
 *   - The streaming buffer drains independently of the ring's FIFO
 *     eviction (we never lose unsent entries to ring rotation).
 *
 * Cap: 5_000 entries (matches the server-side schema cap). On overflow,
 * oldest is dropped + a one-time `streaming_dropped` marker is pushed
 * into both the ring AND the pending buffer so the loss is visible in
 * any downstream capture.
 */
const PENDING_STREAM_MAX = 5_000;
const _pendingStreamBuffer: LogEntry[] = [];
let _streamingDroppedFirstAt: number | null = null;

export function logEvent(tag: string, data: Record<string, unknown>): void {
  if (_maxEntries < 0) {
    _maxEntries = isDiagEnabled() ? DIAG_MAX_ENTRIES : PROD_MAX_ENTRIES;
  }
  const entry: LogEntry = { ts: performance.now(), tag, data };
  entries.push(entry);
  if (entries.length > _maxEntries) entries.shift();

  // Phase 3 streaming hook — gated by isAutoCaptureEnabled() so normal
  // sessions pay zero cost. The check is a single cached boolean read.
  if (isAutoCaptureEnabled()) {
    _pendingStreamBuffer.push(entry);
    if (_pendingStreamBuffer.length > PENDING_STREAM_MAX) {
      _pendingStreamBuffer.shift();
      if (_streamingDroppedFirstAt === null) {
        _streamingDroppedFirstAt = entry.ts;
        const droppedMarker: LogEntry = {
          ts: entry.ts,
          tag: 'streaming_dropped',
          data: { firstDroppedAt: _streamingDroppedFirstAt, max: PENDING_STREAM_MAX },
        };
        // Push into both surfaces so it's visible in any capture variant.
        entries.push(droppedMarker);
        if (entries.length > _maxEntries) entries.shift();
        _pendingStreamBuffer.push(droppedMarker);
        // eslint-disable-next-line no-console
        console.warn(`[ClientLogger] streaming pending buffer overflow — events dropped from ${entry.ts}`);
      }
    }
  }
}

/**
 * Drain + return the current pending-stream buffer. Streaming module
 * calls this every CADENCE_MS. The buffer is cleared atomically (the
 * splice returns the old array, the new one starts empty).
 *
 * Pattern is "drain, send, on-success drop". If the send fails, the
 * caller is responsible for retrying — the buffer is already empty by
 * then. (The plan accepts this: a failed send loses up to one
 * cadence's worth of events; the next batch picks up from there. The
 * trade-off is simpler than re-queueing on failure, and the dropped
 * events are still in the main ring for manual Capture as fallback.)
 */
export function drainPendingStream(): readonly LogEntry[] {
  const drained = _pendingStreamBuffer.slice();
  _pendingStreamBuffer.length = 0;
  return drained;
}

/**
 * Diagnostic-mode flag (F1 of the warp-spool perf investigation — see
 * `docs/HANDOFF-warp-spool-perf-followup.md`).
 *
 * Precedence (highest first):
 *   1. `?diag=0` — explicit opt-out, wins over EVERYTHING incl. the
 *      webdriver auto-enable. The ONLY way an E2E / perf gate can
 *      measure the *production* code path (the netcode-health gate
 *      depends on this — Playwright always sets `navigator.webdriver`,
 *      so without this escape every spec measures an instrumented build
 *      no real player runs).
 *   2. `navigator.webdriver` — Playwright / any WebDriver-controlled
 *      session (so E2E + `/diag/capture` get the markers by default).
 *   3. `?diag=1` — explicit opt-in on a normal browser session.
 *   4. otherwise off — **zero cost on a normal player session**.
 *
 * This gates ONLY the *new* expensive diagnostic work that F1 adds:
 *   - the worker's `FRAME_MARKERS` postMessage (via `SET_DIAG_MARKERS`),
 *   - `WorkerRendererClient`'s `mirror_clone` `JSON.stringify(mirror)`,
 *   - `ColyseusClient`'s `mirror_rebuild` bracket.
 *
 * It deliberately does **NOT** gate `logEvent` itself — the existing
 * always-on producers (`rafTick`, `snapshot`, `correction`, …) and the
 * E2E consumers of `window.__eqxLogs` must keep working unchanged. A
 * blanket gate would regress every spec that reads the ring.
 *
 * Cached at first read; the URL/webdriver state is fixed for the
 * document's lifetime so re-evaluating per frame would be waste. Tests
 * and the netcode-health gate flip `?diag` between harness arms — they
 * call `__resetDiagCache()` to drop the cache (production never does).
 */
let _diagEnabled: boolean | null = null;
export function isDiagEnabled(): boolean {
  if (_diagEnabled !== null) return _diagEnabled;
  let enabled = false;
  try {
    const q =
      typeof window !== 'undefined' && window.location?.search
        ? new URLSearchParams(window.location.search).get('diag')
        : null;
    if (q === '0') {
      // Explicit opt-out wins over the webdriver auto-enable.
      enabled = false;
    } else if (typeof navigator !== 'undefined' && navigator.webdriver === true) {
      enabled = true;
    } else if (q === '1') {
      enabled = true;
    }
  } catch {
    // Defensive: no URL/navigator (non-browser context) ⇒ stay off.
    enabled = false;
  }
  _diagEnabled = enabled;
  return enabled;
}

/**
 * Streaming auto-capture mode — `?autocapture=1`. Mirror of the
 * `isDiagEnabled()` predicate above, distinct latch + window flag.
 *
 * Background (plan: streaming auto-capture, Phase 1, 2026-05-21): the
 * plan adds a continuous diagnostic-streaming mode to remove the manual
 * Capture step + survive client crashes. The whole concern from the
 * hostile review is that streaming-time network + main-thread overhead
 * could perturb the netcode metrics the captures are designed to
 * measure. The netcode-gate (`tests/e2e/netcode-health.spec.ts`) needs
 * a symmetric way to assert "streaming is OFF on this rep" so a future
 * accidental `?autocapture=1` leak doesn't silently turn the gate's
 * measurement into a different program.
 *
 * Precedence is simpler than `?diag` — `?autocapture=1` enables
 * streaming, anything else (absent / =0) disables. WebDriver does NOT
 * auto-enable: streaming is opt-in only, never automatic.
 */
let _autoCaptureEnabled: boolean | null = null;
export function isAutoCaptureEnabled(): boolean {
  if (_autoCaptureEnabled !== null) return _autoCaptureEnabled;
  let enabled = false;
  try {
    const q =
      typeof window !== 'undefined' && window.location?.search
        ? new URLSearchParams(window.location.search).get('autocapture')
        : null;
    enabled = q === '1';
  } catch {
    enabled = false;
  }
  _autoCaptureEnabled = enabled;
  return enabled;
}

/**
 * Test / netcode-gate-only: clear ALL cached latches so the next
 * `isDiagEnabled()` / `isAutoCaptureEnabled()` / `logEvent()` re-
 * resolves against the current environment. Production never calls
 * this (URL/webdriver are fixed for the document lifetime). Resets
 * `_diagEnabled` (the predicate), `_maxEntries` (the ring-size latch),
 * AND `_autoCaptureEnabled` (the streaming latch — must reset together
 * with `_diagEnabled` or a harness that flips both params between arms
 * keeps stale state).
 */
export function __resetDiagCache(): void {
  _diagEnabled = null;
  _maxEntries = -1;
  _autoCaptureEnabled = null;
}

/**
 * Read-only accessor for the ring (plan: perf-floor, Phase 1). Returns
 * the live array — the perfStats helpers do their own filtering by tag
 * + timestamp window. Same reference `window.__eqxLogs` points at, so
 * the consumer pays zero copy cost. Treat as `readonly`.
 */
export function getRingEntries(): readonly LogEntry[] {
  return entries;
}

export function installWindowLogger(): void {
  const w = window as unknown as Record<string, unknown>;
  w['__eqxLogs'] = entries;
  w['__eqxEpoch'] = Date.now(); // wall-clock epoch; correlate with server timestamps via epoch + log.ts
  w['__eqxClearLogs'] = (): void => { entries.splice(0); };
  // Expose the resolved diag flag so devtools / E2E can confirm markers
  // are active without re-deriving the predicate.
  w['__eqxDiagEnabled'] = isDiagEnabled();
  // Mirror flag for the streaming auto-capture mode. The netcode-gate
  // spec asserts this is `false` on every rep so a future accidental
  // `?autocapture=1` in a gate URL doesn't silently regress
  // measurement (plan: streaming auto-capture, Phase 1).
  w['__eqxAutoCaptureEnabled'] = isAutoCaptureEnabled();
}
