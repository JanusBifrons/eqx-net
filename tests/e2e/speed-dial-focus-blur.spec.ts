import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Speed-dial close()-blurs-focus regression lock (WS-F #18) — E2E layer.
 *
 * Symptom (user, manual play): clicking the Map action via the speed-dial
 * closes the dial + opens the galaxy overlay, but the Map FAB keeps DOM focus.
 * MUI Fab buttons activate on Space/Enter while focused, so the very next Space
 * (the Fire key) re-triggers the focused Map button and re-toggles the overlay
 * instead of firing.
 *
 * Root cause: `SpeedDialMenu.close()` updated only Zustand/local state; nothing
 * blurred the activated button.
 *
 * Fix: `close()` blurs `document.activeElement`, so every terminal speed-dial
 * action (Panels / Map / Weapon) loses focus on close.
 *
 * What this locks end-to-end (the failure mode the component test can't fully
 * reproduce — the real keyboard Space → focused-button activation path):
 *   1. Open the dial, click Map → the overlay opens (aria-pressed=true).
 *   2. Press Space.
 *   3. The overlay is STILL open — Space did NOT re-trigger the (now blurred)
 *      Map button. Pre-fix, the focused button would re-toggle it closed.
 *
 * NOTE: written but NOT run here (parallel workstreams share ports 2567/5173).
 * The runnable fail-first lock is the jsdom component test
 * `src/client/components/SpeedDialMenu.blur.test.tsx`.
 *
 * Boot uses the controlled `test-sector-fast` engineering room (testMode, no
 * drones) so the HUD settles quickly and the dial mounts.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(
  browser: Browser,
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  await page.locator('[data-testid="speed-dial-fab"]').waitFor({ timeout: 10_000 });
  return { ctx, page };
}

test('closing the map via the speed-dial blurs focus so Space does not re-open it', async ({
  browser,
}) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');

    // Open the dial, then open the map via the Map action.
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await expect(mapBtn).toBeVisible({ timeout: 5_000 });
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    // The activated Map button must NOT retain DOM focus after close().
    const stillFocused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute('data-testid') === 'galaxy-map-toggle';
    });
    expect(stillFocused).toBe(false);

    // THE LOCK: pressing Space (the Fire key) must NOT re-trigger the formerly
    // focused Map button. The overlay stays open.
    await page.keyboard.press('Space');
    // Give any erroneous re-toggle a beat to land, then assert it did not.
    await page.waitForTimeout(150);
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await ctx.close();
  }
});
