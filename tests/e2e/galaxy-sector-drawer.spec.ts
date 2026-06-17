import { test, expect } from '@playwright/test';

/**
 * Equinox Phase 9 (item 2) — the docked SectorInfoDrawer (replaces the old fixed
 * popover). A hex pick selects the sector and opens the drawer (overlay, no
 * scrim); it shows the labelled breakdown + a "Recent activity" line + the
 * Join/Warp action bar; ✕ closes + deselects. Docks RIGHT in landscape and
 * BOTTOM in portrait. `?worker=0` forces the main-thread renderer (DOM hooks +
 * screenshot-able). Captures before/after screenshots for the look/feel review.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

declare global {
  interface Window {
    __eqxGalaxyPick?: (sectorKey: string) => void;
  }
}

async function openMapAndPick(page: import('@playwright/test').Page, sector: string): Promise<void> {
  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });
  await page.waitForFunction(() => typeof window.__eqxGalaxyPick === 'function', null, { timeout: 6_000 });
  await page.waitForTimeout(400); // let the layer settle
  await page.evaluate((k) => window.__eqxGalaxyPick!(k), sector);
}

test('drawer opens on pick (right dock, landscape): info + recent + close', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await openMapAndPick(page, 'sol-prime');

  // Drawer open (the Join CTA only renders when a sector is selected + landing ctx).
  await expect(page.getByTestId('sector-drawer-join')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId('sector-drawer-breakdown')).toBeVisible();
  // Recent-activity line is always present (quiet → "No recent activity").
  await expect(page.getByTestId('sector-drawer-recent')).toBeVisible();
  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/01-right.png' });

  // ✕ closes + deselects → the Join CTA is gone.
  await page.getByTestId('sector-drawer-close').click();
  await expect(page.getByTestId('sector-drawer-join')).toHaveCount(0, { timeout: 4_000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test.describe('portrait (bottom dock)', () => {
  test.use({ viewport: { width: 430, height: 920 } });

  test('drawer docks at the bottom in portrait', async ({ page }) => {
    await openMapAndPick(page, 'sol-prime');
    await expect(page.getByTestId('sector-drawer-join')).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/02-bottom.png' });
  });
});
