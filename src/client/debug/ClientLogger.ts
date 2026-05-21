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
export function logEvent(tag: string, data: Record<string, unknown>): void {
  if (_maxEntries < 0) {
    _maxEntries = isDiagEnabled() ? DIAG_MAX_ENTRIES : PROD_MAX_ENTRIES;
  }
  entries.push({ ts: performance.now(), tag, data });
  if (entries.length > _maxEntries) entries.shift();
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
 * Test / netcode-gate-only: clear BOTH cached latches so the next
 * `isDiagEnabled()` / `logEvent()` re-resolves against the current
 * environment. Production never calls this (URL/webdriver are fixed for
 * the document lifetime). Resets `_diagEnabled` (the predicate) AND
 * `_maxEntries` (the ring-size latch) — both must reset together or a
 * harness that flips `?diag` between arms keeps a stale ring cap.
 */
export function __resetDiagCache(): void {
  _diagEnabled = null;
  _maxEntries = -1;
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
}
