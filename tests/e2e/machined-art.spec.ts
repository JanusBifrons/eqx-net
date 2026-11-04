/**
 * Machined art in the real game (plan iridescent-seeking-rainbow, A3).
 *
 * With `?art=machined` the renderer bakes ship art on workers. Until a ship's
 * art is ready it draws today's vector look, then swaps to the Machined
 * sprite. `?artDelayMs=` holds every bake back so the fallback is observable;
 * `__eqxArtStats` (main-thread renderer, hence `?worker=0`) reports what is
 * drawn. With no flag the look is unchanged from today.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { launchTestClient } from './helpers/gameScenario';

interface ArtStats { mode: string; machinedSprites: number; classicShipSprites: number; ready?: number; pending?: number; failed?: number; pages?: number; workers?: number }
const stats = (page: Page): Promise<ArtStats> =>
  page.evaluate(() => (window as unknown as { __eqxArtStats: () => ArtStats }).__eqxArtStats());

test.describe('Machined art', () => {
  test('a ship draws today\'s look while its art bakes, then swaps to Machined', async ({ browser }) => {
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'heavy',
      extraParams: { worker: '0', art: 'machined', artDelayMs: '4000', zoom: '3' },
    });
    await page.waitForFunction(() => {
      const s = (window as unknown as { __eqxArtStats?: () => { classicShipSprites: number; machinedSprites: number } }).__eqxArtStats?.();
      return !!s && s.classicShipSprites + s.machinedSprites > 0;
    }, undefined, { timeout: 10_000 });
    const before = await stats(page);
    expect(before.mode).toBe('machined');
    expect(before.machinedSprites, 'nothing is Machined while bakes are held back').toBe(0);
    expect(before.classicShipSprites, 'the ship falls back to today\'s look').toBeGreaterThan(0);
    expect(before.pending ?? 0).toBeGreaterThan(0);

    await page.waitForFunction(
      () => (window as unknown as { __eqxArtStats: () => { machinedSprites: number } }).__eqxArtStats().machinedSprites > 0,
      undefined, { timeout: 20_000 },
    );
    const after = await stats(page);
    expect(after.failed ?? 0).toBe(0);
    expect(after.ready ?? 0).toBeGreaterThan(0);
    expect(after.pages ?? 0).toBeGreaterThan(0);

    mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
    await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/heavy-machined.png' });
    await ctx.close();
  });

  test('without the flag nothing changes: no art service, today\'s look', async ({ browser }) => {
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', extraParams: { worker: '0' },
    });
    await page.waitForFunction(() => {
      const s = (window as unknown as { __eqxArtStats?: () => { classicShipSprites: number } }).__eqxArtStats?.();
      return !!s && s.classicShipSprites > 0;
    }, undefined, { timeout: 10_000 });
    const s = await stats(page);
    expect(s.mode).toBe('classic');
    expect(s.machinedSprites).toBe(0);
    expect(s.workers).toBeUndefined();
    await ctx.close();
  });
});

test.describe('Machined art — structures and asteroids', () => {
  test('a prebuilt base draws structures and its asteroid in Machined once baked', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const base = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
    await page.goto(`${base}?room=structure-scenario-test&worker=0&art=machined&zoom=0.4&spawnX=0&spawnY=520&testId=${crypto.randomUUID()}`);
    // Capital + 2 solar + miner + turret (+ the asteroid) all become Machined.
    await page.waitForFunction(
      () => ((window as unknown as { __eqxArtStats?: () => { machinedSprites: number } }).__eqxArtStats?.().machinedSprites ?? 0) >= 6,
      undefined, { timeout: 30_000 },
    );
    const s = await stats(page);
    expect(s.failed ?? 0).toBe(0);
    mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
    await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/base-machined.png' });
    await ctx.close();
  });
});
