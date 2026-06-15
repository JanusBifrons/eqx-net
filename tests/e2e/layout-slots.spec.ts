import { test, expect, devices } from '@playwright/test';

/**
 * Layout-slot regression coverage. Phase 1 cases are below; Phase 2
 * (drawer-driven layout, mobile/desktop split, meta landing) extends them.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

const BOOT_URL = `${BASE_URL}/?room=test-sector`;

const APP_BAR_HEIGHT = 48;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BOOT_URL);
  // Vite is warmed once in global-setup, so these boot in a few seconds; the
  // headroom only matters if a contended runner is still slow after warm-up.
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 15_000 });
  // Wait for ShipStatsCard so layout has settled. The Hull/Ammo chip pills
  // that used to live in the HUD were removed in Phase 2 — ShipStatsCard
  // is now the canonical "the game has rendered" signal.
  await page.locator('[data-testid="ship-stats-card"]').waitFor({ timeout: 15_000 });
}

test.describe('layout-slots', () => {
  // ───────────────────────────────────────────────────────────
  // Phase 1 regressions
  // ───────────────────────────────────────────────────────────

  test('ShipStatsCard clears the AppBar (safe-area-top regression)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    const card = page.locator('[data-testid="ship-stats-card"]');
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(APP_BAR_HEIGHT);

    await ctx.close();
  });

  test('mobile landscape: joystick lives in the bottom-left, fire button in the bottom-right', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({
      ...iPhone,
      viewport: { width: 667, height: 375 },
    });
    const page = await ctx.newPage();
    await bootGame(page);

    const joystick = page.locator('[data-testid="mobile-joystick"]');
    const fire = page.locator('[data-testid="mobile-fire"]');
    const autoToggle = page.locator('[data-testid="auto-fire-toggle"]');
    await expect(joystick).toBeVisible();
    // Auto-fire defaults ON → the AUTO toggle is shown and the manual FIRE
    // button is hidden (auto-fire handles firing). Turning AUTO off reveals the
    // original manual FIRE button.
    await expect(autoToggle).toBeVisible();
    await expect(autoToggle).toHaveAttribute('data-state', 'on');
    await expect(fire).toHaveCount(0);
    await autoToggle.click();
    await expect(fire).toBeVisible();

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

  test('portrait orientation does not block input — joystick is interactive', async ({ browser }) => {
    // Portrait used to render a "rotate to landscape" overlay that intercepted
    // every pointer event. That's gone — portrait is now a first-class
    // orientation, and the player can keep playing while holding the phone
    // upright. Landscape is opt-in via the FullscreenToggle.
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({
      ...iPhone,
      viewport: { width: 375, height: 667 },
    });
    const page = await ctx.newPage();
    await bootGame(page);

    await expect(page.locator('[data-testid="portrait-block-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mobile-joystick"]')).toBeVisible();

    // Rotate to landscape — joystick stays interactive, still no overlay.
    await page.setViewportSize({ width: 667, height: 375 });
    await expect(page.locator('[data-testid="portrait-block-overlay"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mobile-joystick"]')).toBeVisible();

    await ctx.close();
  });

  // ───────────────────────────────────────────────────────────
  // Phase 2 — drawer-driven layout, meta landing, mobile-hide AppBar
  // ───────────────────────────────────────────────────────────

  test('AppHeader is hidden on mobile, visible on desktop', async ({ browser }) => {
    // Mobile: AppHeader is `display: none` via MUI sx breakpoint.
    const iPhone = devices['iPhone SE'];
    const mobileCtx = await browser.newContext({ ...iPhone, viewport: { width: 667, height: 375 } });
    const mobilePage = await mobileCtx.newPage();
    await bootGame(mobilePage);
    await expect(mobilePage.locator('[data-testid="app-header"]')).toBeHidden();
    await mobileCtx.close();

    // Desktop: visible at the top.
    const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopCtx.newPage();
    await bootGame(desktopPage);
    await expect(desktopPage.locator('[data-testid="app-header"]')).toBeVisible();
    await desktopCtx.close();
  });

  test('drawer has 4 vertical icon-only tabs in order (galaxy first), debug pinned bottom', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="drawer-toggle"]').click();
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible();

    const galaxy = page.locator('[data-testid="drawer-tab-galaxy"]');
    const profile = page.locator('[data-testid="drawer-tab-profile"]');
    const settings = page.locator('[data-testid="drawer-tab-settings"]');
    const debug = page.locator('[data-testid="drawer-tab-debug"]');

    await expect(galaxy).toBeVisible();
    await expect(profile).toBeVisible();
    await expect(settings).toBeVisible();
    await expect(debug).toBeVisible();

    const [gBox, pBox, sBox, dBox] = await Promise.all([
      galaxy.boundingBox(),
      profile.boundingBox(),
      settings.boundingBox(),
      debug.boundingBox(),
    ]);
    expect(gBox).not.toBeNull();
    expect(pBox).not.toBeNull();
    expect(sBox).not.toBeNull();
    expect(dBox).not.toBeNull();

    // Top three in document order from top-down: galaxy, profile, settings.
    expect(gBox!.y).toBeLessThan(pBox!.y);
    expect(pBox!.y).toBeLessThan(sBox!.y);

    // Debug is pinned to the bottom — its y must be well below settings
    // (the spacer between them flexes to fill).
    expect(dBox!.y).toBeGreaterThan(sBox!.y + sBox!.height + 50);

    // Galaxy is the default-selected tab — its panel renders.
    await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible();

    await ctx.close();
  });

  test('debug tab houses dev-overlay + log-panel, drawer closed → tab unmounted', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    // Drawer closed → drawer body is unmounted (keepMounted is OFF for perf).
    // The dev-overlay therefore is not present in the DOM at all.
    await expect(page.locator('[data-testid="dev-overlay"]')).toHaveCount(0);

    await page.locator('[data-testid="drawer-toggle"]').click();
    await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible();

    // Default tab is Galaxy — dev-overlay still not rendered.
    await expect(page.locator('[data-testid="dev-overlay"]')).toHaveCount(0);

    // Switch to Debug tab — dev-overlay + log-panel mount.
    await page.locator('[data-testid="drawer-tab-debug"]').click();
    await expect(page.locator('[data-testid="dev-overlay"]')).toBeVisible();
    await expect(page.locator('[data-testid="log-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="diag-capture-button"]')).toBeVisible();

    // Closing drawer unmounts again.
    await page.locator('[data-testid="drawer-close"]').click();
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
    await page.locator('[data-testid="drawer-toggle"]').click();
    await page.locator('[data-testid="drawer-tab-galaxy"]').click();
    await expect(page.locator('[data-testid="galaxy-tab-show-map"]')).toBeVisible();

    await ctx.close();
  });

  test('the living galaxy map is shown at the root URL', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE_URL);

    // Living Galaxy P5 — the galaxy map is the landing screen on load; the meta
    // "Join the fight" landing is retired from the default path (kept reachable
    // via Return-to-menu / Logout).
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="meta-landing"]')).toHaveCount(0);

    // The folded landing info (live player count) is surfaced over the map.
    await expect(page.locator('[data-testid="galaxy-landing-player-count"]')).toBeVisible();

    await ctx.close();
  });

  test('Settings tab "Return to menu" routes back to the meta landing', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page); // starts in /?room=test-sector → game phase

    await page.locator('[data-testid="drawer-toggle"]').click();
    await page.locator('[data-testid="drawer-tab-settings"]').click();
    await page.locator('[data-testid="settings-return-to-menu"]').click();

    await expect(page.locator('[data-testid="meta-landing"]')).toBeVisible();
    await expect(page.locator('[data-testid="game-surface"]')).toHaveCount(0);

    await ctx.close();
  });

  test('Profile tab Logout shows confirm dialog and routes to meta on confirm', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="drawer-toggle"]').click();
    // Galaxy is now the default tab — switch to Profile to access logout.
    await page.locator('[data-testid="drawer-tab-profile"]').click();
    const logoutButton = page.locator('[data-testid="profile-tab-logout"]');
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    const confirmDialog = page.locator('[data-testid="logout-confirm-dialog"]');
    await expect(confirmDialog).toBeVisible();

    await page.locator('[data-testid="logout-confirm-button"]').click();

    // Meta landing is now visible; localStorage token has been cleared.
    await expect(page.locator('[data-testid="meta-landing"]')).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).toBeNull();

    await ctx.close();
  });
});
