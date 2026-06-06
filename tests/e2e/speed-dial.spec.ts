import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Speed-dial UI refactor (Phase 1) — regression lock for the consolidated
 * bottom-right `SpeedDial` that now hosts the game's discrete (tap) HUD
 * actions: Panels (open drawer), Map (toggle the galaxy overlay), and
 * weapon-slot select. These used to be three separate widgets scattered across
 * the top-right toolbar, bottom-center, and the bottom thumb cluster.
 *
 * What this locks:
 *   1. The dial FAB is present in-game; its actions are collapsed until opened.
 *   2. Opening the dial reveals all three actions.
 *   3. The Menu action opens the AdvancedDrawer.
 *   4. The Map action toggles the galaxy overlay (aria-pressed on the action).
 *   5. The weapon-slot action is reachable and carries its slot id.
 *
 * The held controls (joystick / FIRE / BOOST) deliberately stay OUT of the
 * dial — that contract is covered by `layout-slots.spec.ts`.
 *
 * Boot uses the controlled `test-sector-fast` engineering room (testMode, no
 * drones) so the HUD settles quickly and the dial mounts.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
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
  // The dial gates on `useShouldRenderHud()` — wait for the FAB to mount.
  await page.locator('[data-testid="speed-dial-fab"]').waitFor({ timeout: 10_000 });
  return { ctx, page };
}

async function openDial(page: Page): Promise<void> {
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeVisible({ timeout: 5_000 });
}

test('dial actions are collapsed until the FAB is opened', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    // Actions exist in the DOM but are collapsed (scale 0 → not visible).
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeHidden();
    await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeHidden();
    await expect(page.locator('[data-testid="slot-selector"]')).toBeHidden();

    await openDial(page);

    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="slot-selector"]')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('Menu action opens the AdvancedDrawer', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);
    await page.locator('[data-testid="speed-dial-menu"]').click();
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});

test('Map action toggles the galaxy overlay', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const mapBtn = page.locator('[data-testid="galaxy-map-toggle"]');

    await openDial(page);
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'true');

    // Toggling closes the dial — re-open to flip it back.
    await openDial(page);
    await mapBtn.click();
    await expect(mapBtn).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await ctx.close();
  }
});

test('weapon-slot action is reachable and carries its slot id', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openDial(page);
    const slotBtn = page.locator('[data-testid="slot-selector"]');
    await expect(slotBtn).toBeVisible();
    // Every gameplay ship has at least one slot; the action exposes which slot
    // is hot via data-slot-id (forward-compatible with multi-slot cycling).
    await expect(slotBtn).toHaveAttribute('data-slot-id', /.+/);
    // Activating it is a safe no-op for a single-slot ship and collapses the
    // dial (no throw / no broken state).
    await slotBtn.click();
    await expect(slotBtn).toBeHidden();
  } finally {
    await ctx.close();
  }
});
