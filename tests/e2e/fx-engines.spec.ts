/**
 * New engine exhaust in the real game (engine fx, picked "both" on the lab
 * page 2026-11-05: a baked flame + a short ribbon at every Machined nozzle).
 *
 * The user's ask: ALL ships have thrusters, drones included. `auto-fire-test`
 * parks a peaceful NPC drone 150 u ahead of the spawn, so with `?fx=new` the
 * new exhaust must draw on both the local ship and the drone, and holding
 * thrust must emit none of today's particles for the local ship. Without the
 * flag nothing new draws and today's particles still appear. `?worker=0` so
 * the stats hooks read the live renderer.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
type Stats = { fxEngines?: number; engineParticles?: number; failed?: number; lastFailure?: string; ready?: number };

// Infrastructure cost only: a cold join plus the first-visit bake of the art.
test.describe.configure({ timeout: 90_000 });

async function join(browser: Browser, fx: boolean): Promise<{ ctx: import('@playwright/test').BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({ room: 'auto-fire-test', shipKind: 'heavy', testId: randomUUID(), worker: '0', art: 'machined', zoom: '2' });
  if (fx) params.set('fx', 'new');
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return el !== null && el.getAttribute('data-local-player-id') !== '' && Number.isFinite(parseFloat(el.getAttribute('data-ship-y') ?? ''));
  }, undefined, { timeout: 30_000 });
  return { ctx, page };
}

const stats = (page: Page): Promise<Stats> =>
  page.evaluate(() => (window as unknown as { __eqxArtStats: () => Stats }).__eqxArtStats());
const particles = async (page: Page): Promise<number> => (await stats(page)).engineParticles ?? -1;
/** The local ship's game-space position (the game surface's test attributes). */
const shipXY = (page: Page): Promise<[number, number]> =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return [parseFloat(el?.getAttribute('data-ship-x') ?? 'NaN'), parseFloat(el?.getAttribute('data-ship-y') ?? 'NaN')];
  });
/** Hold thrust until the ship has visibly moved (the engines are firing). */
async function thrustUntilMoving(page: Page): Promise<void> {
  const [x0, y0] = await shipXY(page);
  await page.keyboard.down('KeyW');
  await expect.poll(async () => { const [x, y] = await shipXY(page); return Math.hypot(x - x0, y - y0); }, { timeout: 10_000 }).toBeGreaterThan(30);
}

test('every ship, the drone included, gets the new exhaust with ?fx=new', async ({ browser }) => {
  const { ctx, page } = await join(browser, true);
  await page.waitForFunction(
    () => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().fxEngines ?? 0) >= 2,
    undefined, { timeout: 45_000 },
  );
  await thrustUntilMoving(page);
  const s = await stats(page);
  expect(s.failed ?? 0, s.lastFailure).toBe(0);
  expect(s.fxEngines).toBeGreaterThanOrEqual(2);
  expect(await particles(page)).toBe(0);
  mkdirSync('diag/e2e-screenshots/fx-engines', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-engines/thrust.png' });
  await page.keyboard.up('KeyW');
  await ctx.close();
});

test('without ?fx=new ships keep today\'s particle exhaust', async ({ browser }) => {
  const { ctx, page } = await join(browser, false);
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().ready ?? 0) > 0, undefined, { timeout: 30_000 });
  await thrustUntilMoving(page);
  await expect.poll(() => particles(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.keyboard.up('KeyW');
  expect((await stats(page)).fxEngines).toBe(-1);
  await ctx.close();
});
