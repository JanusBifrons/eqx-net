/**
 * E2E investigation — diag-mode-vs-prod-mode side effect (2026-05-25).
 *
 * Phone smoke 2026-05-25 showed a dramatic perceptual difference between
 * `?diag=1` (smooth) and no diag flag (unplayable) on the SAME code path
 * (b67ce61 == HEAD == 48eaeef after revert). Static code review shows no
 * gated path that should slow the prod build. This spec runs both modes
 * deterministically in headless Chromium and measures rafTick cadence,
 * to localise whether the effect is reproducible on the dev box (=> code
 * mechanism we can find) or mobile/GPU-specific (=> below us).
 *
 * No assertions — pure measurement. Prints both distributions; the test
 * passes if both arms collected enough samples to compare.
 */
import { test, expect, type Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface RafStats {
  arm: string;
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  rafGapCount: number;
  rafStutterCount: number;
  mirrorRebuildCount: number;
}

async function measure(browser: Browser, diagFlag: '0' | '1'): Promise<RafStats> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const search = new URLSearchParams({ diag: diagFlag, room: 'test-sector' });
  await page.goto(`${BASE_URL}?${search}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  // Settle for 3 s (warmup), then measure for 10 s.
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.());
  await page.waitForTimeout(10_000);
  const result = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: { tag: string; data: Record<string, unknown> }[] }).__eqxLogs ?? [];
    const raf = logs.filter((e) => e.tag === 'rafTick').map((e) => e.data['elapsedMs'] as number);
    return {
      raf,
      rafGapCount: logs.filter((e) => e.tag === 'raf_gap').length,
      rafStutterCount: logs.filter((e) => e.tag === 'raf_stutter').length,
      mirrorRebuildCount: logs.filter((e) => e.tag === 'mirror_rebuild').length,
    };
  });
  await ctx.close();
  const sorted = [...result.raf].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    arm: `diag=${diagFlag}`,
    n,
    p50: n > 0 ? sorted[Math.floor(n * 0.5)]! : 0,
    p90: n > 0 ? sorted[Math.floor(n * 0.9)]! : 0,
    p99: n > 0 ? sorted[Math.floor(n * 0.99)]! : 0,
    max: n > 0 ? sorted[n - 1]! : 0,
    mean: n > 0 ? sorted.reduce((a, b) => a + b, 0) / n : 0,
    rafGapCount: result.rafGapCount,
    rafStutterCount: result.rafStutterCount,
    mirrorRebuildCount: result.mirrorRebuildCount,
  };
}

test('rafTick cadence: prod (?diag=0) vs instrumented (?diag=1)', async ({ browser }) => {
  test.setTimeout(60_000);
  const prod = await measure(browser, '0');
  const diag = await measure(browser, '1');
  // eslint-disable-next-line no-console
  console.log('\n=== rafTick cadence comparison ===');
  // eslint-disable-next-line no-console
  console.log('PROD (diag=0):', JSON.stringify(prod, null, 2));
  // eslint-disable-next-line no-console
  console.log('DIAG (diag=1):', JSON.stringify(diag, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    '\nDELTA p99:',
    `prod=${prod.p99.toFixed(1)}ms  diag=${diag.p99.toFixed(1)}ms  ratio=${(prod.p99 / Math.max(diag.p99, 0.001)).toFixed(2)}x`,
  );
  // Sanity: both arms collected real rafTick samples
  expect(prod.n).toBeGreaterThan(200);
  expect(diag.n).toBeGreaterThan(200);
});
