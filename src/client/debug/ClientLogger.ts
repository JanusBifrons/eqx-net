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

// 2000-entry ring keeps ~20 s of per-frame events at the steady-state
// rate of `rafTick` + `snapshot` + `correction` + `swarm_snap_diagnostics`
// (~100 events/sec). Anything older gets rotated out, but join-time
// one-shots (`welcome`, `pixi_first_frame`, `join_chain_complete`)
// survive until the E2E reads the log. Previously 500 — too tight on
// CI where the test sometimes ran to ~10 s and lost the early events.
// 2026-05-17: 2000 → 8000. Phone smoke captures use THIS cap (not
// DIAG — the device isn't `?diag=1`); at the in-combat event rate
// (~450/s, dominated by per-drone `swarm_snap_diagnostics`) 2000 only
// spanned ~5 s, so sparse INTERMITTENT network-bunching spikes (the
// `xxiyix` 571 ms snapshot-receipt gap class) routinely rotated out
// before the user could hit Capture. 8000 ≈ ~18–25 s of in-combat
// history (much longer when calmer) so a spike + its calm lead-in are
// both retained. ~8000 small objects/tab — acceptable dev-stage cost,
// trivially revertable pre-release.
const PROD_MAX_ENTRIES = 8000;
// Diagnostic sessions (`?diag=1` / WebDriver — see `isDiagEnabled`) add
// the F1 per-frame sub-cost markers + the F-transit `transit_mark` /
// `transit_frame` rows on top of the steady spam (~300–600 ev/s). The
// sparse, high-value discrete `transit_mark` rows (≈12 per warp) then
// get evicted by the per-frame flood before the user can Capture a few
// seconds after a warp-out — observed 2026-05-16 capture `…juj8j7`:
// only `curtain_down` + `settled` survived; `engage` / `leave_room` /
// `pred_reset` / `join_room` / `first_snapshot` had rotated out. A
// larger diag-only ring retains the full engage→curtain timeline.
// ZERO production cost: `isDiagEnabled()` is false for normal players,
// so the cap stays 2000 and the FIFO behaviour is byte-identical.
const DIAG_MAX_ENTRIES = 30000;

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

export function installWindowLogger(): void {
  const w = window as unknown as Record<string, unknown>;
  w['__eqxLogs'] = entries;
  w['__eqxEpoch'] = Date.now(); // wall-clock epoch; correlate with server timestamps via epoch + log.ts
  w['__eqxClearLogs'] = (): void => { entries.splice(0); };
  // Expose the resolved diag flag so devtools / E2E can confirm markers
  // are active without re-deriving the predicate.
  w['__eqxDiagEnabled'] = isDiagEnabled();
}
