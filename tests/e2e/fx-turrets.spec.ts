/**
 * Machined turrets in the real game (plan T1; the turret lab's round 2,
 * signed off 2026-11-05): with `?fx=new` each mount on a Machined hull or
 * deck gets a baked gun in a ring cut into the plating, in place of today's
 * flat bar. `__eqxArtStats().turrets` counts the guns drawn (-1 = off).
 *
 *  - `auto-fire-test` with a gunship: its two turrets (plus the parked
 *    drone's chin gun) draw Machined.
 *  - `structure-scenario-test`: the seeded Turret structure gets a gun too,
 *    on top of the pilot's own chin gun.
 *  - Firing (T2): with `startHostile=1` the gunship auto-fires at the drone;
 *    each new bolt is matched to the gun it left (recoil, flash, heat), so
 *    `turretShots` counts up.
 *  - Without the flag nothing new draws.
 * `?worker=0` so the stats hook reads the live renderer.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
type Stats = { turrets?: number; turretShots?: number; failed?: number; lastFailure?: string; ready?: number };

// Infrastructure cost only: a cold join plus the first-visit bakes.
test.describe.configure({ timeout: 90_000 });

async function join(browser: Browser, room: string, shipKind: string, fx: boolean, extra: Record<string, string> = {}): Promise<{ ctx: import('@playwright/test').BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({ room, shipKind, testId: randomUUID(), worker: '0', art: 'machined', zoom: '2.5', initialHull: '5000' });
  if (fx) params.set('fx', 'new');
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return el !== null && el.getAttribute('data-local-player-id') !== '';
  }, undefined, { timeout: 30_000 });
  return { ctx, page };
}

const stats = (page: Page): Promise<Stats> =>
  page.evaluate(() => (window as unknown as { __eqxArtStats: () => Stats }).__eqxArtStats());
const turretsAtLeast = (page: Page, n: number): Promise<unknown> =>
  page.waitForFunction((k) => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().turrets ?? -1) >= k, n, { timeout: 60_000 }); // cold start: first Vite compile + first-visit bakes

test('a gunship\'s turrets draw as Machined guns with ?fx=new', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'auto-fire-test', 'gunship', true);
  await turretsAtLeast(page, 3); // two gunship turrets + the drone's chin gun
  const s = await stats(page);
  expect(s.failed ?? 0, s.lastFailure).toBe(0);
  mkdirSync('diag/e2e-screenshots/fx-turrets', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-turrets/gunship.png' });
  await ctx.close();
});

test('a defence turret structure gets a Machined gun too', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'structure-scenario-test', 'fighter', true);
  await turretsAtLeast(page, 2); // the pilot's chin gun + the Turret structure
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-turrets/structure.png' });
  await ctx.close();
});

test('auto-fire kicks the gunship\'s guns (recoil, flash, heat)', async ({ browser }) => {
  // Warm the bakes first: a hostile drone dies to a gunship in a second or two,
  // before a cold bake finishes, so it would be dead before the guns are
  // Machined. Finished bakes are cached in the context's IndexedDB, so the
  // second join (a fresh room with a fresh hostile drone) has them at once.
  const { ctx, page } = await join(browser, 'auto-fire-test', 'gunship', true);
  await turretsAtLeast(page, 3);
  const params = new URLSearchParams({ room: 'auto-fire-test', shipKind: 'gunship', testId: randomUUID(), worker: '0', art: 'machined', fx: 'new', zoom: '2.5', initialHull: '5000', startHostile: '1' });
  await page.goto(`${BASE_URL}?${params}`);
  await turretsAtLeast(page, 2);
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().turretShots ?? -1) > 0, undefined, { timeout: 20_000 });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-turrets/firing.png' });
  await ctx.close();
});

test('without ?fx=new mounts keep today\'s bars', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'auto-fire-test', 'gunship', false);
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().ready ?? 0) > 0, undefined, { timeout: 30_000 });
  expect((await stats(page)).turrets).toBe(-1);
  await ctx.close();
});

