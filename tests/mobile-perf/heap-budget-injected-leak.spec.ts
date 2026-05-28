/**
 * Mobile-perf regression-lock — the test that protects the test.
 *
 * Drives the same flow as `heap-budget-baseline.spec.ts` but with
 * `?injectLeak=102400` (100 KB per RAF tick via the DEV+URL-gated
 * `src/client/debug/testLeakHook.ts`). At 60 RAF / s over the 3 s
 * wall-clock stress window that's ~18 MB accumulated — well above
 * `jsHeapGrowthMb.eps=2` (so it WILL trip the growth detection)
 * and well below `jsHeapUsedMb.ceil=220` (so it WON'T trip the
 * absolute-used ceiling at the same time, which would weaken the
 * coupling between the assertion and what the spec is actually
 * detecting).
 *
 * Assertion: `evaluateMobilePerfAbsolute` returns a failure whose
 * `metric === 'jsHeapGrowthMb'`. If this spec ever turns green
 * (i.e. the gate stops detecting the injected leak), CI alerts via
 * the regression-lock contradiction — the gate has stopped working.
 *
 * The injected leak is DEV-gated in `testLeakHook.ts` via
 * `import.meta.env.DEV`. Prod builds tree-shake the entire
 * allocator. The URL param alone does NOTHING in a production
 * deploy.
 */
import { test, expect } from '@playwright/test';
import {
  connectAndroidOrFallback,
  type ConnectMode,
} from './helpers/androidConnect.js';
import { forceGcAndCapture } from './helpers/cdpHeap.js';
import {
  getPerformanceMetrics,
  readDiagFlag,
  readPredStats,
  waitForPredStatsReady,
} from './helpers/perfMetrics.js';
import {
  evaluateMobilePerfAbsolute,
  type MobilePerfArm,
} from './mobilePerfBudget.js';

const STRESS_MS = 3_000;
const LEAK_BYTES_PER_TICK = 102_400; // 100 KB

test('mobile-perf regression-lock: injected ?injectLeak trips jsHeapGrowthMb (gate self-test)', async () => {
  const mode = (process.env['MOBILE_PERF_MODE'] as ConnectMode | undefined) ?? 'force-fallback';
  const conn = await connectAndroidOrFallback({ mode });
  try {
    await conn.page.goto(
      `${process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173'}/?room=test-sector-fast&injectLeak=${LEAK_BYTES_PER_TICK}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );
    await waitForPredStatsReady(conn.page);

    const diagBefore = await readDiagFlag(conn.page);
    const preHeap = await forceGcAndCapture(conn.cdp);
    const preDom = await getPerformanceMetrics(conn.cdp);
    // eslint-disable-next-line no-console
    console.log(
      `[mobile-perf:leak-lock] pre-stress preHeap=${JSON.stringify(preHeap)} preDom=${JSON.stringify(preDom)}`,
    );

    await conn.page.waitForTimeout(STRESS_MS);

    const stats = await readPredStats(conn.page);
    const postHeap = await forceGcAndCapture(conn.cdp);
    const postDom = await getPerformanceMetrics(conn.cdp);
    const diagAfter = await readDiagFlag(conn.page);

    const arm: MobilePerfArm = {
      jsHeapUsedMb: postHeap.jsHeapUsedMb,
      jsHeapGrowthMb: postHeap.jsHeapUsedMb - preHeap.jsHeapUsedMb,
      documentCount: postDom.documentCount,
      jsEventListeners: postDom.jsEventListeners,
      longtaskCount30s: stats.longtaskCount30s,
      rafP50Ms: stats.rafP50Ms,
      rafP99Ms: stats.rafP99Ms,
      rafGapCount30s: stats.rafGapCount30s,
      diagEnabled: diagBefore || diagAfter,
      snapshotCount: stats.snapshotCount,
      ranKind: conn.kind,
      measuredMs: STRESS_MS,
    };

    const verdict = evaluateMobilePerfAbsolute(arm);

    // eslint-disable-next-line no-console
    console.log(
      `[mobile-perf:leak-lock] mode=${conn.kind} growthMb=${arm.jsHeapGrowthMb} verdict=${JSON.stringify(verdict)}`,
    );

    // Liveness preconditions must still pass — a precondition fail
    // is NOT a successful gate-detected-leak, it's "we couldn't even
    // run the gate". Different failure mode.
    expect(
      verdict.preconditionFailures,
      `precondition failures (the gate did not validly run): ${verdict.preconditionFailures.join('; ')}`,
    ).toEqual([]);

    // The KEY assertion: the gate DETECTED the leak via the growth
    // metric. If the failure list is empty (or doesn't contain
    // jsHeapGrowthMb), the test instrumentation has drifted — either
    // the testLeakHook stopped firing, the budget thresholds were
    // widened past the leak rate, or the CDP heap capture broke.
    expect(
      verdict.failures.find((f) => f.metric === 'jsHeapGrowthMb'),
      `mobile-perf gate self-test FAILED — the injected leak did NOT trip jsHeapGrowthMb. arm=${JSON.stringify(arm)} verdict=${JSON.stringify(verdict)}. If this passes (no failure), the gate has stopped detecting leaks. Check src/client/debug/testLeakHook.ts and tests/mobile-perf/mobilePerfBudget.ts.`,
    ).toBeDefined();
  } finally {
    await conn.cleanup();
  }
});
