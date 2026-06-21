import { test, expect } from '@playwright/test';

/**
 * Avatar context menu — desktop header path.
 *
 * Regression lock for the logout flow (plan: avatar-menu-logout). Before this
 * change the header avatar's "Logout" only called `clearAuth()` with no phase
 * transition, so the user stayed sitting in-game; the mobile badge had no menu
 * at all. This spec drives the desktop popover menu end-to-end:
 *   - the avatar opens a Popover with "Display name" + "Logout";
 *   - "Display name" opens the ProfileModal (display-name editor);
 *   - "Logout" gates behind a confirm dialog (user decision) and, on confirm,
 *     performs a REAL logout: returns to the meta landing + clears the token.
 *
 * Auth: every E2E context is primed with a real JWT by `global-setup.ts`
 * (storageState), so `bootGame` lands in the game phase with the header avatar
 * rendered. The desktop AvatarMenu only mounts when `useAuthStore.user` is set.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const BOOT_URL = `${BASE_URL}/?room=test-sector`;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BOOT_URL);
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 10_000 });
  await page.locator('[data-testid="sector-info-panel"]').waitFor({ timeout: 10_000 });
}

test.describe('avatar-menu logout (desktop)', () => {
  test('"Display name" opens the ProfileModal', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="avatar-menu-trigger"]').click();
    await expect(page.locator('[data-testid="avatar-menu-display-name"]')).toBeVisible();
    await page.locator('[data-testid="avatar-menu-display-name"]').click();

    await expect(page.locator('[data-testid="profile-modal"]')).toBeVisible();
    // Still logged in — opening the editor must not log out.
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).not.toBeNull();

    await ctx.close();
  });

  test('Logout shows a confirm dialog and routes to meta on confirm', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="avatar-menu-trigger"]').click();
    await page.locator('[data-testid="avatar-menu-logout"]').click();

    const confirmDialog = page.locator('[data-testid="avatar-logout-confirm-dialog"]');
    await expect(confirmDialog).toBeVisible();
    // Not logged out yet — the confirm gate must hold.
    await expect(page.locator('[data-testid="meta-landing"]')).toHaveCount(0);

    await page.locator('[data-testid="avatar-logout-confirm-button"]').click();

    // Real logout: back to the main menu + token cleared.
    await expect(page.locator('[data-testid="meta-landing"]')).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).toBeNull();

    await ctx.close();
  });

  test('cancelling the confirm dialog keeps the user logged in', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);

    await page.locator('[data-testid="avatar-menu-trigger"]').click();
    await page.locator('[data-testid="avatar-menu-logout"]').click();
    await expect(page.locator('[data-testid="avatar-logout-confirm-dialog"]')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.locator('[data-testid="avatar-logout-confirm-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="game-surface"]')).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('eqxAuthToken'));
    expect(token).not.toBeNull();

    await ctx.close();
  });
});
