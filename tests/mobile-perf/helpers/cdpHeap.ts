/**
 * CDP heap-capture helpers for the mobile-perf gate. Wraps
 * `HeapProfiler.collectGarbage` + `Performance.getMetrics` so the
 * specs measure a deterministic post-GC heap state, not whatever the
 * browser felt like collecting on its own schedule.
 *
 * Builds on the `HeapProfiler.enable` precedent in
 * `tests/e2e/combat-allocation-profile.spec.ts`. The new wrinkle is
 * the double-GC settle window — Android Chrome (via
 * `playwright._android`'s remote-debugging-pipe) has a lazier
 * default GC cadence than desktop Chromium, so we collect twice
 * with a settle interval between to converge on a stable post-GC
 * heap. The 250 ms default settle is generous; bump via
 * `settleMs` if specs flake on a particularly cold device.
 */
import type { CDPSession } from '@playwright/test';

export interface HeapSample {
  jsHeapUsedMb: number;
  jsHeapTotalMb: number;
}

const BYTES_PER_MB = 1024 * 1024;

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function readJSHeap(cdp: CDPSession): Promise<HeapSample> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const usedBytes = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
  const totalBytes = metrics.find((m) => m.name === 'JSHeapTotalSize')?.value ?? 0;
  return {
    jsHeapUsedMb: usedBytes / BYTES_PER_MB,
    jsHeapTotalMb: totalBytes / BYTES_PER_MB,
  };
}

/**
 * Force a deterministic post-GC heap measurement. Sequence:
 *
 *   1. `HeapProfiler.enable` + `Performance.enable` (idempotent —
 *      safe to call multiple times in one spec).
 *   2. `HeapProfiler.collectGarbage` (1st pass).
 *   3. Settle `settleMs` (default 250 ms) — gives V8 time to finalise
 *      the mark/sweep cycle, especially on Android's slower GC.
 *   4. `HeapProfiler.collectGarbage` (2nd pass) — flushes finalisers
 *      registered during the 1st pass.
 *   5. Settle again.
 *   6. Read `Performance.getMetrics` → `JSHeapUsedSize` / `JSHeapTotalSize`.
 *
 * Returns MiB scalars (the budget thresholds are in MiB).
 */
export async function forceGcAndCapture(
  cdp: CDPSession,
  opts?: { settleMs?: number },
): Promise<HeapSample> {
  const settleMs = opts?.settleMs ?? 250;

  await cdp.send('HeapProfiler.enable');
  await cdp.send('Performance.enable');

  await cdp.send('HeapProfiler.collectGarbage');
  await settle(settleMs);
  await cdp.send('HeapProfiler.collectGarbage');
  await settle(settleMs);

  return readJSHeap(cdp);
}
