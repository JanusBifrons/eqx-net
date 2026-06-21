import { test, expect, type Page } from '@playwright/test';

/**
 * Equinox Phase 9 — visual coverage for the drawer states that need live data:
 * the per-ship card (hull bar + position) from a REAL active ship, the in-game
 * "Warp here" CTA, and the recent-combat breakdown + hex ⚔ glyph (driven by the
 * `__eqxSetGalaxyStats` dev hook, since a real recentCombat needs a kill).
 * Captures screenshots for sign-off into diag/e2e-screenshots/galaxy-drawer/.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

declare global {
  interface Window {
    __eqxGalaxyPick?: (k: string) => void;
    __eqxSetGalaxyStats?: (s: unknown[]) => void;
  }
}

async function bootInGame(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
  await page.locator('[data-testid="sector-info-panel"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__eqxGalaxyPick === 'function', null, { timeout: 10_000 });
}

test('in-game drawer: active-ship card (hull bar + position) + Warp here', async ({ page }) => {
  test.setTimeout(60_000);
  await bootInGame(page);
  await page.keyboard.press('m');
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 8_000 });

  // Pick the CURRENT sector → the active ship appears as a card (hull bar +
  // position) once the roster poll lands.
  await page.evaluate(() => window.__eqxGalaxyPick!('sol-prime'));
  await expect(page.getByTestId('sector-drawer-close')).toBeVisible({ timeout: 8_000 });
  await expect
    .poll(() => page.locator('[data-testid^="sector-drawer-ship-"]').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('[data-testid^="sector-drawer-hull-"]').first()).toBeVisible();
  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/03-active-ship.png' });

  // Pick an adjacent neighbour → "Warp here" CTA.
  await page.evaluate(() => window.__eqxGalaxyPick!('cygnus-arm'));
  await expect(page.getByTestId('sector-drawer-warp')).toBeVisible({ timeout: 8_000 });
  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/04-warp.png' });
});

test('portrait: bottom-docked drawer action bar is within the viewport (not clipped below the fold)', async ({ page }) => {
  // Equinox Phase 9 follow-up: on a non-fullscreen mobile browser the drawer
  // sized with `vh` overflowed past the visible viewport so the ✕/Join action
  // bar clipped below the fold. The fix sizes the bottom dock in `dvh` + adds
  // safe-area padding. Headless has no dynamic address bar (dvh≈vh), so this
  // locks the STATIC fit: in a short portrait viewport the action bar's bottom
  // edge must sit within the viewport height.
  const VIEW_W = 390;
  const VIEW_H = 720;
  await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });
  await page.waitForFunction(() => typeof window.__eqxGalaxyPick === 'function', null, { timeout: 6_000 });
  await page.waitForTimeout(400);

  await page.evaluate(() => window.__eqxGalaxyPick!('sol-prime'));
  const closeBtn = page.getByTestId('sector-drawer-close');
  const joinBtn = page.getByTestId('sector-drawer-join');
  await expect(closeBtn).toBeVisible({ timeout: 8_000 });
  await expect(joinBtn).toBeVisible();

  // The action bar (✕ + Join) must be fully inside the viewport — its bottom
  // edge cannot extend past VIEW_H (the "clips below the fold" regression).
  for (const btn of [closeBtn, joinBtn]) {
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(VIEW_H);
  }
  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/07-portrait-bottom-dock.png' });
});

test('landing drawer + map: recent-combat breakdown + hex ⚔ icon', async ({ page }) => {
  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });
  await page.waitForFunction(
    () => typeof window.__eqxGalaxyPick === 'function' && typeof window.__eqxSetGalaxyStats === 'function',
    null,
    { timeout: 6_000 },
  );
  await page.waitForTimeout(400); // let the layer settle into its fit

  const inject = (): void =>
    window.__eqxSetGalaxyStats!([
      { key: 'sol-prime', players: 1, enemies: 4, neutrals: 2, structures: 3, owner: null,
        recentCombat: { shipsDestroyed: 3, structuresDestroyed: 1, lastEventMs: 1 } },
    ]);

  // Map ⚔ glyph: inject, let store→effect→layer→Pixi-frame settle, then re-inject
  // RIGHT before the shot so the ~4 s `useGalaxyStats` poll can't blank it in the gap.
  await page.evaluate(inject);
  await page.waitForTimeout(300);
  await page.evaluate(inject);
  await page.waitForTimeout(180);
  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/06-map-combat-icon.png' });

  // Drawer recent-activity: open, then re-inject immediately before assert+shot so
  // a poll can't overwrite recentCombat between the assert and the screenshot.
  await page.evaluate(() => window.__eqxGalaxyPick!('sol-prime'));
  await expect(page.getByTestId('sector-drawer-close')).toBeVisible({ timeout: 8_000 });
  await page.evaluate(inject);
  await expect(page.getByTestId('sector-drawer-recent')).toContainText('destroyed', { timeout: 2_000 });
  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-drawer/05-recent-activity.png' });
});
