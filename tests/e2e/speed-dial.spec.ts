import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

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
 * Build menu redesign M1 (the Build sidebar replaced the dial's build drill):
 *   6. Build opens the right-hand Build sidebar (category rail + kind tiles)
 *      and collapses the dial.
 *   7. A rail tap switches the category.
 *   8. Picking a kind hides the sidebar; Confirm brings it back on the same
 *      category, so the next structure is one tap away.
 *   9. The sidebar's ✕ and Escape close it; the FAB opens the main menu.
 *
 * The held controls (joystick / FIRE / BOOST) deliberately stay OUT of the
 * dial — that contract is covered by `layout-slots.spec.ts`.
 *
 * Boot uses the controlled `test-sector-fast` engineering room (testMode, no
 * drones) so the HUD settles quickly and the dial mounts.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

async function joinClient(browser: Browser, touch = false): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: touch });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    }, undefined,
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

function swarmCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid="swarm-count"]')
    .textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
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

test('hovering the FAB first does not make the click close the dial', async ({ browser }) => {
  // MUI SpeedDial opens on 'mouseEnter' / 'focus' after a 0 ms timer. If that
  // timer fired before the click (a hover, or a slow CI runner between
  // Playwright's mousemove and click), the click saw the dial open and toggled
  // it shut. That made the build / dial specs time out on CI. Bespoke trigger:
  // hover, let the 0 ms timer run, then click.
  const { ctx, page } = await joinClient(browser);
  try {
    const fab = page.locator('[data-testid="speed-dial-fab"]');
    await fab.hover();
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeHidden();
    await fab.click();
    await expect(page.locator('[data-testid="galaxy-map-toggle"]')).toBeVisible({ timeout: 5_000 });
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

// ── Build menu redesign M1 — the Build sidebar ─────────────────────────────

async function openBuildSidebar(page: Page): Promise<void> {
  await openDial(page);
  await page.locator('[data-testid="speed-dial-build"]').click();
  await expect(page.locator('[data-testid="build-sidebar"][data-open="1"]')).toBeVisible({ timeout: 5_000 });
}

test('Build opens the Build sidebar with its category rail and closes the dial', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openBuildSidebar(page);
    for (const id of ['core', 'economy', 'defence']) {
      await expect(page.locator(`[data-testid="build-cat-${id}"]`)).toBeVisible();
    }
    // The dial's main actions collapse: the sidebar owns the build list now.
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('a rail tap switches the sidebar to that category', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openBuildSidebar(page);
    await page.locator('[data-testid="build-cat-defence"]').click();
    await expect(page.locator('[data-testid="build-turret"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-cat-defence"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-testid="build-cat-core"]').click();
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-turret"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('a pick hides the sidebar and Confirm brings it back on the same category', async ({ browser }) => {
  // The Confirm banner is the TOUCH placement flow (desktop places on click),
  // so this test joins as a touch device.
  const { ctx, page } = await joinClient(browser, true);
  try {
    const before = await swarmCount(page);
    await openBuildSidebar(page);
    await page.locator('[data-testid="build-cat-core"]').click();

    // Picking a kind raises the ghost and hides the sidebar, so it never
    // covers the ghost.
    await page.locator('[data-testid="build-capital"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="build-capital"]')).toBeHidden();

    await page.locator('[data-testid="placement-confirm"]').click();
    await page.waitForFunction((b) => {
      const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
      return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
    }, before, { timeout: 8_000 });

    // THE LOCK: the sidebar is back on Core, so the next structure is one tap.
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});

test('the sidebar ✕ and Escape close it', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openBuildSidebar(page);
    await page.locator('[data-testid="build-sidebar-close"]').click();
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();

    await openBuildSidebar(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('the FAB re-opens the dial at its main menu after a build', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openBuildSidebar(page);
    await page.locator('[data-testid="build-sidebar-close"]').click();
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();

    // The dial has no build drill any more: it always opens at the main menu.
    await openDial(page);
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="speed-dial-build"]')).toBeVisible();
    await expect(page.locator('[data-testid="build-capital"]')).toBeHidden();
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await expect(page.locator('[data-testid="speed-dial-menu"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});
