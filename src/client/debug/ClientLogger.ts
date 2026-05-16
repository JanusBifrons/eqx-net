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

export function installWindowLogger(): void {
  const w = window as unknown as Record<string, unknown>;
  w['__eqxLogs'] = entries;
  w['__eqxEpoch'] = Date.now(); // wall-clock epoch; correlate with server timestamps via epoch + log.ts
  w['__eqxClearLogs'] = (): void => { entries.splice(0); };
}
