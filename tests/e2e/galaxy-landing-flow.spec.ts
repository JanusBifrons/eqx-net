import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * The galaxy map is the homepage — regression locks.
 *
 * The live galaxy map is the FIRST screen on load for every visitor (initial
 * phase 'galaxy-map'; there is no other landing screen). A logged-out visitor
 * can tap any sector and see its focus view; login is asked for only on
 * "Join the fight", and on return the ship picker opens for the STASHED sector
 * (no re-tap). Deep-links (?room=/?galaxy=) still skip straight to the game.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

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
  await expect(page.getByTestId('sector-drawer-join')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('sector-drawer-join').click();
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

test.describe('logged-out (auth-gated Join the fight)', () => {
  // Clean, logged-out context — overrides the global pre-auth storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a logged-out tap opens the sector; only Join the fight asks for login', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    await waitForGalaxyPickHook(page);
    await pickSector(page);
    // The tap shows the sector (no login wall)...
    await expect(page.getByTestId('sector-drawer-join')).toHaveText(/Join the fight/, { timeout: 8_000 });
    await expect(page.locator('text=Continue as guest')).toHaveCount(0);
    // ...and Join the fight goes to the auth flow, NOT the ship picker.
    await page.getByTestId('sector-drawer-join').click();
    await expect(page.locator('text=Continue as guest')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('ship-picker-modal')).toHaveCount(0);
  });

  test('after auth (guest), the ship picker opens for the stashed sector', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    await waitForGalaxyPickHook(page);
    await pickSector(page);
    await page.getByTestId('sector-drawer-join').click();
    await page.locator('text=Continue as guest').click();
    // Back on the map, the Join they pressed carries on: the ship picker opens
    // for the stashed sector with no re-tap and no second Join.
    await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Smoke-test bug 2026-11-05 (phone, LAN host): "The login screen keeps
   * popping up. Continue as guest acts like a dismiss or close button ...
   * instead of a logon on a new throwaway account." Choosing guest was never
   * remembered, so every LATER pick hit the auth gate again and a guest could
   * not get into a sector they picked themselves.
   */
  test('after choosing guest, later picks do not bounce back to the login page', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
    await waitForGalaxyPickHook(page);
    await pickSector(page);
    await page.getByTestId('sector-drawer-join').click();
    await page.locator('text=Continue as guest').click();
    await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('ship-picker-close').click();
    await expect(page.getByTestId('ship-picker-modal')).toHaveCount(0);
    // A second pick, made by the guest themselves. A DIFFERENT sector: re-tapping
    // the sector whose drawer is open closes it by design, so picking sol-prime
    // again raced the close against the Join click (flaked on CI: "element was
    // detached from the DOM").
    await waitForGalaxyPickHook(page);
    await pickSector(page, 'vega-reach');
    await expect(page.locator('text=Continue as guest')).toHaveCount(0);
    await expect(page.getByTestId('sector-drawer-join')).toBeVisible({ timeout: 8_000 });
    await page.getByTestId('sector-drawer-join').click();
    await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 8_000 });
  });
});
