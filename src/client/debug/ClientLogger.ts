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
const MAX_ENTRIES = 2000;

export interface LogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

const entries: LogEntry[] = [];

export function logEvent(tag: string, data: Record<string, unknown>): void {
  entries.push({ ts: performance.now(), tag, data });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/**
 * Diagnostic-mode flag (F1 of the warp-spool perf investigation — see
 * `docs/HANDOFF-warp-spool-perf-followup.md`).
 *
 * `true` when `?diag=1` is in the URL OR `navigator.webdriver` is set
 * (Playwright / any WebDriver-controlled session), so E2E specs and
 * `/diag/capture` runs get the per-frame sub-cost markers with **zero
 * cost on a normal player session**.
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
 * document's lifetime so re-evaluating per frame would be waste.
 */
let _diagEnabled: boolean | null = null;
export function isDiagEnabled(): boolean {
  if (_diagEnabled !== null) return _diagEnabled;
  let enabled = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver === true) {
      enabled = true;
    } else if (typeof window !== 'undefined' && window.location?.search) {
      enabled = new URLSearchParams(window.location.search).get('diag') === '1';
    }
  } catch {
    // Defensive: no URL/navigator (non-browser context) ⇒ stay off.
    enabled = false;
  }
  _diagEnabled = enabled;
  return enabled;
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
