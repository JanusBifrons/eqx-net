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

const MAX_ENTRIES = 500;

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
