/**
 * The join loading screen waits for the scene's Machined art (smoke tier, so
 * CI runs it: `machined-art.spec.ts` is a feature spec, which CI skips).
 * `?artDelayMs=` holds every bake back; `__eqxArtStats` (main-thread
 * renderer, hence `?worker=0`) reports what is drawn at the reveal.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

interface ArtStats { mode: string; machinedSprites: number; classicShipSprites: number }
const stats = (page: Page): Promise<ArtStats> =>
  page.evaluate(() => (window as unknown as { __eqxArtStats: () => ArtStats }).__eqxArtStats());

test.describe('Join loading screen and Machined art', () => {
  /**
   * Smoke test 2026-11-05 (phone, 2× B, capture v5ga3m): "The graphics were the
   * old ones, except the background" and "Surely it shouldn't let me load in
   * until I'm, yknow, loaded in? Why does it drop the curtain prior to those
   * textures loading?!" The phone bakes slowly (~a minute behind a long
   * queue), and the loading screen lifted as soon as the server handshake was
   * done, so the pilot flew with fallback ships. The loading screen must stay
   * up until every ship on screen has its art (ready or failed).
   */
  test('the loading screen stays up until the ships on screen have their Machined art', async ({ browser }) => {
    // 60 s, not the 30 s default: the CI flake (main, 2026-11-08/09) and a local
    // repro both ran out at ~30 s on INFRASTRUCTURE, not game time. Trace: page
    // load 13 s (Vite cold compile, first spec in the shard), join 5 s, curtain
    // up at ~20 s, then the deliberate 8 s art hold (it must outlast the 5 s
    // minimum curtain to prove anything) plus the bake.
    test.setTimeout(60_000);
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'heavy',
      extraParams: { worker: '0', art: 'machined', artDelayMs: '8000' },
      waitForInPlay: false, // the spec watches the curtain rise and lift
    });
    // The flag reads 0 for a moment before the join's loading screen goes up,
    // so wait for it to rise first, then for the reveal.
    await page.waitForSelector('[data-loading-active="1"]', { state: 'attached', timeout: 30_000 });
    await page.waitForSelector('[data-loading-active="0"]', { state: 'attached', timeout: 30_000 });
    const atReveal = await stats(page);
    expect(atReveal.mode).toBe('machined');
    expect(atReveal.classicShipSprites, 'no ship is still in the fallback look when the loading screen lifts').toBe(0);
    expect(atReveal.machinedSprites).toBeGreaterThan(0);
    await ctx.close();
  });
});
