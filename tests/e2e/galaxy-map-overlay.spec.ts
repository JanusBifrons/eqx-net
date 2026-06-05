import { test, expect, devices } from '@playwright/test';

/**
 * Galaxy Map refactor (2026-05-10) — Map B regression lock.
 *
 * Map B is the in-game additive Pixi overlay (`GalaxyMapLayer`) toggled by
 * the bottom-center HUD MAP button (`GalaxyMapToggleButton`). It lives on
 * the gameplay canvas's stage, above the world viewport, so non-hex pixels
 * pass through to gameplay underneath.
 *
 * These specs lock the React-side toggle behaviour (button aria-pressed,
 * keyboard `M` shortcut). The Pixi-side draw is covered by the manual UX
 * walk and the renderer's pure-graph adjacency logic in
 * `src/core/galaxy/galaxy.test.ts`. The wire/server-side neighbour
 * enforcement is locked by `src/server/transit/TransitOrchestrator.test.ts`.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
// `?galaxy=sol-prime` autoJoins the Sol Prime sector room so the spawn-select
// flow is bypassed. Sol Prime is the centre node, so all six other sectors
// are neighbours — useful for covering the "selectable" tier visually.
const BOOT_URL = `${BASE_URL}/?galaxy=sol-prime`;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  // First navigation under Playwright's CI mode hits a cold Vite dev server
  // — initial transform of all client modules can take 30+ s. Use
  // `domcontentloaded` (not the default `load`) so we don't block on every
  // chunk finishing, and bump the timeout for the cold path.
  await page.goto(BOOT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
  await page.locator('[data-testid="ship-stats-card"]').waitFor({ timeout: 30_000 });
}

test.describe('galaxy-map overlay (Map B)', () => {
  test('desktop: MAP toggle button is visible in-game and reflects the open state', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');
    await expect(mapBtn).toBeVisible();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');

    // Tap → opens.
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    // Tap again → closes.
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');

    await ctx.close();
  });

  test('desktop: keyboard M toggles the same overlay state as the button', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');

    // M key opens.
    await page.keyboard.press('m');
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    // M key closes.
    await page.keyboard.press('m');
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');

    await ctx.close();
  });

  test('mobile: MAP toggle button sits in the bottom-center slot alongside the slot selector', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');
    // weapons/energy/AI overhaul (§5.2): the per-weapon picker is now the
    // SlotSelector (`slot-selector`), rendered in the same mobile cluster.
    const weaponBtn = page.locator('[data-testid="slot-selector"]');
    await expect(mapBtn).toBeVisible();
    await expect(weaponBtn).toBeVisible();

    // Both share the bottom-center anchor; the slot host is one element.
    const mapBox = await mapBtn.boundingBox();
    const weaponBox = await weaponBtn.boundingBox();
    expect(mapBox).not.toBeNull();
    expect(weaponBox).not.toBeNull();
    // Sanity: the MAP button is not literally on top of the slot selector.
    if (mapBox && weaponBox) {
      const overlap =
        Math.max(0, Math.min(mapBox.x + mapBox.width, weaponBox.x + weaponBox.width) - Math.max(mapBox.x, weaponBox.x))
        * Math.max(0, Math.min(mapBox.y + mapBox.height, weaponBox.y + weaponBox.height) - Math.max(mapBox.y, weaponBox.y));
      expect(overlap).toBe(0);
    }

    // Tap toggles aria-pressed.
    await mapBtn.tap();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    await ctx.close();
  });

  test('drawer Galaxy tab opens the in-game ship-swap overview, not the additive overlay', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // Open drawer → Galaxy tab → "Show galaxy map" button. Wait for each
    // surface to actually render before issuing the next click — clicking
    // on something whose ancestor is still mid-mount silently no-ops.
    await page.locator('[data-testid="drawer-toggle"]').click();
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="drawer-tab-galaxy"]').click();
    await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="galaxy-tab-show-map"]').click();

    // Drawer auto-closes; the roster ship-swap overview mounts.
    // Single-canvas refactor: this is GalaxyOverviewSelectChrome
    // (testid `galaxy-overview-select`) — Map A's second Pixi Application
    // is retired, so there is no `galaxy-overview-warp` surface anymore.
    await expect(page.locator('[data-testid="galaxy-overview-select"]')).toBeVisible({ timeout: 5_000 });

    // The additive HUD button stays unaffected.
    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');

    // Close button restores gameplay.
    await page.locator('[data-testid="galaxy-overview-close"]').click();
    await expect(page.locator('[data-testid="galaxy-overview-select"]')).toHaveCount(0);

    await ctx.close();
  });
});
