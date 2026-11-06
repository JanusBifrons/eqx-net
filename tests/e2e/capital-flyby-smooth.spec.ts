/**
 * Smoke-test bug (user, 2026-11-05, round 3 fly-by clip): "The ship is
 * jittering around everywhere like crazy in the clip unfortunately, it's not
 * smooth at all."
 *
 * Measured on the clip (showcase-out/round3/clips/capital-flyby, frames
 * 760-820): with the camera tracking the fighter, its screen position spikes
 * 6-8 px every 3-4 frames along its flight path.
 *
 * Repro: a fighter holds W along the starboard side of the parked 10×
 * battleship in `showcase-capitals`. Per RAF we sample the RENDERED local
 * pose (`mirror.ships[local]`, what the sprite draws) and its timestamp; a
 * smooth flight has a steady per-frame velocity. Control: the same flight
 * far from any capital.
 *
 * Cause (found with a per-frame probe, plain test-sector too, so not the
 * capital): the dead-reckon stamp was the tick's processing time, so frames
 * that ran 2 / 0 / 1 ticks drew +2 / +1 / +0 ticks of motion. Fixed in
 * renderTickPhase.ts (deterministic lock: renderTickPhase.test.ts). This spec
 * needs a real GPU; it skips (and says why) on a software renderer.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';
import { getShipKind } from '../../src/shared-types/shipKinds';

const ROOM = 'showcase-capitals' as unknown as 'test-sector';

/** Battleship x in the showcase line-up (mirrors showcaseRooms.capitalLineup). */
function battleshipX(): number {
  let gap = 0;
  for (const id of ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship']) {
    const hull = (getShipKind(id).shape as { hull?: ReadonlyArray<readonly [number, number]> }).hull ?? [];
    let w = 10;
    for (const [x] of hull) w = Math.max(w, Math.abs(x));
    gap = Math.max(gap, 2 * w * 2.6);
  }
  return 2 * gap;
}

/** The showcase's real-GPU flags: smoothness can't be judged on the software
 *  renderer the default E2E browser uses (~4 fps here). */
const GPU_ARGS = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/** `frames`: frames with no correction being smoothed (where judder shows). */
interface Jitter { frames: number; fps: number; speed: number; spikes: number; worstJump: number; corrections: number; maxDrift: number }

