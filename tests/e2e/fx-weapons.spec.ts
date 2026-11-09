/**
 * New weapon effects in the real game (plan iridescent-seeking-rainbow v3, B3).
 *
 * `auto-fire-test` parks a hull-exposed drone 150 u ahead; with
 * `startHostile=1` (+ `instantLock=1`) the local ship's AUTO group locks it and
 * fires with no input. With
 * `?fx=new` (and Machined art) a fighter's bolts must draw as the new pooled
 * sprite views, and an interceptor's beam must get the new glow layer; without
 * the flag nothing new draws. `?worker=0` so the stats hook and screenshots
 * read the live renderer.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect, type Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
type Stats = { fxBeam?: boolean; fxProjectiles?: number; fxReady?: number; failed?: number; lastFailure?: string };

// Infrastructure cost only: a cold join plus the first-visit bake of the
// effect textures on the worker pool.
test.describe.configure({ timeout: 90_000 });

async function join(browser: Browser, shipKind: string, fx: boolean) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'auto-fire-test', shipKind, initialHull: '5000', testId: randomUUID(),
    // Lock-to-fire (2026-11-09): AUTO groups fire only at a completed lock;
    // instantLock makes the lock on the hostile drone complete in ≤ 100 ms.
    startHostile: '1', instantLock: '1', worker: '0', art: 'machined', zoom: '2',
  });
  if (fx) params.set('fx', 'new');
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return el !== null && el.getAttribute('data-local-player-id') !== '';
  }, undefined, { timeout: 30_000 });
  return { ctx, page };
}

const stats = (page: import('@playwright/test').Page): Promise<Stats> =>
  page.evaluate(() => (window as unknown as { __eqxArtStats: () => Stats }).__eqxArtStats());

test('bolts draw as the new sprites with ?fx=new', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'fighter', true);
  await page.waitForFunction(
    () => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().fxProjectiles ?? 0) > 0,
    undefined, { timeout: 45_000 },
  );
  const s = await stats(page);
  expect(s.failed ?? 0, s.lastFailure).toBe(0);
  mkdirSync('diag/e2e-screenshots/fx-weapons', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-weapons/bolts.png' });
  await ctx.close();
});

test('without ?fx=new bolts keep today\'s look', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'fighter', false);
  // Once the art service is up, no effect texture was even asked for, so
  // nothing new can draw.
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => { ready?: number } }).__eqxArtStats?.().ready ?? 0) > 0, undefined, { timeout: 30_000 });
  const s = await stats(page);
  expect(s.fxProjectiles ?? 0).toBe(0);
  expect(s.fxReady ?? 0).toBe(0);
  await ctx.close();
});

test('a beam gets the new glow layer with ?fx=new', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'interceptor', true);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return el?.getAttribute('data-beam-active') === '1';
  }, undefined, { timeout: 45_000 });
  await page.waitForFunction(
    () => ((window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().fxReady ?? 0) >= 19,
    undefined, { timeout: 45_000 },
  );
  await page.waitForFunction(() => (window as unknown as { __eqxArtStats?: () => Stats }).__eqxArtStats?.().fxBeam === true, undefined, { timeout: 20_000 });
  mkdirSync('diag/e2e-screenshots/fx-weapons', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-weapons/beam.png' });
  await ctx.close();
});

test('a destroyed drone goes up in the new explosion with ?fx=new (B4)', async ({ browser }) => {
  const { ctx, page } = await join(browser, 'fighter', true);
  // The parked drone is hull-exposed; auto-fire kills it. Its death must
  // play a new explosion, not today's particle burst.
  await page.waitForFunction(
    () => ((window as unknown as { __eqxArtStats?: () => { fxExplosions?: number } }).__eqxArtStats?.().fxExplosions ?? 0) > 0,
    undefined, { timeout: 60_000 },
  );
  mkdirSync('diag/e2e-screenshots/fx-weapons', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-weapons/explosion.png' });
  await ctx.close();
});

test('shields and fences use the new look with ?fx=new (B5)', async ({ browser }) => {
  // gate-test: two powered shield gates, so there are fences to draw; the
  // local ship spawns with its shield up.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({ room: 'gate-test', spawnX: '-400', spawnY: '-1300', testId: randomUUID(), worker: '0', art: 'machined', fx: 'new', zoom: '0.6' });
  await page.goto(`${BASE_URL}?${params}`);
  type S = { fxShields?: number; fxFences?: number };
  await page.waitForFunction(() => {
    const s = (window as unknown as { __eqxArtStats?: () => S }).__eqxArtStats?.();
    return !!s && (s.fxShields ?? -1) >= 1 && (s.fxFences ?? 0) >= 1;
  }, undefined, { timeout: 60_000 });
  mkdirSync('diag/e2e-screenshots/fx-weapons', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fx-weapons/fences.png' });
  await ctx.close();
});
