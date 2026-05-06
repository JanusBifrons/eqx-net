import { test, expect, type Page } from '@playwright/test';

/**
 * Ship-picker UX coverage on the galaxy-map screen.
 *
 * The picker only renders post-auth on the galaxy-map screen, so this spec
 * mocks `/auth/me` to bypass real registration. We pre-seed `eqxAuthToken`
 * in localStorage; the client's `bootstrapAuth` calls `/auth/me`, our mock
 * returns a stable fake user, and `setAuth` lands us on the galaxy-map.
 *
 * We do NOT exercise the "trigger is disabled while spawned" path here —
 * that requires actually entering a sector and is covered by the React
 * component logic plus Phase 5 manual verification. Adding it here would
 * pull in the full Colyseus/server boot dance for marginal coverage.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const FAKE_TOKEN = 'fake-test-token';
const FAKE_USER = {
  id: 'test-user-aaaaaaaa',
  email: 'test@example.com',
  displayName: 'Test',
};

async function mockAuthAndGo(page: Page): Promise<void> {
  // Intercept the auth probe and any other auth endpoints the picker flow
  // doesn't need so we don't hit the real server.
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: FAKE_USER }),
    }),
  );

  // Pre-seed a token so `bootstrapAuth` thinks we're already logged in and
  // hits our mock. Must run before navigation.
  await page.addInitScript((token: string) => {
    try { localStorage.setItem('eqxAuthToken', token); } catch { /* ignore */ }
  }, FAKE_TOKEN);

  await page.goto(BASE_URL);
}

test.describe('ship-picker on galaxy-map', () => {
  test('trigger button is visible with the default ship name and silhouette', async ({ page }) => {
    await mockAuthAndGo(page);
    const trigger = page.getByTestId('ship-picker-trigger');
    await expect(trigger).toBeVisible({ timeout: 8000 });
    // Default ship is the catalogue's first kind ("Fighter"). Trigger label
    // reads "Ship: Fighter" — fail loudly if the catalogue default name moves.
    await expect(trigger).toContainText('Fighter');
    // The inline SVG silhouette is rendered alongside the label.
    await expect(trigger.locator('svg')).toBeVisible();
  });

  test('clicking the trigger opens the modal with a card per kind', async ({ page }) => {
    await mockAuthAndGo(page);
    await page.getByTestId('ship-picker-trigger').click();
    const modal = page.getByTestId('ship-picker-modal');
    await expect(modal).toBeVisible();
    // One card per catalogue kind; locked-in ids fail the test if the
    // catalogue silently renames or removes a kind.
    await expect(page.getByTestId('ship-card-fighter')).toBeVisible();
    await expect(page.getByTestId('ship-card-scout')).toBeVisible();
    await expect(page.getByTestId('ship-card-heavy')).toBeVisible();
  });

  test('selecting a card updates the trigger and persists across reload', async ({ page }) => {
    await mockAuthAndGo(page);
    await page.getByTestId('ship-picker-trigger').click();
    await page.getByTestId('ship-card-heavy').click();
    // Modal closes and trigger now reads "Heavy".
    await expect(page.getByTestId('ship-picker-modal')).not.toBeVisible();
    await expect(page.getByTestId('ship-picker-trigger')).toContainText('Heavy');
    // localStorage has been written under the per-user slot.
    const stored = await page.evaluate((userId: string) =>
      localStorage.getItem(`eqxShipSelection:${userId}`),
    FAKE_USER.id);
    expect(stored).toContain('heavy');

    // Reload — the bootstrap auth path hydrates the same user, which calls
    // applyUserPrefs(userId), which reads the stored kind back into the
    // store. Trigger should still read Heavy.
    await page.reload();
    await expect(page.getByTestId('ship-picker-trigger')).toContainText('Heavy', { timeout: 8000 });
  });

  test('selected card is highlighted in the modal', async ({ page }) => {
    await mockAuthAndGo(page);
    // Pre-set the selection so we can verify highlight state on a fresh open.
    await page.evaluate((userId: string) => {
      localStorage.setItem(
        `eqxShipSelection:${userId}`,
        JSON.stringify({ shipKind: 'scout' }),
      );
    }, FAKE_USER.id);
    await page.reload();
    await page.getByTestId('ship-picker-trigger').click();
    // The selected card carries an extra "selected" sub-element.
    await expect(page.getByTestId('ship-card-scout-selected')).toBeVisible();
  });
});
