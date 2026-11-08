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
 *  - the lock line is HELD: it builds only while kept on the target; let go
 *    part-way and it drains back to 0 (user design, 2026-11-08);
 *  - hands-off: select a ship, press LOCK in its info box (it runs to the
 *    end; CANCEL stops it);
 *  - the smart-aim drag (mouse on desktop, right-thumb drag on touch) toward
 *     the drone starts a lock for the active group.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function boot(page: Page, extra = ''): Promise<void> {
  await page.goto(`${BASE_URL}/?room=auto-fire-test&startHostile=1&ui=d&initialHull=5000&testId=${randomUUID()}${extra}`);
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
  test('desktop: MAN + LMB held on the drone locks it', async ({ browser }) => {
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
    // Keep holding it on the drone until the lock completes.
    await expect(chip(page)).toHaveAttribute('data-locked', '1', { timeout: 15_000 });
    await page.mouse.up();
    // Once locked, letting go keeps it.
    await page.waitForTimeout(1500);
    await expect(chip(page)).toHaveAttribute('data-locked', '1');
    await ctx.close();
  });

  test('touch landscape: right thumb held on the drone locks it', async ({ browser }) => {
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
    await expect(chip(page)).toHaveAttribute('data-locked', '1', { timeout: 15_000 });
    await touch('touchEnd', x0, y0 - 60);
    await page.screenshot({ path: 'diag/e2e-screenshots/fire-control/touch-locked.png' });
    await ctx.close();
  });

  test('let go part-way: the lock drains back to 0 and drops', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await boot(page);
    await toManualAndClear(page);
    const cdp = await ctx.newCDPSession(page);
    const x0 = 844 - 220;
    const y0 = 330;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 8 }] });
    await touch('touchStart', x0, y0);
    for (let i = 1; i <= 6; i++) await touch('touchMove', x0, y0 - i * 10);
    const own = page.locator('[data-testid="fc-own-lock"]');
    await expect.poll(async () => Number((await own.getAttribute('data-pct')) ?? 0), { timeout: 8_000 }).toBeGreaterThan(15);
    await touch('touchEnd', x0, y0 - 60); // let go before it finishes
    await expect(own).toHaveAttribute('data-losing', '1', { timeout: 3_000 });
    await page.screenshot({ path: 'diag/e2e-screenshots/fire-control/losing-lock.png' });
    // Drained to 0 and dropped: never locked.
    await expect(own).toHaveCount(0, { timeout: 8_000 });
    await expect(chip(page)).toHaveAttribute('data-locked', '0');
    await expect(chip(page)).toHaveAttribute('data-acquiring', '0');
    await ctx.close();
  });

  test('hands-off: select the drone, LOCK in its info box runs to the end; CANCEL stops it', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await boot(page, '&worker=0'); // the dev pick hook needs the main-thread renderer
    await toManualAndClear(page);
    // Select the parked drone (read its live pose) through the dev pick hook.
    const picked = await page.evaluate(() => {
      const w = window as unknown as {
        __eqxSelectAtWorld?: (x: number, y: number) => string | null;
        __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; x: number; y: number }> } };
      };
      for (const e of w.__eqxClient?.mirror?.swarm?.values() ?? []) if (e.kind === 1) return w.__eqxSelectAtWorld?.(e.x, e.y) ?? null;
      return null;
    });
    expect(picked).not.toBeNull();
    const btn = page.locator('[data-testid="fc-target"]');
    await expect(btn).toHaveAttribute('data-state', 'lock', { timeout: 5_000 });
    await btn.click();
    await expect(btn).toHaveAttribute('data-state', 'cancel', { timeout: 3_000 });
    await btn.click(); // cancel
    await expect(btn).toHaveAttribute('data-state', 'lock', { timeout: 3_000 });
    await expect(chip(page)).toHaveAttribute('data-acquiring', '0');
    await btn.click(); // lock again — no holding needed
    await expect(chip(page)).toHaveAttribute('data-locked', '1', { timeout: 15_000 });
    await expect(btn).toHaveAttribute('data-state', 'unlock');
    await ctx.close();
  });
});

test.describe('fire control — locks go both ways (fc-duel 1v3)', () => {
  test('flying in: the HUD names who is locking you, and your own lock shows its progress', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/?room=fc-duel&startHostile=1&ui=d&initialHull=100000&shipKind=gunship&worker=0&testId=${randomUUID()}`);
    await page.locator('[data-testid^="fc-chip-"]').first().waitFor({ timeout: 30_000 });
    // Steer forward (toward the pack) with the left thumb.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 300, id: 1 }] });
    for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120, y: 300 - i * 9, id: 1 }] });
    const threats = page.locator('[data-testid="fc-threats"]');
    await threats.waitFor({ timeout: 20_000 });
    await page.screenshot({ path: 'diag/e2e-screenshots/fire-control/duel-being-locked.png' });
    await expect.poll(async () => Number(await threats.getAttribute('data-locked')), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(threats).not.toContainText(/s:\d/); // names, never ids
    await expect(threats).toContainText(/HAVE YOU LOCKED|HAS YOU LOCKED/);
    await page.screenshot({ path: 'diag/e2e-screenshots/fire-control/duel-locked-on.png' });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await ctx.close();
  });
});
