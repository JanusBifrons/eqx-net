import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * exp/fire-control — variant D (`?ui=d`): universal target locking.
 *
 * Uses the `auto-fire-test` room (a hostile fighter parked 150 u ahead of
 * spawn). Locks:
 *  - MAN + clear leaves the group unlocked (MAN never self-picks; AUTO
 *    self-locking is covered by tests/integration/sectorRoom/fireControlLocks —
 *    here an AUTO group would kill the fragile test drone at once);
 *  - the smart-aim drag (mouse on desktop, right-thumb drag on touch) toward
 *     the drone starts a lock for the active group.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function boot(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/?room=auto-fire-test&startHostile=1&ui=d&initialHull=5000&testId=${randomUUID()}`);
  await page.locator('[data-testid^="fc-chip-"]').first().waitFor({ timeout: 30_000 });
}

const chip = (page: Page) => page.locator('[data-testid^="fc-chip-"]').first();

async function toManualAndClear(page: Page): Promise<void> {
  const id = ((await chip(page).getAttribute('data-testid')) ?? '').slice('fc-chip-'.length);
  await page.locator(`[data-testid="fc-mode-${id}"]`).click();
  await expect(page.locator(`[data-testid="fc-mode-${id}"]`)).toHaveAttribute('data-state', 'manual', { timeout: 5_000 });
  const clear = page.locator(`[data-testid="fc-clear-${id}"]`);
  if (await clear.count()) await clear.click();
  await expect(chip(page)).toHaveAttribute('data-locked', '0', { timeout: 5_000 });
  await expect(chip(page)).toHaveAttribute('data-acquiring', '0');
}

test.describe('fire control — target locking (ui=d)', () => {
  test('desktop: MAN + LMB drag locks', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await boot(page);
    await toManualAndClear(page);

    // Drag straight up from the ship (screen centre) — the drone is ahead.
    const surface = await page.locator('[data-testid="game-surface"]').boundingBox();
    const cx = surface!.x + surface!.width / 2;
    const cy = surface!.y + surface!.height / 2;
    await page.mouse.move(cx, cy - 20);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx, cy - 20 - i * 20);
    await page.mouse.up();
    await expect
      .poll(async () => Number(await chip(page).getAttribute('data-locked')) + Number(await chip(page).getAttribute('data-acquiring')), { timeout: 5_000 })
      .toBeGreaterThan(0);
    await expect(chip(page)).toHaveAttribute('data-locked', '1', { timeout: 15_000 });
    await ctx.close();
  });

  test('touch landscape: right-thumb drag locks', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await boot(page);
    await toManualAndClear(page);

    const cdp = await ctx.newCDPSession(page);
    const x0 = 844 - 220;
    const y0 = 330;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 7 }] });
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x0, y0 - i * 10);
    await page.screenshot({ path: 'diag/e2e-screenshots/fire-control/touch-guide.png' });
    await touch('touchEnd', x0, y0 - 60);
    await expect(chip(page)).toHaveAttribute('data-locked', '1', { timeout: 15_000 });
    await page.screenshot({ path: 'diag/e2e-screenshots/fire-control/touch-locked.png' });
    await ctx.close();
  });
});
