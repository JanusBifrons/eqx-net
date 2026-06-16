import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Living Galaxy P5 — landing-flow merge regression locks.
 *
 * The live galaxy map is now the FIRST screen on load (initial phase
 * 'galaxy-map'); the standalone "Join the fight!" MetaLandingScreen is retired
 * from the default path. Spawning is auth-gated ON THE PICK: a logged-out pilot
 * can browse the map freely, but picking a sector routes through the auth flow
 * and, on return, the picker auto-opens for the STASHED sector (no re-tap).
 * Deep-links (?room=/?galaxy=) still skip straight to the game.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForGalaxyPickHook(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __eqxGalaxyPick?: unknown }).__eqxGalaxyPick === 'function',
    null,
    { timeout: 10_000 },
  );
}

const pickSector = (page: Page, key = 'sol-prime'): Promise<void> =>
  page.evaluate((k) => {
    (window as unknown as { __eqxGalaxyPick?: (s: string) => void }).__eqxGalaxyPick?.(k);
  }, key);

test('map-on-load: the living galaxy map is the first screen, with folded landing info', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
  // The retired MetaLandingScreen is out of the default load path.
  await expect(page.locator('[data-testid="meta-landing"]')).toHaveCount(0);
  // Folded landing info (live player count) is surfaced over the map.
  await expect(page.locator('[data-testid="galaxy-landing-player-count"]')).toBeVisible();
});

test('logged-in pick → ship picker opens directly (no auth detour)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
  await waitForGalaxyPickHook(page);
  // Establish a logged-in user deterministically (DEV hook) so the result is
  // independent of the global storageState's JWT, then pick a sector.
  await page.evaluate(() => {
    (window as unknown as { __eqxSetAuthUser?: (n?: string) => void }).__eqxSetAuthUser?.();
  });
  await pickSector(page);
  // Equinox Phase 7 (Item 4) — a pick now opens the interactive sector popover;
  // "Join the fight" opens the ship picker (the flow is no longer one-click).
  await expect(page.getByTestId('galaxy-sector-popover')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('galaxy-popover-join').click();
  await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 8_000 });
  // A logged-in pilot is NOT detoured through the auth flow.
  await expect(page.locator('text=Continue as guest')).toHaveCount(0);
});

test('deep-link ?room= still skips straight to the game', async ({ page }) => {
  await page.goto(`${BASE_URL}/?room=test-sector`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await expect(page.locator('[data-testid="game-surface"]')).toBeVisible({ timeout: 20_000 });
  // The galaxy-map landing chrome is idle-only — never shown in the game phase.
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toHaveCount(0);
});

test.describe('logged-out (auth-gated pick)', () => {
  // Clean, logged-out context — overrides the global pre-auth storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('picking a sector while logged-out routes to the auth flow', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    await waitForGalaxyPickHook(page);
    await pickSector(page);
    // The auth flow (LoginPage "Continue as guest") — NOT the ship picker.
    await expect(page.locator('text=Continue as guest')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('ship-picker-modal')).toHaveCount(0);
  });

  test('after auth (guest), the picker auto-opens for the stashed sector', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    await waitForGalaxyPickHook(page);
    await pickSector(page);
    await page.locator('text=Continue as guest').click();
    // Back on the map; the popover auto-opens for the stashed sector (no re-tap);
    // "Join the fight" then opens the ship picker (Equinox Phase 7 / Item 4).
    await expect(page.getByTestId('galaxy-sector-popover')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('galaxy-popover-join').click();
    await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 8_000 });
  });
});