/** Hold W for `ms`, sampling the rendered local pose every RAF. */
async function flyAndMeasure(page: Page, ms: number): Promise<Jitter> {
  await page.waitForFunction(() => !!(globalThis as { __eqxClient?: { mirror?: { localPlayerId?: string } } }).__eqxClient?.mirror?.localPlayerId);
  await page.keyboard.down('w');
  // Steady flight: prediction settles over the first seconds after a join (a
  // separate issue); the showcase records long after joining too.
  await page.waitForTimeout(6000);
  const corr0 = await page.evaluate(() => (globalThis as unknown as { __eqxClient: { stats: { significantCorrectionCount: number } } }).__eqxClient.stats.significantCorrectionCount);
  const samples = await page.evaluate((dur) => new Promise<Array<[number, number, number, number]>>((resolve) => {
    const c = (globalThis as unknown as { __eqxClient: { mirror: { localPlayerId: string; ships: Map<string, { x: number; y: number }> }; stats: { significantCorrectionCount: number }; reconciler: { lerpOffset: { x: number; y: number } } | null } }).__eqxClient;
    const out: Array<[number, number, number, number]> = [];
    let lastCorr = c.stats.significantCorrectionCount;
    const corrs: string[] = [];
    (globalThis as { __corrLog?: string[] }).__corrLog = corrs;
    const t0 = performance.now();
    const tick = (now: number): void => {
      const s = c.mirror.ships.get(c.mirror.localPlayerId);
      const lo = c.reconciler?.lerpOffset;
      if (s) out.push([now, s.x, s.y, lo ? Math.hypot(lo.x, lo.y) : 0]);
      if (c.stats.significantCorrectionCount !== lastCorr) { lastCorr = c.stats.significantCorrectionCount; const o = c.reconciler?.lerpOffset; if (o && s) corrs.push(`at(${s.x.toFixed(0)},${s.y.toFixed(0)}) off(${o.x.toFixed(2)},${o.y.toFixed(2)})`); }
      if (now - t0 < dur) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  }), ms);
  console.log('[corr]', (await page.evaluate(() => (globalThis as { __corrLog?: string[] }).__corrLog ?? [])).join(' | '));
  await page.keyboard.up('w');
  const corr1 = await page.evaluate(() => (globalThis as unknown as { __eqxClient: { stats: { significantCorrectionCount: number } } }).__eqxClient.stats.significantCorrectionCount);
  // Per-frame velocity.
  // `lerping[i]`: a server correction is being smoothed out on this frame (a
  // separate effect from the dead-reckon judder this spec locks).
  const v: number[] = [];
  const lerping: boolean[] = [];
  for (let i = 1; i < samples.length; i++) {
    const [t0, x0, y0, l0] = samples[i - 1]!, [t1, x1, y1, l1] = samples[i]!;
    const dt = (t1 - t0) / 1000;
    if (dt > 0.004) { v.push(Math.hypot(x1 - x0, y1 - y0) / dt); lerping.push(l0 > 0 || l1 > 0); }
  }
  const sorted = [...v].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  // A spike = a frame's velocity off the mean of its two neighbours by > 35 %
  // of cruise (acceleration is smooth; a correction or a stall is not).
  let spikes = 0, worst = 0, steady = 0;
  for (let i = 1; i + 1 < v.length; i++) {
    if (lerping[i - 1] || lerping[i] || lerping[i + 1]) continue;
    steady++;
    const d = Math.abs(v[i]! - (v[i - 1]! + v[i + 1]!) / 2) / Math.max(1, med);
    if (d > 0.35) spikes++;
    worst = Math.max(worst, d);
  }
  const maxDrift = await page.evaluate(() => (globalThis as unknown as { __eqxClient: { stats: { maxDriftUnits: number } } }).__eqxClient.stats.maxDriftUnits);
  const span = samples.length > 1 ? (samples[samples.length - 1]![0] - samples[0]![0]) / 1000 : 1;
  return { frames: steady, fps: (samples.length - 1) / span, speed: med, spikes, worstJump: worst, corrections: corr1 - corr0, maxDrift };
}

test.describe('capital fly-by is smooth', () => {
  let browser: Browser;
  test.beforeAll(async () => { browser = await chromium.launch({ args: GPU_ARGS }); });
  test.afterAll(async () => { await browser.close(); });

  test('a fighter flying alongside a 10x battleship renders as smoothly as one in open space', async () => {
    test.setTimeout(90_000);
    const bsX = battleshipX();
    const near = await launchTestClient(browser, { room: ROOM, spawnX: Math.round(bsX + 650), spawnY: -2600, shipKind: 'fighter', initialHull: 1_000_000, extraParams: { worker: '0' } });
    const nearJ = await flyAndMeasure(near.page, 4000);
    await near.ctx.close();
    const far = await launchTestClient(browser, { room: ROOM, spawnX: Math.round(bsX + 650), spawnY: -16_000, shipKind: 'fighter', initialHull: 1_000_000, extraParams: { worker: '0' } });
    const farJ = await flyAndMeasure(far.page, 4000);
    await far.ctx.close();
    console.log('[flyby-jitter] near', JSON.stringify(nearJ), 'far', JSON.stringify(farJ));
    test.skip(nearJ.fps < 40 || farJ.fps < 40, `needs a real GPU to judge smoothness (got ${nearJ.fps.toFixed(0)} / ${farJ.fps.toFixed(0)} fps)`);
    // Measured 2026-11-05 (60 fps, this PC): before the fix 16-39 % of frames
    // spiked (worst 11x a frame's motion); after it 1-5 %.
    expect(nearJ.frames).toBeGreaterThan(100);
    expect(nearJ.spikes / nearJ.frames).toBeLessThan(0.08);
    expect(farJ.spikes / farJ.frames).toBeLessThan(0.08);
  });
});
