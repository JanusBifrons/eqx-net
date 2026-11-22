import { test, expect } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Header avatar → cog Profile page — desktop header path (UI plan U2-8b).
 *
 * Regression lock for the logout flow (plan: avatar-menu-logout). The header
 * avatar opens the cog panel on its Profile page (name, account, Log out);
 * Log out is gated by an INLINE confirm ("Confirm log out" in place, no
 * dialog) and, on confirm, performs a REAL logout: returns to the galaxy map
 * + clears the token.
 *
 * Auth: every E2E context is primed with a real JWT by `global-setup.ts`
 * (storageState), so `bootGame` lands in the game phase with the header avatar
 * rendered. The avatar only mounts when `useAuthStore.user` is set.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const BOOT_URL = `${BASE_URL}/?room=test-sector`;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BOOT_URL);
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 10_000 });
  await page.locator('[data-testid="hud-sector"]').waitFor({ timeout: 10_000 });
}

test.describe('header avatar → cog Profile (desktop)', () => {
  test('the avatar opens the cog on the Profile page', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="header-avatar"]').click();
    await expect(page.locator('[data-testid="cog-page-profile"]')).toBeVisible();
    await expect(page.locator('[data-testid="cog-profile-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="cog-profile-display-name"]')).toBeVisible();
    // Still logged in — opening the page must not log out.
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).not.toBeNull();

    await ctx.close();
  });

  test('Log out asks inline and routes to the galaxy map on confirm', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="header-avatar"]').click();
    await page.locator('[data-testid="cog-profile-logout"]').click();

    const confirm = page.locator('[data-testid="cog-profile-logout-confirm"]');
    await expect(confirm).toBeVisible();
    // Not logged out yet — the confirm gate must hold.
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(0);

    await confirm.click();

    // Real logout: back to the galaxy map (the homepage) + token cleared.
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).toBeNull();

    await ctx.close();
  });

  test('Cancel keeps the user logged in', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="header-avatar"]').click();
    await page.locator('[data-testid="cog-profile-logout"]').click();
    await expect(page.locator('[data-testid="cog-profile-logout-confirm"]')).toBeVisible();

    await page.locator('[data-testid="cog-profile-logout-cancel"]').click();

    await expect(page.locator('[data-testid="cog-profile-logout-confirm"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cog-profile-logout"]')).toBeVisible();
    await expect(page.locator('[data-testid="game-surface"]')).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).not.toBeNull();

    await ctx.close();
  });
});
