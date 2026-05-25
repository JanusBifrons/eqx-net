/**
 * Regression lock for the SUSTAINED prediction-spiral phenomenon — the
 * mobile mode the user reported on 2026-05-20 capture `9hj9sl`.
 *
 * Triage breakthrough (2026-05-20): the user is using the nipplejs
 * joystick on phone. The joystick→boolean conversion at
 * `ColyseusClient.tickPhysics()` ~line 2766 has NO hysteresis:
 *
 *   if (delta > TOUCH_TURN_TOLERANCE) tcTurnLeft = true;     // 0.08 rad
 *   else if (delta < -TOUCH_TURN_TOLERANCE) tcTurnRight = true;
 *   if (Math.abs(delta) < TOUCH_THRUST_CONE && mag > TOUCH_THRUST_MAG)
 *     tcThrust = true;
 *
 * `delta = targetAngle - localShip.angle` is recomputed every tick.
 * As the ship rotates toward target, delta crosses the 0.08 rad
 * tolerance — turnLeft toggles OFF. Joystick analog noise then nudges
 * delta back across — turnLeft toggles ON. The boolean inputs flicker
 * at ~10 Hz under normal stick use, even when the user *thinks* they
 * are holding a steady direction.
 *
 * Each state change drives the input-throttle send + a fresh
 * input-message → server queue → reconciler-replay cycle. The
 * companion `spiral-in-pack-density.spec.ts` shows that a SINGLE input
 * state change produces a 3-second drift transient (8-27 corrections
 * in first 3s, then convergence). Repeated state changes at 10 Hz
 * prevent convergence and produce the sustained spiral the user
 * observed.
 *
 * **This spec simulates joystick flicker on desktop** by alternating
 * `keyboard.down/up('a')` and `keyboard.down/up('d')` every 100 ms
 * while holding W. Keyboard A maps to `turnLeft`, D to `turnRight` —
 * same boolean fields the joystick toggles. The cadence mimics the
 * empirical ~10 Hz state-change rate from the on-device capture's
 * `corrections.ndjson`.
 *
 * What this spec asserts: 25 s of joystick-shaped input keeps
 * prediction state bounded:
 *
 *   - peak `ticksAhead < 30` (CEILING_TICKS)
 *   - peak `rollingCorrRate < 0.6` (netHealthBudget ceil)
 *
 * Currently EXPECTED TO FAIL on `feat/perf-floor@42f3b84` —
 * regression lock per invariant #13.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const PLAY_MS = 25_000;
const TURN_FLIP_MS = 100;

interface PredStats {
  ticksAhead: number;
  driftUnits: number;
  maxDriftUnits: number;
  rollingCorrRate: number;
  rafP99Ms: number;
  snapshotCount: number;
  significantCorrectionCount: number;
  totalDriftUnits: number;
}

async function readPredStats(page: Page): Promise<PredStats | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    const raw = el?.getAttribute('data-pred-stats');
    return raw ? (JSON.parse(raw) as PredStats) : null;
  });
}

test('joystick-flicker spiral: alternating turn at 10 Hz keeps prediction bounded', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}/?room=feel-test-25&spawnX=0&spawnY=0&diag=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 15_000 });
  await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute(
    'data-warp-visible',
    '0',
    { timeout: 30_000 },
  );
  const diagOn = await page.evaluate(
    () => (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true,
  );
  expect(diagOn).toBe(false);

  // ── Joystick simulation ──────────────────────────────────────────
  // Hold W (thrust) constantly. Alternate A/D every TURN_FLIP_MS to
  // simulate the analog stick's micro-delta crossings of
  // TOUCH_TURN_TOLERANCE. Real on-device: ~10 Hz toggle rate observed.
  await page.keyboard.down('w');
  const samples: PredStats[] = [];
  const startMs = Date.now();
  let lastFlip = startMs;
  let turning: 'a' | 'd' = 'a';
  await page.keyboard.down(turning);
  let lastSample = startMs;

  while (Date.now() - startMs < PLAY_MS) {
    const now = Date.now();
    if (now - lastFlip >= TURN_FLIP_MS) {
      await page.keyboard.up(turning);
      turning = turning === 'a' ? 'd' : 'a';
      await page.keyboard.down(turning);
      lastFlip = now;
    }
    if (now - lastSample >= 1500) {
      const s = await readPredStats(page);
      if (s) {
        samples.push({ ...s, _t: Math.round((now - startMs) / 1000) } as PredStats & { _t: number });
      }
      lastSample = now;
    }
    await page.waitForTimeout(50);
  }
  await page.keyboard.up('w');
  await page.keyboard.up(turning);

  /* eslint-disable no-console */
  console.log(`\n=== joystick-flicker spiral (alternating A/D @ 10 Hz) — ${samples.length} samples ===`);
  for (const s of samples) {
    const t = (s as PredStats & { _t?: number })._t ?? 0;
    const mean = s.snapshotCount > 0 ? s.totalDriftUnits / s.snapshotCount : 0;
    console.log(
      `  t=${String(t).padStart(3)}s ticksAhead=${String(s.ticksAhead).padStart(3)} ` +
        `lastDrift=${s.driftUnits.toFixed(3).padStart(7)}u meanDrift=${mean.toFixed(3).padStart(6)}u ` +
        `maxDrift=${s.maxDriftUnits.toFixed(1).padStart(6)}u corr=${s.rollingCorrRate.toFixed(2)} ` +
        `corrs=${s.significantCorrectionCount}/${s.snapshotCount}`,
    );
  }
  const maxTicksAhead = Math.max(...samples.map((s) => s.ticksAhead));
  const maxCorr = Math.max(...samples.map((s) => s.rollingCorrRate));
  const last = samples[samples.length - 1]!;
  const corrRatio = last.snapshotCount > 0 ? last.significantCorrectionCount / last.snapshotCount : 0;
  console.log(`  PEAK: ticksAhead=${maxTicksAhead}, maxCorr=${maxCorr.toFixed(2)}, finalCorrRatio=${corrRatio.toFixed(2)}`);
  /* eslint-enable no-console */

  expect(samples.length).toBeGreaterThan(5);
  expect(maxTicksAhead, 'ticksAhead must NOT cross CEILING_TICKS=30 under joystick-flicker').toBeLessThan(30);
  expect(maxCorr, 'rollingCorrRate must NOT cross 0.6 under joystick-flicker').toBeLessThan(0.6);

  expect(errors, errors.join('\n')).toHaveLength(0);
  await ctx.close();
});
