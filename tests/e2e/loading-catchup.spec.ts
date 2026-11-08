/**
 * Smoke-test bug (user, 2026-11-05, round 3 capital fly-by clip): "The ship is
 * jittering around everywhere like crazy in the clip unfortunately, it's not
 * smooth at all." … "any jitter at all ruins the video."
 *
 * Root cause (found by a hostile re-investigation; the first fix attempt was
 * at the wrong level): while the loading curtain is up, `gameRafLoop` skips
 * `tickPhysics`, so `inputTick` stays at the welcome tick while the wall-clock
 * target keeps moving. When the curtain lifts, `tickPhysics` replayed the
 * whole backlog at MAX_CATCH_UP_TICKS (4) per frame: ~20-30 s of predicting
 * ~2.5x ahead of the server, reconciled back every snapshot — a 20 Hz
 * sawtooth of the drawn ship. Round 3's capital art bakes held the curtain
 * 15-70 s (vs ~12 s), so the catch-up covered the whole take.
 *
 * Repro: hold the curtain with a slow art bake (`artDelayMs`), then, from the
 * first frame `tickPhysics` runs again, sample `inputTick` every frame. A
 * client that has resumed properly runs ~1 tick a frame and stays a few ticks
 * ahead of the server. Measured with the old code: 4 ticks every frame and
 * 13-19-tick snaps for tens of seconds; with the fix: 1 a frame after ~0.2 s.
 */
import { test, expect, chromium } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

/** The showcase's real-GPU flags: on the software renderer frames run ~30 fps,
 *  so 2 ticks a frame is normal there and the test can't judge it. */
const GPU_ARGS = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

test('after a long loading hold the prediction clock resumes in step, not by replaying the backlog', async () => {
  test.setTimeout(90_000);
  const browser = await chromium.launch({ args: GPU_ARGS });
  const { ctx, page } = await launchTestClient(browser, {
    room: 'test-sector', spawnX: 0, spawnY: 0, shipKind: 'fighter',
    extraParams: { worker: '0', art: 'machined', artDelayMs: '12000' },
    waitForInPlay: false, // the spec measures the curtain lift itself
  });
  try {
    const r = await page.evaluate(() => new Promise<{ steps: number[]; ahead: number[]; waitedMs: number; fps: number }>((resolve, reject) => {
      const c = (globalThis as unknown as { __eqxClient?: { inputTick: number; stats: { ticksAhead: number } } }).__eqxClient;
      if (!c) { reject(new Error('no __eqxClient')); return; }
      const t0 = performance.now();
      const start = c.inputTick;
      const steps: number[] = [], ahead: number[] = [];
      let prev = -1, tStart = 0;
      const f = (): void => {
        if (prev < 0) {
          // Wait for the curtain to lift: tickPhysics runs again.
          if (c.inputTick === start) {
            if (performance.now() - t0 > 60_000) { reject(new Error('curtain never lifted')); return; }
            requestAnimationFrame(f); return;
          }
          prev = c.inputTick;
          tStart = performance.now();
          requestAnimationFrame(f); return;
        }
        steps.push(c.inputTick - prev); prev = c.inputTick;
        ahead.push(c.stats.ticksAhead);
        if (steps.length < 120) requestAnimationFrame(f);
        else resolve({ steps, ahead, waitedMs: performance.now() - t0, fps: 120 / ((performance.now() - tStart) / 1000) });
      };
      requestAnimationFrame(f);
    }));
    console.log('[loading-catchup]', JSON.stringify({ waitedMs: Math.round(r.waitedMs), fps: Math.round(r.fps), steps: r.steps.slice(0, 60).join(','), ahead: r.ahead.slice(0, 60).join(',') }));
    test.skip(r.fps < 40, `needs a real GPU (~60 fps) to judge ticks per frame (got ${r.fps.toFixed(0)} fps)`);
    // The hold was long enough to matter (the art delay is the trigger).
    expect(r.waitedMs).toBeGreaterThan(5000);
    // No backlog replay (4-tick frames for tens of seconds). The first ~0.2 s
    // may still catch up a few ticks: snapshots stop while an idle sector sits
    // behind the curtain, so the first one after it re-syncs the clock (a
    // separate, older blip; tracked as a follow-up).
    const later = r.steps.slice(15);
    // The bug's signature is frame after frame at the 4-tick catch-up cap (the
    // old code: every frame for 20-30 s). Occasional 0 / 2 / 3 frames are the
    // display drifting against the tick grid; a rare one-off jump is the older
    // starvation recovery, a different mechanism.
    expect(later.filter((n) => n === 4).length).toBeLessThanOrEqual(3);
    // ...and it settles a few ticks ahead of the server within the 2 s window
    // (the old code sat ~50 ahead for tens of seconds). It can sit ~20 ahead for
    // a moment while the server activates the ship after client_ready.
    expect(Math.max(...r.ahead.slice(-20))).toBeLessThan(15);
  } finally {
    await ctx.close();
    await browser.close();
  }
});
