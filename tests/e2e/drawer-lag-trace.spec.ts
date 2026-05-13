import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Diagnostic test for the drawer-toggle lag. Captures:
 *   - Playwright trace (screenshots + DOM snapshots + network)
 *   - CDP Performance trace (Chrome DevTools perf JSON)
 *   - `performance.mark()` browser-side milestones
 *
 * The user reported "click drawer button → ~9 s before drawer mounts"
 * (matched by `drawer-galaxy-map-open-close.spec.ts`). Speculation
 * landed on Pixi event-system traversal, but two fixes
 * (viewport.eventMode='none', features.globalMove=false) gave noisy
 * results (9223 → 4901 → 9113ms). Need a real CPU profile.
 *
 * Run via:
 *   pnpm e2e --project=chromium tests/e2e/drawer-lag-trace.spec.ts
 *
 * Outputs go to `diag/drawer-lag-trace/`:
 *   - playwright-trace.zip  (open with `pnpm exec playwright show-trace ...`)
 *   - cdp-perf.json         (open in Chrome DevTools → Performance → Load)
 *   - timings.json          (browser-side performance marks)
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUTPUT_DIR = path.resolve(process.cwd(), 'diag', 'drawer-lag-trace');

async function waitForLocalShip(page: Page, timeoutMs = 25_000): Promise<void> {
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

test('diagnostic: capture drawer-toggle lag CPU profile', async ({ page, context }) => {
  test.setTimeout(120_000); // big budget — we WANT to capture the full lag

  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });

  // 1. Boot the game.
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForLocalShip(page);
  // Settle a couple of seconds so the steady-state Pixi tick is what
  // we measure, not initial connect work.
  await page.waitForTimeout(2000);

  // 2. Inject browser-side performance.mark hooks. The drawer
  //    toggle's onClick just calls setDrawerOpen(true). We mark
  //    immediately before and after the click, and the AdvancedDrawer
  //    has a useMountLog that fires on mount.
  await page.evaluate(() => {
    performance.mark('test:before-click');
    // Watch for the drawer-panel-galaxy testid appearing in the DOM
    // (the moment the drawer body has mounted).
    const observer = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="drawer-panel-galaxy"]');
      if (el) {
        performance.mark('test:drawer-panel-mounted');
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  // 3. Start CDP Performance profiler. Playwright's own trace is
  //    already enabled via `trace: 'retain-on-failure'` in
  //    playwright.config.ts — calling tracing.start again throws.
  //    The test deliberately fails at the end to retain the trace.
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Profiler.enable');
  await cdpSession.send('Profiler.start');

  // 4. Click the drawer toggle.
  await page.evaluate(() => performance.mark('test:click-fired'));
  await page.locator('[data-testid="drawer-toggle"]').click({ force: true });

  // 5. Wait for the panel to appear (the lag terminus). Generous
  //    timeout so we capture the FULL lag, not a truncated one.
  try {
    await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible({ timeout: 30_000 });
  } catch {
    // Even if the panel never appears, we want the trace. Continue.
  }

  // 6. Stop CDP profile + dump it.
  await page.evaluate(() => performance.mark('test:panel-visible'));
  const cdpProfile = await cdpSession.send('Profiler.stop');
  await fs.promises.writeFile(
    path.join(OUTPUT_DIR, 'cdp-perf.json'),
    JSON.stringify(cdpProfile, null, 2),
  );

  // 7. Extract the browser-side perf marks.
  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByType('mark') as PerformanceEntry[];
    return entries
      .filter((e) => e.name.startsWith('test:'))
      .map((e) => ({ name: e.name, startTime: e.startTime }));
  });
  await fs.promises.writeFile(
    path.join(OUTPUT_DIR, 'timings.json'),
    JSON.stringify(marks, null, 2),
  );

  // 8. Compute the click→mount gap and dump it where the test summary
  //    will show it on console.
  const click = marks.find((m) => m.name === 'test:click-fired');
  const mounted = marks.find((m) => m.name === 'test:drawer-panel-mounted');
  if (click && mounted) {
    const lagMs = mounted.startTime - click.startTime;
    // eslint-disable-next-line no-console
    console.log(`[drawer-lag-trace] CLICK→MOUNT gap: ${lagMs.toFixed(0)} ms`);
    // eslint-disable-next-line no-console
    console.log(`[drawer-lag-trace] outputs: ${OUTPUT_DIR}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[drawer-lag-trace] WARN: didn't capture both marks. marks=${JSON.stringify(marks)}`);
  }

  // Force-fail so Playwright's `retain-on-failure` trace is saved.
  // (This test exists for the trace, not for a pass/fail signal.)
  expect.soft(false, 'diagnostic-only — trace retained on intentional fail').toBe(true);
});
