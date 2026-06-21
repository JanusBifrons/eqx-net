// @diag (manual-only): see docs/architecture/e2e-framework.md
// Run: pnpm e2e:diag tests/diag/drawer-cdp-starvation-probe.spec.ts
import { test, expect } from '@playwright/test';

/**
 * 2026-05-14 — Hypothesis 2 probe: is Pixi's RAF loop starving
 * Playwright's CDP roundtrip?
 *
 * Hypothesis 1 (`drawer-keepmounted-probe.spec.ts`) confirmed that the
 * Drawer's children are in DOM at page-load — keepMounted is working.
 * Yet `drawer-galaxy-overview-spawn.spec.ts` still times out at 30 s on
 * `expect(galaxy-tab-show-map).toBeVisible()`. The element is mounted,
 * so what's slow?
 *
 * The handoff doc (`docs/HANDOFF-drawer-perf-2026-05-13.md`) notes that
 * `page.evaluate(() => fn())` was reported as `logs cleared` at 4.5–5 s
 * on this machine — that's CDP itself unable to get a slot, not MUI
 * being slow. This probe measures CDP roundtrip times during steady-
 * state Pixi load. Healthy CDP is ~10–30 ms per roundtrip. If we see
 * roundtrips >100 ms repeatedly, the main-thread Pixi tick is the
 * thing starving Playwright.
 *
 * Read result via the spec's stdout `HYP2 STATS` block. The spec
 * always passes; the interpretation is in the numbers.
 *
 * Next step if confirmed:
 *   - Apply `app.ticker.maxFPS = 30` (PixiRenderer one-liner) and
 *     re-measure. If roundtrip drops to <50 ms, the fix is to throttle
 *     Pixi while modals are open (≈10 LoC in PixiRenderer + a
 *     useEffect in App.tsx watching `isDrawerOpen`).
 *
 * Marathon-recovery plan Phase 3 step 3.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SAMPLE_COUNT = 20;

test('CDP roundtrip under steady-state Pixi load', async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await expect(page.locator('[data-testid="sector-info-panel"]')).toBeVisible({
    timeout: 25_000,
  });

  // Let the game settle into steady-state. Pixi tick is running, the
  // server snapshot loop is feeding, the predWorld is reconciling.
  // Give it 2 s so transient bursts (initial spawn, sector load) settle.
  await page.waitForTimeout(2000);

  // Measure N roundtrips. Each `page.evaluate(() => performance.now())`
  // = one CDP request + one JS execution + one CDP response. The
  // wall-clock delta between two consecutive `Date.now()` measurements
  // around the evaluate is the roundtrip.
  const samples: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const t0 = Date.now();
    await page.evaluate(() => performance.now());
    const dt = Date.now() - t0;
    samples.push(dt);
  }

  samples.sort((a, b) => a - b);
  const min = samples[0]!;
  const median = samples[Math.floor(samples.length / 2)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  const max = samples[samples.length - 1]!;
  const mean = Math.round(samples.reduce((s, n) => s + n, 0) / samples.length);

  // eslint-disable-next-line no-console
  console.log(
    `HYP2 STATS (${SAMPLE_COUNT} samples, ms):\n` +
      `  min=${min}  median=${median}  mean=${mean}  p95=${p95}  max=${max}\n` +
      `  raw=${samples.join(',')}\n` +
      `  interpretation: healthy CDP ~10–30 ms; >100 ms median = Pixi tick starvation likely.`,
  );

  // Always-pass spec (this is a measurement, not a regression lock).
  // But fail loudly if median is in the danger zone so the result is
  // surfaced in the Playwright report without needing log diving.
  expect(
    median,
    `CDP roundtrip median is ${median} ms — expected <100 ms. Pixi tick is likely starving Playwright's protocol loop. See spec docstring.`,
  ).toBeLessThan(500);
});
