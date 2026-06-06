import { test, expect, devices } from '@playwright/test';

/**
 * Galaxy Map refactor (2026-05-10) — Map B regression lock.
 *
 * Map B is the in-game additive Pixi overlay (`GalaxyMapLayer`). Post the
 * speed-dial UI refactor (Phase 1) the React-side toggle is the **Map action
 * inside the consolidated bottom-right `SpeedDial`** (`data-testid` still
 * `galaxy-map-toggle`, on the action's Fab), not the old standalone
 * bottom-center MAP button. The action carries `aria-pressed` reflecting the
 * `isGalaxyMapOpen` store flag. The keyboard `M` shortcut is unchanged.
 *
 * The dial collapses its actions to `scale(0)` when closed (in the DOM but not
 * clickable / not "visible"), so any test that CLICKS the Map action must open
 * the dial first via the FAB. Tests that only read `aria-pressed` (the M-key
 * case) can query the attribute directly — it stays readable while collapsed.
 *
 * These specs lock the React-side toggle behaviour. The Pixi-side draw is
 * covered by the manual UX walk and the renderer's pure-graph adjacency logic
 * in `src/core/galaxy/galaxy.test.ts`. The wire/server-side neighbour
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

/**
 * Open the consolidated SpeedDial and wait for the Map action to expand into
 * its clickable state. Idempotent for the purposes of these tests — they call
 * it again before each click because clicking an action collapses the dial.
 */
async function openDial(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeVisible({ timeout: 5_000 });
}

test.describe('galaxy-map overlay (Map B)', () => {
  test('desktop: MAP action in the speed-dial is reachable and reflects the open state', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');

    // Open the dial → the Map action expands and reads "closed" (overlay off).
    await openDial(page);
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');

    // Click the action → overlay opens (and the dial collapses).
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    // Re-open the dial, click again → overlay closes.
    await openDial(page);
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

  test('mobile: MAP and weapon-slot actions both live inside the consolidated dial', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');
    // Speed-dial UI refactor (Phase 1): the MAP toggle and the weapon-slot
    // selector are now sibling actions in the same SpeedDial (replacing the
    // old scattered bottom-center MAP button + thumb-cluster slot toggle).
    const weaponBtn = page.locator('[data-testid="slot-selector"]');

    // Collapsed: actions are in the DOM but not visible (scale 0).
    await expect(mapBtn).toBeHidden();
    await expect(weaponBtn).toBeHidden();

    // Open the dial → both actions expand and become reachable.
    await page.locator('[data-testid="speed-dial-fab"]').tap();
    await expect(mapBtn).toBeVisible();
    await expect(weaponBtn).toBeVisible();

    // MUI lays the actions out in a column, so they never overlap.
    const mapBox = await mapBtn.boundingBox();
    const weaponBox = await weaponBtn.boundingBox();
    expect(mapBox).not.toBeNull();
    expect(weaponBox).not.toBeNull();
    if (mapBox && weaponBox) {
      const overlap =
        Math.max(0, Math.min(mapBox.x + mapBox.width, weaponBox.x + weaponBox.width) - Math.max(mapBox.x, weaponBox.x))
        * Math.max(0, Math.min(mapBox.y + mapBox.height, weaponBox.y + weaponBox.height) - Math.max(mapBox.y, weaponBox.y));
      expect(overlap).toBe(0);
    }

    // Tap the MAP action → overlay opens.
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
