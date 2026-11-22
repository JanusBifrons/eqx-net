import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * The Build panel (BuildSidebarHost.tsx → panels/BuildPanel.tsx) and the right
 * rail's Galaxy item. The speed dial and the ☰ drawer button are gone (UI
 * language plan A7): the right rail opens every panel, the Galaxy page holds
 * Map and Warp, and the rail's Build item opens the Build panel.
 *
 * What this locks:
 *   1. The rail's Galaxy item opens the drawer on the Galaxy page, with the
 *      "Show galaxy map" button (the old dial Map action).
 *
 * Build menu redesign M1 (the Build sidebar replaced the dial's build drill):
 *   2. In Build, the rail's Build item opens the right-hand Build panel
 *      (category rail + kind tiles); entering Build opens nothing (U2-1).
 *   3. A rail tap switches the category.
 *   4. Picking a kind hides the sidebar. Confirm KEEPS placing the same
 *      building (M3) with it hidden; Cancel, or a place-once kind (Capital)
 *      placed, brings it back on the same category for the next structure.
 *   5. The sidebar's ✕ and Escape close it.
 *
 * Boot uses the controlled `test-sector-fast` engineering room (testMode, no
 * drones) so the HUD settles quickly and the rail mounts.
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
  // The HUD gates on `useShouldRenderHud()` — wait for the rail to mount.
  await page.locator('[data-testid="right-rail"]').waitFor({ timeout: 10_000 });
  return { ctx, page };
}

function swarmCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid="swarm-count"]')
    .textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
}

test('the rail Galaxy item opens the Galaxy page with the map button', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.locator('[data-testid="right-rail-galaxy"]').click();
    await expect(page.locator('[data-testid="galaxy-panel"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="galaxy-open-map"]')).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctx.close();
  }
});

// ── Build menu redesign M1 — the Build sidebar ─────────────────────────────

async function openBuildSidebar(page: Page): Promise<void> {
  // Build mode is the only way to build (owner 2026-11-22). Entering Build opens
  // nothing (UI language plan U2-1): the rail's Build item opens the panel.
  await page.locator('[data-testid="build-toggle"]').click();
  await page.locator('[data-testid="right-rail-build"]').click();
  await expect(page.locator('[data-testid="build-sidebar"][data-open="1"]')).toBeVisible({ timeout: 5_000 });
}

test('Build opens the Build sidebar with its category rail', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await openBuildSidebar(page);
    for (const id of ['core', 'economy', 'defence']) {
      await expect(page.locator(`[data-testid="build-cat-${id}"]`)).toBeVisible();
    }
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

test('Place keeps placing with the left-strip placing tools; ✕ brings the sidebar back on the same category', async ({ browser }) => {
  // Joins as a touch device (the two-step tap → Place flow).
  const { ctx, page } = await joinClient(browser, true);
  try {
    await openBuildSidebar(page);
    await page.locator('[data-testid="build-cat-economy"]').click();

    // Picking a kind raises the ghost, closes the sidebar and shows the left
    // strip's placing tools (the building, ✓, rotate, mirror, ✕) (U3-7).
    await page.locator('[data-testid="build-solar"] button').click();
    await expect(page.locator('[data-testid="placement-kind"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="placement-kind"]')).toHaveAttribute('data-state', 'solar');
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();

    // The building icon reopens the full sidebar (the strip hides) with
    // placement live; its ✕ folds back to the strip.
    await page.locator('[data-testid="placement-kind"]').click();
    await expect(page.locator('[data-testid="build-rail"]')).toBeVisible();
    await expect(page.locator('[data-testid="left-strip"]')).toHaveAttribute('data-open', 'false');
    await expect(page.locator('[data-testid="placement-kind"]')).toHaveAttribute('data-state', 'solar');
    await page.locator('[data-testid="build-sidebar-close"]').click();
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();
    await expect(page.locator('[data-testid="left-strip"]')).toHaveAttribute('data-open', 'true');
    await expect(page.locator('[data-testid="placement-kind"]')).toBeVisible();

    // THE LOCK (M3): Confirm keeps you placing the same building; the
    // sidebar stays closed, the placing tools stay.
    await page.locator('[data-testid="placement-confirm"]').click();
    await expect(page.locator('[data-testid="placement-kind"]')).toBeVisible();
    await expect(page.locator('[data-testid="placement-kind"]')).toHaveAttribute('data-state', 'solar');
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();

    // Cancel ends it: the sidebar is back on Economy, the next pick one tap.
    await page.locator('[data-testid="placement-cancel"]').click();
    await expect(page.locator('[data-testid="placement-kind"]')).toBeHidden();
    await expect(page.locator('[data-testid="build-kinds"]')).toHaveAttribute('data-category', 'economy', { timeout: 5_000 });
    await expect(page.locator('[data-testid="build-solar"]')).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test('a Capital places once: Confirm ends placement and brings the sidebar back', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, true);
  try {
    const before = await swarmCount(page);
    await openBuildSidebar(page);
    await page.locator('[data-testid="build-cat-core"]').click();
    await page.locator('[data-testid="build-capital"] button').click();
    await expect(page.locator('[data-testid="placement-kind"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="build-capital"]')).toBeHidden();
    await expect(page.locator('[data-testid="placement-kind"]')).toHaveAttribute('data-state', 'capital');

    await page.locator('[data-testid="placement-confirm"]').click();
    await page.waitForFunction((b) => {
      const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
      return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
    }, before, { timeout: 8_000 });

    await expect(page.locator('[data-testid="placement-kind"]')).toBeHidden();
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
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

    await page.locator('[data-testid="right-rail-build"]').click(); // already in Build: the rail item reopens it
    await expect(page.locator('[data-testid="build-sidebar"][data-open="1"]')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="build-rail"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});
