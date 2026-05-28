/**
 * CDP `Performance.getMetrics` + in-page `data-pred-stats` readers
 * for the mobile-perf gate.
 *
 * Two distinct readout surfaces feed the budget arm:
 *
 *   1. CDP `Performance.getMetrics` → `Documents`,
 *      `JSEventListeners`, `Nodes`, `JSHeapUsedSize` (re-read here
 *      as a sibling of the `cdpHeap.ts` capture for one-call
 *      convenience).
 *
 *   2. In-page `data-pred-stats` JSON attribute (written by
 *      `src/client/app/gameRafLoop.ts` from
 *      `JSON.stringify(gameClient.stats)`) → `rafP50Ms`,
 *      `rafP99Ms`, `longtaskCount30s`, `rafGapCount30s`,
 *      `heapUsedMb`, `snapshotCount`.
 */
import type { CDPSession, Page } from '@playwright/test';

export interface PerfDomMetrics {
  documentCount: number;
  jsEventListeners: number;
  nodes: number;
  jsHeapUsedMb: number;
}

export interface PredStatsReadout {
  rafP50Ms: number;
  rafP99Ms: number;
  longtaskCount30s: number;
  rafGapCount30s: number;
  /** `performance.memory.usedJSHeapSize` in MiB. Undefined on
   *  non-Chromium browsers. */
  heapUsedMb: number | undefined;
  snapshotCount: number;
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Read DOM-side perf metrics via CDP. `Performance.enable` is
 * idempotent — safe to call alongside `cdpHeap.ts`'s sequence.
 */
export async function getPerformanceMetrics(cdp: CDPSession): Promise<PerfDomMetrics> {
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name: string): number => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    documentCount: get('Documents'),
    jsEventListeners: get('JSEventListeners'),
    nodes: get('Nodes'),
    jsHeapUsedMb: get('JSHeapUsedSize') / BYTES_PER_MB,
  };
}

/**
 * Per-field subtraction across pre/post captures. Useful for the
 * `documentCountGrowth` / `jsEventListenersGrowth` derivations.
 */
export function diffPerfDom(pre: PerfDomMetrics, post: PerfDomMetrics): PerfDomMetrics {
  return {
    documentCount: post.documentCount - pre.documentCount,
    jsEventListeners: post.jsEventListeners - pre.jsEventListeners,
    nodes: post.nodes - pre.nodes,
    jsHeapUsedMb: post.jsHeapUsedMb - pre.jsHeapUsedMb,
  };
}

/**
 * Mandatory readiness gate — `data-pred-stats` is only populated
 * after the client has received snapshots from Colyseus AND the
 * `gameRafLoop.ts` writer has run. On a cold-boot Android device
 * this can take 5–15 s; on a desktop fallback it's typically <2 s.
 *
 * The gate waits for `snapshotCount >= minSnapshots` (default 40,
 * matching `MIN_SNAPSHOTS` in `mobilePerfBudget.ts`). Below 40
 * snapshots the run "did not validly exercise the live loop" and
 * the budget would precondition-fail anyway — better to wait here
 * than to capture a no-op arm.
 *
 * Throws on timeout with a clear diagnostic so the spec surfaces a
 * liveness failure, not a budget breach.
 */
export async function waitForPredStatsReady(
  page: Page,
  opts?: { minSnapshots?: number; timeoutMs?: number },
): Promise<void> {
  const minSnapshots = opts?.minSnapshots ?? 40;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  await page.waitForFunction(
    ({ min }) => {
      const el = document.querySelector('[data-testid="game-surface"]');
      const raw = el?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        const stats = JSON.parse(raw) as { snapshotCount?: unknown };
        return typeof stats.snapshotCount === 'number' && stats.snapshotCount >= min;
      } catch {
        return false;
      }
    },
    { min: minSnapshots },
    { timeout: timeoutMs },
  );
}

/**
 * Parse `data-pred-stats`. Caller MUST have awaited
 * `waitForPredStatsReady` (or otherwise know the attribute is
 * present) — this function throws if the attribute is missing or
 * invalid JSON.
 */
export async function readPredStats(page: Page): Promise<PredStatsReadout> {
  const raw = await page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-pred-stats');
  if (raw === null) {
    throw new Error('readPredStats: data-pred-stats attribute missing — did you await waitForPredStatsReady?');
  }
  const parsed = JSON.parse(raw) as Partial<PredStatsReadout>;
  return {
    rafP50Ms: typeof parsed.rafP50Ms === 'number' ? parsed.rafP50Ms : 0,
    rafP99Ms: typeof parsed.rafP99Ms === 'number' ? parsed.rafP99Ms : 0,
    longtaskCount30s: typeof parsed.longtaskCount30s === 'number' ? parsed.longtaskCount30s : 0,
    rafGapCount30s: typeof parsed.rafGapCount30s === 'number' ? parsed.rafGapCount30s : 0,
    heapUsedMb: typeof parsed.heapUsedMb === 'number' ? parsed.heapUsedMb : undefined,
    snapshotCount: typeof parsed.snapshotCount === 'number' ? parsed.snapshotCount : 0,
  };
}

/**
 * Read `window.__eqxDiagEnabled`. The mobile-perf budget's
 * `diagEnabled` precondition asserts this is `false` — mirrors the
 * netgate's Mechanism-1 rule (measuring an instrumented build
 * silently masks regressions).
 */
export async function readDiagFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    return (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true;
  });
}
