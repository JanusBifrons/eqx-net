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
const GATE_KEYS = ['connectionStatus', 'localShipInstanceId', 'rendererFirstFrameRendered', 'firstSnapshotApplied',
  'joinMinimumElapsed', 'localPoseResolved', 'clientReadySent', 'arrivalTickFromServer', 'arrivalAcked'] as const;
const gates = (page: Page): Promise<string> => page.evaluate((keys) => {
  const w = window as unknown as { __eqxStore?: { getState: () => Record<string, unknown> }; __eqxArtStats?: () => Record<string, unknown> };
  const s = w.__eqxStore?.getState() ?? {};
  const a = w.__eqxArtStats?.() ?? {};
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = s[k];
  for (const k of ['ownArt', 'ready', 'pending', 'failed', 'workers']) out[`art.${k}`] = a[k];
  return JSON.stringify(out);
}, GATE_KEYS).catch((e: unknown) => `(no state: ${String(e)})`);

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
    // The reveal waits on INFRASTRUCTURE, not game time: the bakes on CI's
    // 3-worker pool (the main-thread renderer, SwiftShader and 36 warm-up
    // bakes share the CPU), then the deliberate 8 s art hold (it must outlast
    // the minimum curtain to prove anything). Its old 30 s cap was half the
    // 60 s every other join gets (`waitForInPlay`) with the hold on top, and
    // CI flaked only there, on the slowest runners (2026-11-19: 5 of 26
    // jobs; the 3-of-3 failure was on a runner ~30 % slower across the
    // shard). Same 60 s as `waitForInPlay`; the timings print for comparison.
    test.setTimeout(90_000);
    const t0 = Date.now();
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'heavy',
      extraParams: { worker: '0', art: 'machined', artDelayMs: '8000' },
      waitForInPlay: false, // the spec watches the curtain rise and lift
    });
    // The flag reads 0 for a moment before the join's loading screen goes up,
    // so wait for it to rise first, then for the reveal.
    await page.waitForSelector('[data-loading-active="1"]', { state: 'attached', timeout: 30_000 });
    const tUp = Date.now();
    try {
      await page.waitForSelector('[data-loading-active="0"]', { state: 'attached', timeout: 60_000 });
    } catch (e) {
      // Which gate held the curtain (store flags + art handles), for the log.
      console.log(`join-art-ready: curtain still up after ${Date.now() - tUp} ms: ${await gates(page)}`);
      throw e;
    }
    console.log(`join-art-ready: joined in ${tUp - t0} ms, curtain lifted ${Date.now() - tUp} ms later`);
    const atReveal = await stats(page);
    expect(atReveal.mode).toBe('machined');
    expect(atReveal.classicShipSprites, 'no ship is still in the fallback look when the loading screen lifts').toBe(0);
    expect(atReveal.machinedSprites).toBeGreaterThan(0);
    await ctx.close();
  });
});
