import { test, expect, type Page } from '@playwright/test';

/**
 * Ship-picker UX coverage on the galaxy-map screen (post-refactor).
 *
 * 2026-05-10 refactor: the standalone "ship-picker-trigger" button on the
 * galaxy-map screen was removed. The picker is now SECTOR-SCOPED — a
 * sector hex click sets `pendingSpawnSector`, which opens the picker
 * with "Spawn in {sector}" framing. The picker itself
 * (ShipPickerModal — components/ShipPickerModal.tsx) is the same
 * MUI Dialog as before, with the same card grid and data-testids
 * (`ship-card-${kind.id}`, `ship-picker-modal`, `ship-picker-spawn`,
 * `ship-picker-close`).
 *
 * These tests use a mocked `/auth/me` so we land on the galaxy-map
 * without touching the real auth path, then click the centre canvas
 * hex (Sol Prime at world (0,0)) to invoke the picker. They cover only
 * the client-side React state of the picker — they never click Spawn,
 * so no Colyseus join is exercised here (that lives in
 * spawn-select-flow.spec.ts).
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const FAKE_TOKEN = 'fake-test-token';
const FAKE_USER = {
  id: 'test-user-aaaaaaaa',
  email: 'test@example.com',
  displayName: 'Test',
};

async function mockAuthAndGo(page: Page): Promise<void> {
  await page.route('**/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: FAKE_USER }),
    }),
  );
  await page.addInitScript((token: string) => {
    try {
      localStorage.setItem('eqxAuthToken', token);
    } catch {
      // ignore
    }
  }, FAKE_TOKEN);
  await page.goto(BASE_URL);
  // The 2026-05-10 post-auth refactor introduced a meta-landing with a
  // "Join the fight" CTA between login and the galaxy map. Some flows
  // (storageState pre-pop) skip it; click only if visible.
  const cta = page.locator('text=Join the fight').first();
  if (await cta.isVisible({ timeout: 8000 }).catch(() => false)) {
    await cta.click();
  }
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });
}

/** Open the ship picker for a sector. Single-canvas refactor: the spawn
 *  picker renders on the shared canvas via GalaxyMapLayer's selector
 *  mode, and a real tap routes through the host's `onSelectorPick`
 *  (incl. the 200 ms tap-shield). The DEV-only `__eqxGalaxyPick(key)`
 *  hook mirrors that tap deterministically — no hex-pixel math (this is
 *  the programmatic path the old fixme comment was waiting for). */
async function openPickerViaSectorClick(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __eqxGalaxyPick?: unknown }).__eqxGalaxyPick === 'function',
    null,
    { timeout: 8_000 },
  );
  await page.evaluate(() => {
    (window as unknown as { __eqxGalaxyPick?: (k: string) => void }).__eqxGalaxyPick?.('sol-prime');
  });
  // Equinox Phase 7 (Item 4) — a pick opens the interactive sector popover;
  // "Join the fight" opens the ship picker (no longer one-click).
  await expect(page.getByTestId('sector-drawer-join')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('sector-drawer-join').click();
  await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 5_000 });
}

test.describe('ship-picker on galaxy-map', () => {
  test('galaxy-map screen mounts the spawn-mode UI', async ({ page }) => {
    // The old top-level "ship-picker-trigger" was removed when the picker
    // became sector-scoped. The spawn-mode galaxy-map still mounts and
    // exposes both the engineering-rooms entry and the galaxy canvas;
    // the picker is now triggered by a sector hex tap (covered below).
    await mockAuthAndGo(page);
    await expect(page.getByTestId('engineering-rooms-button')).toBeVisible({ timeout: 8000 });
    // Single-canvas refactor: the hex map now renders on the SHARED
    // gameplay canvas (game-surface), with the picker chrome
    // (galaxy-map-screen) overlaid as a sibling — so the canvas lives
    // under game-surface, not under galaxy-map-screen.
    await expect(
      page.locator('[data-testid="game-surface"] canvas').first(),
    ).toBeVisible();
  });

  // The three tests below open the picker via the deterministic
  // `__eqxGalaxyPick` hook (the programmatic path the prior `fixme`
  // comment was waiting for — landed with the single-canvas refactor).
  // Previously fixme because canvas-centre clicks couldn't reliably hit
  // a hex once the renderer centred on the multi-sector bbox.
  test('sector click opens the picker with a card per kind', async ({ page }) => {
    await mockAuthAndGo(page);
    await openPickerViaSectorClick(page);
    await expect(page.getByTestId('ship-card-fighter')).toBeVisible();
    await expect(page.getByTestId('ship-card-scout')).toBeVisible();
    await expect(page.getByTestId('ship-card-heavy')).toBeVisible();
  });

  test('clicking a card moves the tentative-selection highlight (data-selected)', async ({
    page,
  }) => {
    await mockAuthAndGo(page);
    await openPickerViaSectorClick(page);
    await expect(page.getByTestId('ship-card-fighter')).toHaveAttribute('data-selected', '1');
    await page.getByTestId('ship-card-scout').click();
    await expect(page.getByTestId('ship-card-scout')).toHaveAttribute('data-selected', '1');
    await expect(page.getByTestId('ship-card-fighter')).toHaveAttribute('data-selected', '0');
  });

  test('picker exposes Spawn + Cancel buttons; Cancel closes', async ({ page }) => {
    await mockAuthAndGo(page);
    await openPickerViaSectorClick(page);
    await expect(page.getByTestId('ship-picker-spawn')).toBeVisible();
    await expect(page.getByTestId('ship-picker-close')).toBeVisible();
    await page.getByTestId('ship-picker-close').click();
    await expect(page.getByTestId('ship-picker-modal')).not.toBeVisible();
  });
});
