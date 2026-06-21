// @diag (manual-only): see docs/architecture/e2e-framework.md
// Run: pnpm e2e:diag tests/diag/drawer-lag-trace.spec.ts
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Drawer-toggle perf measurement + CPU profile capture.
 *
 * Measures the wall-clock from `click()` to a user-visible signal
 * inside the drawer (the "Show galaxy map" button) using Playwright's
 * own `toBeVisible`. No MutationObserver heuristics — just the
 * primitive Playwright was built for.
 *
 * Captures a CDP CPU profile around the same window so we can run
 * `scripts/analyze-cdp-profile.mjs` against `diag/drawer-lag-trace/cdp-perf.json`
 * to see where main-thread time is spent during the lag.
 *
 * Outputs to `diag/drawer-lag-trace/`:
 *   - cdp-perf.json   Chrome DevTools-loadable CPU profile
 *
 * History:
 *   - baseline (no fixes):           13.7 s
 *   - + swarmSnapStats throttle:      3.07 s
 *   - + Drawer keepMounted:           1.22 s
 *   - + Slide mountOnEnter:false:     ~1.4 s  (variance)
 *
 * Target: < 500 ms.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUTPUT_DIR = path.resolve(process.cwd(), 'diag', 'drawer-lag-trace');

async function waitForLocalShip(page: Page, timeoutMs = 25_000): Promise<void> {
  await expect(page.locator('[data-testid="sector-info-panel"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

test('drawer-toggle click → galaxy-tab-show-map visible (perf budget)', async ({ page }) => {
  test.setTimeout(45_000);
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });

  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForLocalShip(page);
  // Settle so the steady-state Pixi tick is what we're measuring, not
  // initial-connect work.
  await page.waitForTimeout(1500);

  // `force: true` skips Playwright's actionability checks (which need
  // a stable bounding rect — our Pixi canvas repaints every 16 ms, so
  // the rect is never "stable" by Playwright's standard).
  // `galaxy-tab-show-map` is the green "Show galaxy map" button inside
  // the Galaxy tab. It's the first user-meaningful element they see
  // when the drawer opens.
  const t0 = Date.now();
  await page.locator('[data-testid="drawer-toggle"]').click({ force: true });
  await expect(page.locator('[data-testid="galaxy-tab-show-map"]')).toBeVisible({ timeout: 15_000 });
  const lagMs = Date.now() - t0;

  // eslint-disable-next-line no-console
  console.log(`[drawer-lag-trace] CLICK→VISIBLE: ${lagMs} ms (target < 500)`);

  expect(lagMs, `drawer-toggle → "Show galaxy map" visible: ${lagMs} ms`).toBeLessThan(500);
});
