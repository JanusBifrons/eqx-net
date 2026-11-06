/**
 * Slow-down-tune regression lock (the Invariant #9 E2E the catalogue tuning
 * ships with).
 *
 * 2026-06-03 (test-coverage-audit Phase 3): trimmed to this single test. The
 * former "Stage 1: every queued correction lerp uses halfLife ≤ 25 ms" test was
 * removed — it joined the non-deterministic `?room=sector` (30 random hostile
 * drones) and silently trivial-passed when no corrections were logged, and its
 * coverage is owned deterministically elsewhere (the netcode-health gate for
 * correction rate + the Reconciler unit tests for the spring half-life). The
 * slow-down displacement assertion below lives nowhere else, so it stays.
 */
import { test, expect } from '@playwright/test';
import { launchTestClient, getShipX, getShipY, waitForInPlay } from './helpers/gameScenario';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { motionFactors } from '../../src/shared-types/shipScale/tuning';

/**
 * Regression lock for the 2026-05-18 "slow down gameplay" tune
 * (plan: i-d-like-you-to-silly-penguin — ship speed halved). Drives the
 * default Fighter (DEFAULT_SHIP_KIND) with held-thrust (no boost) for a fixed
 * 5 s window through the real client-prediction path and asserts the local
 * ship's displacement lands in the post-tune band.
 *
 * Why this would catch a revert: with the new thrust the Fighter's cruise
 * terminal is ~401 u/s and 5 s of accelerate-from-rest covers ~970 u; the
 * PRE-tune thrust (2×) covered ~1940 u over the same window. The upper bound
 * (1500) excludes the old value with margin while staying generous enough to
 * absorb host-load / frame-timing jitter (physics is fixed-timestep, so the
 * tick count over 5 s wall-clock is stable regardless of FPS).
 */
test('slow-down tune: Fighter held-thrust displacement is in the halved band', async ({
  browser,
}) => {
  const { ctx, page } = await launchTestClient(browser, { spawnX: 0, spawnY: 0 });

  // Thrust only counts once the ship is in play (curtain lifted); then let any
  // spawn correction settle before sampling.
  await waitForInPlay(page);
  await page.waitForTimeout(500);

  const startX = await getShipX(page);
  const startY = await getShipY(page);

  // Hold W (thrust, no boost) for a fixed 5 s window.
  await page.keyboard.down('w');
  await page.waitForTimeout(5000);
  await page.keyboard.up('w');
  await page.waitForTimeout(300);

  const endX = await getShipX(page);
  const endY = await getShipY(page);
  const displacement = Math.hypot(endX - startX, endY - startY);

  console.log('\n=== slow-down tune: Fighter 5 s held-thrust displacement ===');
  console.log(`start=(${startX.toFixed(1)}, ${startY.toFixed(1)})`);
  console.log(`end  =(${endX.toFixed(1)}, ${endY.toFixed(1)})`);
  console.log(`displacement=${displacement.toFixed(1)} u (post-tune ~970; pre-tune ~1940)`);
  console.log('===========================================================\n');

  // The ~970 / ~1940 figures are at the authored 1× ship size. Bigger ships fly
  // slower (motionFactors: ~0.71× at the 2× default), so scale the band by the
  // fighter's speed factor at whatever size this run uses (invariant #18).
  const speed = motionFactors(getShipKind('fighter').appliedScale ?? 1).speed;
  console.log(`ship-scale speed factor ${speed.toFixed(3)} → band ${(400 * speed).toFixed(0)}–${(1500 * speed).toFixed(0)} u`);
  // Sanity floor: the ship clearly moved (well above prediction noise) even
  // on a slow host.
  expect(displacement).toBeGreaterThan(400 * speed);
  // Revert lock: pre-tune (2× thrust) would overshoot ~1940 u (× speed); this
  // bound fails loudly if the catalogue speed is reverted/half-reverted.
  expect(displacement).toBeLessThan(1500 * speed);

  await ctx.close();
});
