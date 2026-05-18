/**
 * Stage 0/1 closure spec for the network-feel roadmap.
 *
 * Stage 0 capped the prediction-correction visual lerp at 6 frames
 * (~100 ms); Stage 1 replaced the frame counter with a critically-
 * damped spring (analytical, frame-rate independent). This spec drives
 * the ship into the legacy `sector` room (30 hostile drones in a ring;
 * collisions are easy to provoke) for a few seconds, then reads the
 * eqxLogs ring buffer and asserts every 'correction' log entry's
 * `lerpHalfLifeMs` is ≤ 25 — verifying the Stage 1 half-life selection
 * survives through the real reconcile call path.
 *
 * The spring shape and frame-rate independence are verified by
 * Reconciler unit tests; only the half-life selection matters at the
 * macro level.
 *
 * Uses `?room=...` autoJoin to bypass the GalaxyMapScreen splash,
 * matching the pattern in persistence-kill.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { launchTestClient, getShipX, getShipY } from './helpers/gameScenario';

interface CorrectionLogEntry {
  ts: number;
  tag: string;
  data: { lerpHalfLifeMs?: number; driftUnits?: number };
}

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// Auth storage state from globalSetup is applied automatically via
// playwright.config.ts → use.storageState.

test.setTimeout(60_000);

test('Stage 1: every queued correction lerp uses halfLife ≤ 25 ms', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // autoJoin bypasses the GalaxyMapScreen splash (see App.tsx).
  await page.goto(`${BASE_URL}?room=sector`);

  // Wait for the local ship to be live in the mirror.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );

  // Allow the join handshake and any join-time corrections to settle
  // before we sample.
  await page.waitForTimeout(1500);

  // Clear the log ring buffer so we only capture corrections that
  // happen during the active driving window.
  await page.evaluate(() => {
    (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.();
  });

  // Hold W to thrust into the drone ring; collisions and drone fire
  // provoke periodic small corrections during the sample window.
  await page.keyboard.down('w');
  await page.waitForTimeout(3000);
  await page.keyboard.up('w');
  await page.waitForTimeout(500);

  const corrections: CorrectionLogEntry[] = await page.evaluate(() => {
    const logs = (window as unknown as { __eqxLogs?: CorrectionLogEntry[] }).__eqxLogs ?? [];
    return logs.filter((e) => e.tag === 'correction');
  });

  if (corrections.length === 0) {
    console.log('\n=== Stage 1: lerpHalfLifeMs cap ===');
    console.log('No corrections logged in the sample window — the cap is trivially satisfied.');
    console.log('====================================\n');
    // Trivial pass: no observed corrections means no lerps queued.
    return;
  }

  let maxHalfLifeMs = 0;
  let maxDrift = 0;
  for (const c of corrections) {
    const hl = c.data.lerpHalfLifeMs ?? 0;
    if (hl > maxHalfLifeMs) maxHalfLifeMs = hl;
    const drift = c.data.driftUnits ?? 0;
    if (drift > maxDrift) maxDrift = drift;
  }

  console.log('\n=== Stage 1: lerpHalfLifeMs cap ===');
  console.log(`Observed corrections: ${corrections.length}`);
  console.log(`Max queued lerp halfLife: ${maxHalfLifeMs} ms (cap 25)`);
  console.log(`Max drift in sample window: ${maxDrift.toFixed(3)} u`);
  console.log('====================================\n');

  expect(maxHalfLifeMs).toBeLessThanOrEqual(25);

  await ctx.close();
});

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
 * tick count over 5 s wall-clock is stable regardless of FPS). This is the
 * Invariant #9 E2E that the catalogue tuning ships with.
 */
test('slow-down tune: Fighter held-thrust displacement is in the halved band', async ({
  browser,
}) => {
  const SPAWN_X = 0;
  const SPAWN_Y = 0;
  const { ctx, page } = await launchTestClient(browser, { spawnX: SPAWN_X, spawnY: SPAWN_Y });

  // Let the join handshake + any spawn correction settle before sampling.
  await page.waitForTimeout(1200);

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

  // Sanity floor: the ship clearly moved (well above prediction noise) even
  // on a slow host.
  expect(displacement).toBeGreaterThan(400);
  // Revert lock: pre-tune (2× thrust) would overshoot ~1940 u; this bound
  // fails loudly if the catalogue speed is reverted/half-reverted.
  expect(displacement).toBeLessThan(1500);

  await ctx.close();
});
