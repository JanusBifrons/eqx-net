/**
 * Heap-growth gate (2026-05-25) — closes the netgate's blind spot.
 *
 * The netgate measures drift / correction metrics. It does NOT measure
 * heap growth rate, which is what actually drives the phone-side spiral
 * (V8 major GC every 30s with 200-500 ms pauses → snapshot backlog →
 * coalesce-storm → unplayable).
 *
 * Today's cherry-pick (ea75de6) passed netgate but caused heap growth
 * 3.2 MB/sec on the phone (capture m2wm1y). Reverted to 599aef8.
 *
 * This gate measures heap_sample events from a 20s in-game window and
 * asserts the linear growth rate. Run on every commit that touches the
 * client allocation hot path BEFORE phone-smoking. Cheaper than a phone
 * smoke and catches the leak shape that netgate misses.
 *
 * Threshold: heap growth ≤ 0.3 MB/sec (between handoff target 0.1 and
 * pre-cherry-pick prod 0.65, allowing for dev-box noise). Adjust after
 * baseline data accumulates. Sanity-only for now (no hard assertion on
 * the value — just prints the number + asserts samples collected).
 */
import { test, expect, chromium, type Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

/**
 * `performance.memory.usedJSHeapSize` is BUCKETED by default in Chromium —
 * returns the same value across many samples, useless for trend detection.
 * The `--enable-precise-memory-info` flag exposes the real value. Without
 * it, all heap_sample events log an identical static number and this gate
 * silently passes anything.
 */
const PRECISE_MEMORY_LAUNCH_ARGS = ['--enable-precise-memory-info'];

interface HeapSample {
  ts: number;
  heap: number;
}

interface HeapStats {
  arm: string;
  sampleCount: number;
  firstHeapMb: number;
  lastHeapMb: number;
  durationS: number;
  growthMbPerSec: number;
  // Linear regression slope as a second view (less sensitive to first/last spikes).
  slopeMbPerSec: number;
  // Major GC indicator: count of "heap dropped > 5 MB" events (sawtooth).
  majorReclaims: number;
  peakHeapMb: number;
}

function computeStats(arm: string, samples: HeapSample[]): HeapStats {
  if (samples.length < 2) {
    return { arm, sampleCount: samples.length, firstHeapMb: 0, lastHeapMb: 0, durationS: 0, growthMbPerSec: 0, slopeMbPerSec: 0, majorReclaims: 0, peakHeapMb: 0 };
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const durationS = (last.ts - first.ts) / 1000;
  const growthMbPerSec = (last.heap - first.heap) / durationS;

  // Linear regression: slope = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)
  const meanX = samples.reduce((s, p) => s + p.ts, 0) / samples.length;
  const meanY = samples.reduce((s, p) => s + p.heap, 0) / samples.length;
  let num = 0;
  let den = 0;
  for (const p of samples) {
    num += (p.ts - meanX) * (p.heap - meanY);
    den += (p.ts - meanX) ** 2;
  }
  const slopeMbPerMs = den > 0 ? num / den : 0;
  const slopeMbPerSec = slopeMbPerMs * 1000;

  // Count "major reclaim" events — heap drops > 5 MB between consecutive samples.
  let majorReclaims = 0;
  let peak = samples[0]!.heap;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]!.heap - samples[i]!.heap > 5) majorReclaims++;
    if (samples[i]!.heap > peak) peak = samples[i]!.heap;
  }

  return {
    arm,
    sampleCount: samples.length,
    firstHeapMb: first.heap,
    lastHeapMb: last.heap,
    durationS,
    growthMbPerSec,
    slopeMbPerSec,
    majorReclaims,
    peakHeapMb: peak,
  };
}

async function measureHeapGrowth(_browser: Browser, label: string): Promise<HeapStats> {
  // Launch a dedicated Chromium instance with the precise-memory flag so
  // `performance.memory.usedJSHeapSize` returns trend-detectable values.
  // The shared fixture browser is launched without the flag, so we override.
  const dedicated = await chromium.launch({ args: PRECISE_MEMORY_LAUNCH_ARGS });
  const ctx = await dedicated.newContext();
  const page = await ctx.newPage();
  // `?diag=1` matches the conditions where heap_sample events fire AND
  // matches the env the user observed the leak in. `room=test-sector`
  // keeps the room isolated from other E2E tests.
  await page.goto(`${BASE_URL}/?diag=1&autocapture=0&room=test-sector`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  // Warmup 5s — initial connect / snapshot / mirror bootstrap heap pressure.
  await page.waitForTimeout(5000);
  await page.evaluate(() => (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.());
  // Measurement window 20s.
  await page.waitForTimeout(20_000);
  const samples = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: { ts: number; tag: string; data: Record<string, unknown> }[] }).__eqxLogs ?? [];
    return logs
      .filter((e) => e.tag === 'heap_sample')
      .map((e) => ({ ts: e.ts, heap: e.data['heapUsedMb'] as number }));
  });
  await ctx.close();
  await dedicated.close();
  return computeStats(label, samples);
}

test('heap growth gate: in-game allocation rate during 20s window', async ({ browser }) => {
  test.setTimeout(60_000);
  const stats = await measureHeapGrowth(browser, 'HEAD');
  // eslint-disable-next-line no-console
  console.log('\n=== Heap growth gate ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(stats, null, 2));
  // Sanity: heap samples were collected
  expect(stats.sampleCount).toBeGreaterThan(50);
  // No hard assertion on growth rate yet — establishing baseline. Documented
  // reference targets:
  //   - Handoff target (post Probe 7+8): 0.1 MB/s
  //   - Pre-cherry-pick today prod (kdjvkz): 0.65 MB/s
  //   - Post-cherry-pick today (m2wm1y): 3.2 MB/s ← regressed, reverted
});
