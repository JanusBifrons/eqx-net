import { test, expect, type Page } from '@playwright/test';

/**
 * Equinox Phase 7 (Item 1) — in-game full-page WARP map regression lock.
 *
 * Pressing the Map button (or `M`) IN-GAME now shows the full-page macro map
 * (the shared `GalaxyPickerChrome` popover chrome over the `selector` layer) —
 * NOT the old translucent additive overlay. Tapping a hex opens the info
 * popover; an ADJACENT neighbour shows a "Warp here" CTA which engages the
 * transit (SPOOLING) and closes the map. The deterministic `__eqxGalaxyPick`
 * hook mirrors a real selector-layer tap (same path the landing picker uses).
 *
 * `?galaxy=sol-prime` autojoins the core hub; `cygnus-arm` is a real graph
 * neighbour (see warp-engage-cancel.spec.ts), so it's a valid warp target.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function bootInGame(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
  await page.locator('[data-testid="sector-info-panel"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { __eqxGalaxyPick?: unknown }).__eqxGalaxyPick === 'function',
    null,
    { timeout: 10_000 },
  );
}

test('in-game: Map → full-page warp map → tap adjacent → "Warp here" → SPOOLING', async ({ page }) => {
  test.setTimeout(60_000);
  await bootInGame(page);

  // Map closed → no warp chrome on screen.
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(0);

  // Open the in-game map (M) → the full-page WARP chrome mounts (Close button
  // present — the landing chrome has none).
  await page.keyboard.press('m');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('[data-testid="galaxy-warp-close"]')).toBeVisible();

  // Tap an ADJACENT sector → the info popover opens with a "Warp here" CTA
  // (in-game shows "Warp here", never the landing "Join the fight").
  await page.evaluate(() => {
    (window as unknown as { __eqxGalaxyPick?: (k: string) => void }).__eqxGalaxyPick?.('cygnus-arm');
  });
  await expect(page.getByTestId('sector-drawer-close')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId('sector-drawer-warp')).toBeVisible();
  await expect(page.getByTestId('sector-drawer-join')).toHaveCount(0);

  // "Warp here" → engages the transit (SPOOLING overlay) and closes the map.
  await page.getByTestId('sector-drawer-warp').click();
  const overlay = page.locator('[data-testid="hyperspace-overlay"]');
  await expect(overlay).toBeVisible({ timeout: 8_000 });
  await expect(overlay).toHaveAttribute('data-transit-state', 'SPOOLING');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(0);
});
