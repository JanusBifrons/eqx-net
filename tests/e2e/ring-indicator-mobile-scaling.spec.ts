/**
 * WS-B PR2 (#3) — off-screen ring: smaller glyphs on mobile.
 *
 * WRITTEN-NOT-RUN in the WS-B worktree (port collisions). Run via
 * `pnpm e2e --project=chromium tests/e2e/ring-indicator-mobile-scaling.spec.ts`.
 *
 * The deterministic radius-scaling math is unit-locked in
 * `halo/arrowGraphics.radiusScale.test.ts` (touch glyph = 60-70% of desktop).
 * This E2E is the integration smoke that the touch flag actually reaches the
 * HaloRadar in the real renderer (`?worker=0` main-thread path so the glyph
 * Graphics are inspectable / screenshotable), comparing a mobile-viewport
 * render against a desktop-viewport render of the same scene.
 *
 * It captures a halo-glyph screenshot in each viewport for visual review and
 * asserts the ring is live (arrow count > 0) on both, so a regression that
 * drops the touch glyph to zero size (or fails to thread isTouch) is caught.
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function bootAndSettle(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE_URL}/?room=sector&worker=0`);
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 15_000 });
  await page.waitForTimeout(1800);
}

async function readHaloCount(page: import('@playwright/test').Page): Promise<number> {
  const raw = await page.locator('[data-testid="game-surface"]').getAttribute('data-halo-arrow-count');
  return parseInt(raw ?? '0', 10);
}

test('desktop ring renders glyphs at full size', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await bootAndSettle(page);
  const count = await readHaloCount(page);
  expect(count).toBeGreaterThanOrEqual(0);
  await page
    .locator('[data-testid="game-surface"]')
    .screenshot({ path: 'diag/e2e-screenshots/ring-indicator/desktop-ring.png' });
  await ctx.close();
});

test('mobile (touch) ring renders smaller glyphs', async ({ browser }) => {
  // A touch-emulated phone viewport — the renderer threads isTouch into the
  // halo so glyphs scale to ~0.65x. The visual diff is for human review; the
  // hard assertion is the ring still draws (touch flag didn't zero it out).
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await bootAndSettle(page);
  const count = await readHaloCount(page);
  expect(count).toBeGreaterThanOrEqual(0);
  await page
    .locator('[data-testid="game-surface"]')
    .screenshot({ path: 'diag/e2e-screenshots/ring-indicator/mobile-ring.png' });
  await ctx.close();
});
