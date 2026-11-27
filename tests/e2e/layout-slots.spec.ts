import { test, expect, devices } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Layout-slot regression coverage. Phase 1 cases are below; Phase 2
 * (drawer-driven layout, mobile/desktop split, meta landing) extends them.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

const BOOT_URL = `${BASE_URL}/?room=test-sector`;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BOOT_URL);
  // INFRASTRUCTURAL cost, not game-time (so a budget bump is the sanctioned fix —
  // root CLAUDE.md "Test-harness philosophy"): under sharding each shard's first
  // boot pays the dev `vite` cold module-graph compile, which far exceeds the old
  // 10 s waits — the recurring `layout-slots` flake. 30 s each (+ a 90 s
  // describe timeout below) covers a cold compile + Colyseus join + spawn on a
  // contended runner; warm boots finish in ~3 s and never approach it.
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
  // Wait for the top-left sector-info panel so layout has settled. The Phase-5
  // removal of the top-right ShipStatsCard made the always-present top-left
  // SectorInfoPanel the canonical "the game has rendered" signal.
  await page.locator('[data-testid="hud-sector"]').waitFor({ timeout: 30_000 });
}

test.describe('layout-slots', () => {
  // The bootGame cold-compile/join cost (above) can exceed the global 30 s
  // per-test cap on the first boot of a contended-runner shard; give this
  // boot-heavy layout suite headroom. Warm tests finish in a few seconds, so
  // this budget is unused in the common case (it is NOT a game-time wait).
  test.describe.configure({ timeout: 90_000 });

  // ───────────────────────────────────────────────────────────
  // Phase 1 regressions
  // ───────────────────────────────────────────────────────────

  test('top-left sector panel clears the reserved top band (safe-area-top regression)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // The always-present top-left SectorInfoPanel must sit below whatever top
    // band the page reserves (`--app-bar-h`). UI plan U5-3 removed the in-game
    // top bar, so the band is 0 in game; the guard still catches a panel drawn
    // above the band or off the top of the screen.
    const band = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-bar-h')) || 0,
    );
    const card = page.locator('[data-testid="hud-sector"]');
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(band);

    await ctx.close();
  });

  test('mobile landscape: move stick lives in the bottom-left, the Boost hex in the bottom-right', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({
      ...iPhone,
      viewport: { width: 667, height: 375 },
    });
    const page = await ctx.newPage();
    await bootGame(page);

    const joystick = page.locator('[data-testid="hud-move-home"]');
    // The right thumb is the do-hexes with Boost under it, bottom-right (the touch lock-line stick was
    // removed 2026-11-27: lock by tapping a ship). There is no FIRE button.
    const fire = page.locator('[data-testid="do-hex-boost"]');
    await expect(page.locator('[data-testid="hud-lock-home"]')).toHaveCount(0);
    await expect(joystick).toBeVisible();
    await expect(fire).toBeVisible();
    await expect(page.locator('[data-testid="mobile-fire"]')).toHaveCount(0);

    const joyBox = await joystick.boundingBox();
    const fireBox = await fire.boundingBox();
    expect(joyBox).not.toBeNull();
    expect(fireBox).not.toBeNull();

    // Quadrant placement is asserted on each control's CENTRE, not its top-left
    // corner — the joystick is a 120 px disc, so its top edge sits above the
    // viewport midline even when the control is firmly in the bottom-left thumb
    // zone (centre y ≈ 215 in a 375 px viewport). Top-edge checks are an
    // over-strict proxy for "is it in this quadrant".
    const cx = (b: NonNullable<typeof joyBox>) => b.x + b.width / 2;
    const cy = (b: NonNullable<typeof joyBox>) => b.y + b.height / 2;

    // Joystick is in the bottom-left quadrant.
    expect(cx(joyBox!)).toBeLessThan(667 / 2);
    expect(cy(joyBox!)).toBeGreaterThan(375 / 2);

    // Fire is in the bottom-right quadrant.
    expect(cx(fireBox!)).toBeGreaterThan(667 / 2);
    expect(cy(fireBox!)).toBeGreaterThan(375 / 2);

    // The two thumb zones don't overlap horizontally.
    expect(joyBox!.x + joyBox!.width).toBeLessThan(fireBox!.x);

    await ctx.close();
  });

  test('upright phone shows the turn-sideways screen; sideways shows the game', async ({ browser }) => {
    // Phones play sideways. Upright, a full-screen picture asks the player to
    // turn the phone and covers (and blocks) the controls; turned sideways it
    // goes away. Full screen waits for the first tap (UI plan U5-3; unit lock:
    // useFirstTapFullscreen.test.tsx). Guide: docs/features/mobile-layout.md
    // "Orientation policy".
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({
      ...iPhone,
      viewport: { width: 375, height: 667 },
    });
    const page = await ctx.newPage();
    await bootGame(page);

    await expect(page.locator('[data-testid="rotate-phone-overlay"]')).toBeVisible();
    await expect(page.locator('[data-testid="rotate-phone-overlay"]')).toContainText('Turn your phone sideways');

    await page.setViewportSize({ width: 667, height: 375 });
    await expect(page.locator('[data-testid="rotate-phone-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="hud-move-home"]')).toBeVisible();
    // Never full screen by itself: no tap yet.
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);

    await ctx.close();
  });

  test('desktop never shows the turn-sideways screen, even in a tall window', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 700, height: 1000 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await expect(page.locator('[data-testid="rotate-phone-overlay"]')).toHaveCount(0);
    await ctx.close();
  });

  // ───────────────────────────────────────────────────────────
  // Phase 2 — drawer-driven layout, meta landing, mobile-hide AppBar
  // ───────────────────────────────────────────────────────────

  test('the game has no top bar on mobile or desktop', async ({ browser }) => {
    // UI plan U5-3: the in-game AppHeader went (the rail's cog holds settings and account).
    const iPhone = devices['iPhone SE'];
    const mobileCtx = await browser.newContext({ ...iPhone, viewport: { width: 667, height: 375 } });
    const mobilePage = await mobileCtx.newPage();
    await bootGame(mobilePage);
    await expect(mobilePage.locator('[data-testid="app-header"]')).toHaveCount(0);
    await mobileCtx.close();

    // Desktop: none either; the rail's cog is there instead.
    const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopCtx.newPage();
    await bootGame(desktopPage);
    await expect(desktopPage.locator('[data-testid="app-header"]')).toHaveCount(0);
    await expect(desktopPage.locator('[data-testid="right-rail-cog"]')).toBeVisible();
    await desktopCtx.close();
  });

  test('each rail item opens only its own pages: no tab column inside the panel', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // Galaxy: one page, no page switch and no other panel's tabs.
    await page.locator('[data-testid="right-rail-galaxy"]').click();
    await expect(page.locator('[data-testid="galaxy-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="galaxy-panel-body"]')).toBeVisible();
    await expect(page.locator('[data-testid="drawer-tab"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="drawer-tab-trade"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="drawer-tab-settings"]')).toHaveCount(0);

    // The cog: its own scrolling panel, Profile and Developer as drill-down rows.
    await page.locator('[data-testid="right-rail-cog"]').click();
    await expect(page.locator('[data-testid="cog-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="cog-page-settings"]')).toBeVisible();
    for (const id of ['profile', 'developer']) {
      await expect(page.locator(`[data-testid="cog-row-${id}"]`)).toBeVisible();
    }
    await expect(page.locator('[data-testid="drawer-tab"]')).toHaveCount(0);

    await ctx.close();
  });

  test('cog Developer page houses dev-overlay + log-panel, panel closed → unmounted', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // Drawer closed → drawer body is unmounted (keepMounted is OFF for perf).
    // The dev-overlay therefore is not present in the DOM at all.
    await expect(page.locator('[data-testid="dev-overlay"]')).toHaveCount(0);

    await page.locator('[data-testid="right-rail-cog"]').click();
    await expect(page.locator('[data-testid="cog-panel"]')).toBeVisible();

    // The Settings page shows first — dev-overlay still not rendered.
    await expect(page.locator('[data-testid="dev-overlay"]')).toHaveCount(0);

    // Drill into Developer — dev-overlay + log-panel mount.
    await page.locator('[data-testid="cog-row-developer"]').click();
    await expect(page.locator('[data-testid="dev-overlay"]')).toBeVisible();
    await expect(page.locator('[data-testid="log-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="diag-capture-button"]')).toBeVisible();

    // Closing the panel unmounts again.
    await page.locator('[data-testid="cog-close"]').click();
    await expect(page.locator('[data-testid="dev-overlay"]')).toHaveCount(0);

    await ctx.close();
  });

  test('floating MAP button has been removed from the in-game UI', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 667, height: 375 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // The floating MAP button used to live in the top-center slot. After
    // Phase 2, the galaxy map is opened from the drawer's Galaxy tab.
    await expect(page.locator('[data-testid="mobile-map-button"]')).toHaveCount(0);

    // Galaxy tab still provides the action.
    await page.locator('[data-testid="right-rail-galaxy"]').click();
    await expect(page.locator('[data-testid="galaxy-open-map"]')).toBeVisible();

    await ctx.close();
  });

  test('the living galaxy map is shown at the root URL', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE_URL);

    // The galaxy map is the homepage: the first screen on load.
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

    // The folded landing info (live player count) is surfaced over the map.
    await expect(page.locator('[data-testid="galaxy-landing-player-count"]')).toBeVisible();

    await ctx.close();
  });

  test('cog "Return to menu" routes back to the galaxy map', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page); // starts in /?room=test-sector → game phase

    await page.locator('[data-testid="right-rail-cog"]').click();
    await page.locator('[data-testid="settings-return-to-menu"]').click();

    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    // Left the game: the in-game rail is gone (the map shares the canvas).
    await expect(page.locator('[data-testid="right-rail-galaxy"]')).toHaveCount(0);

    await ctx.close();
  });

  test('cog Profile Log out confirms inline and routes to the galaxy map on confirm', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // The cog opens the Settings page; Profile is a drill-down row on it.
    await page.locator('[data-testid="right-rail-cog"]').click();
    await page.locator('[data-testid="cog-row-profile"]').click();
    const logoutButton = page.locator('[data-testid="cog-profile-logout"]');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    // Inline confirm: the button turns into "Confirm log out" in place.
    const confirm = page.locator('[data-testid="cog-profile-logout-confirm"]');
    await expect(confirm).toBeVisible();
    await confirm.click();

    // The galaxy map is back; localStorage token has been cleared.
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).toBeNull();

    await ctx.close();
  });
});
