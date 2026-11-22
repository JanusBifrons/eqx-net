import { test, expect, devices } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Galaxy Map refactor (2026-05-10) — Map B regression lock.
 *
 * Map B is the in-game full-page warp map (`GalaxyPickerChrome`
 * context='warp', testid `galaxy-map-screen`), shown while the
 * `isGalaxyMapOpen` store flag is set. The speed dial's Map action is gone
 * (UI language plan A7): the way in is the right rail's Galaxy item → the
 * Galaxy page's "Show galaxy map" button, and the keyboard `M` shortcut.
 *
 * These specs lock the React-side toggle behaviour. The Pixi-side draw is
 * covered by the manual UX walk and the renderer's pure-graph adjacency logic
 * in `src/core/galaxy/galaxy.test.ts`. The wire/server-side neighbour
 * enforcement is locked by `src/server/transit/TransitOrchestrator.test.ts`.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
// `?galaxy=sol-prime` autoJoins the Sol Prime sector room so the spawn-select
// flow is bypassed. Sol Prime is the centre node, so all six other sectors
// are neighbours — useful for covering the "selectable" tier visually.
const BOOT_URL = `${BASE_URL}/?galaxy=sol-prime&startMode=fly`;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  // First navigation under Playwright's CI mode hits a cold Vite dev server
  // — initial transform of all client modules can take 30+ s. Use
  // `domcontentloaded` (not the default `load`) so we don't block on every
  // chunk finishing, and bump the timeout for the cold path.
  await page.goto(BOOT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
  await page.locator('[data-testid="hud-sector"]').waitFor({ timeout: 30_000 });
}

test.describe('galaxy-map overlay (Map B)', () => {
  test('desktop: keyboard M opens and closes the map', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const mapScreen = page.locator('[data-testid="galaxy-map-screen"]');
    await expect(mapScreen).toHaveCount(0);

    // M key opens.
    await page.keyboard.press('m');
    await expect(mapScreen).toBeVisible({ timeout: 5_000 });

    // M key closes.
    await page.keyboard.press('m');
    await expect(mapScreen).toHaveCount(0);

    await ctx.close();
  });

  test('mobile: the rail Galaxy page opens the map', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 667, height: 375 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="right-rail-galaxy"]').tap();
    const showMap = page.locator('[data-testid="galaxy-tab-show-map"]');
    await expect(showMap).toBeVisible({ timeout: 5_000 });
    await showMap.tap();
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 5_000 });

    await ctx.close();
  });

  test('drawer Galaxy tab opens the full-page galaxy map (Equinox Phase 8 / Bug 4)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // Open drawer → Galaxy tab → "Show galaxy map" button. Wait for each
    // surface to actually render before issuing the next click — clicking
    // on something whose ancestor is still mid-mount silently no-ops.
    await page.locator('[data-testid="right-rail-galaxy"]').click();
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="galaxy-tab-show-map"]').click();

    // Equinox Phase 8 (Bug 4): the drawer button now opens the REAL full-page
    // galaxy map (the warp-context GalaxyPickerChrome over the Pixi selector
    // layer), NOT the old roster-scrim overview (`galaxy-overview-select`).
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="galaxy-overview-select"]')).toHaveCount(0);

    // Close button restores gameplay.
    await page.locator('[data-testid="galaxy-warp-close"]').click();
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(0);

    await ctx.close();
  });
});
