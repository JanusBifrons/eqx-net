/**
 * Mobile-perf v1: single-arm heap + DOM + RAF jitter gate.
 *
 * Joins the accelerated test sector (`test-sector-fast`, physics
 * 10×), waits for the predStats readout to confirm the live loop is
 * exercising, captures a post-GC pre-arm baseline, runs a 30 s
 * game-time stress phase (≈3 s wall-clock at `testTimeScale=10`),
 * then captures a post-GC post-arm sample. Builds a
 * `MobilePerfArm` from the deltas and asserts the absolute budget.
 *
 * v1 is absolute-only (`evaluateMobilePerfAbsolute`). v2 will add
 * baseline-vs-HEAD relative comparison once the on-disk baseline
 * story is decided.
 *
 * Verified by: companion `heap-budget-injected-leak.spec.ts` which
 * triggers a known leak and asserts the gate DETECTS it.
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

const STRESS_MS = 3_000; // wall-clock; 30 s game-time at testTimeScale=10

test('mobile-perf: post-GC heap + DOM growth stay within absolute budget', async () => {
  const mode = (process.env['MOBILE_PERF_MODE'] as ConnectMode | undefined) ?? 'force-fallback';
  const conn = await connectAndroidOrFallback({ mode });
  try {
    // Cold-boot the test room. `test-sector-fast` is `testMode=true`
    // with no drones / asteroids and `testTimeScale=10` — same shape
    // every other E2E perf-flavoured spec uses.
    await conn.page.goto(
      `${process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173'}/?room=test-sector-fast`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );

    // Mandatory readiness gate — `data-pred-stats` is only populated
    // after Colyseus snapshots flow. On a cold Android boot this can
    // take 5–15 s; the gate waits up to 20 s for ≥40 snapshots.
    await waitForPredStatsReady(conn.page);

    // Liveness precondition — measuring an instrumented build would
    // silently mask regressions (mirrors the netgate's Mechanism 1).
    const diagBefore = await readDiagFlag(conn.page);

    // Pre-stress snapshot.
    const preHeap = await forceGcAndCapture(conn.cdp);
    const preDom = await getPerformanceMetrics(conn.cdp);
    // eslint-disable-next-line no-console
    console.log(
      `[mobile-perf] pre-stress preHeap=${JSON.stringify(preHeap)} preDom=${JSON.stringify(preDom)}`,
    );

    // Stress phase. Plain wall-clock wait — the game-time
    // acceleration via `testTimeScale=10` is what keeps this short.
    // Real RAF allocator pressure, real React effect churn, real
    // Pixi render loop all run during this window.
    await conn.page.waitForTimeout(STRESS_MS);

    // Post-stress snapshot.
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
      `[mobile-perf] mode=${conn.kind} arm=${JSON.stringify(arm)} verdict=${JSON.stringify(verdict)}`,
    );

    expect(
      verdict.preconditionFailures,
      `precondition failures (the gate did not validly run): ${verdict.preconditionFailures.join('; ')}`,
    ).toEqual([]);
    expect(
      verdict.failures,
      `absolute budget breach(es): ${verdict.failures.map((f) => `${f.metric} ${f.head} > ${f.ceil}`).join('; ')}`,
    ).toEqual([]);
  } finally {
    await conn.cleanup();
  }
});
