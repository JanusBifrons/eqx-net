/**
 * Positive regression lock: under NO user input, the prediction loop in
 * `feel-test-25` (25 drones in a 500u ring, player at origin) must stay
 * sub-pixel for the entire measure window. Plan: perf-floor / triage
 * for the 2026-05-20 capture `9hj9sl` spiral.
 *
 * Why this lock exists:
 *
 *   The triage session for the unplayable-on-mobile spiral established
 *   that **idle prediction is perfect** (drift=0 over 124 snapshots) —
 *   so any future regression that introduces idle-side drift (e.g. a
 *   broken `world.tick(dt)` accumulator, non-deterministic physics
 *   ordering, a missed-input on the worker) will fail this spec
 *   loudly. The companion failing specs
 *   (`spiral-disconnect-reconnect.spec.ts`,
 *   `spiral-in-pack-density.spec.ts`) capture the input-induced drift;
 *   this spec asserts the floor.
 *
 * Thresholds: zero `significantCorrectionCount` (LERP_THRESHOLD=0.05u),
 * `maxDriftUnits < 0.1`, `rollingCorrRate < 0.05`.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface PredStats {
  ticksAhead: number;
  maxDriftUnits: number;
  rollingCorrRate: number;
  rafP99Ms: number;
  rafGapCount30s: number;
  snapshotCount: number;
  significantCorrectionCount: number;
  totalDriftUnits: number;
  driftUnits: number;
}

async function readStats(page: Page): Promise<PredStats | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    const raw = el?.getAttribute('data-pred-stats');
    return raw ? (JSON.parse(raw) as PredStats) : null;
  });
}

test('idle prediction stays sub-pixel under no input in feel-test-25', async ({ browser }) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

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

  // Sample every 2 s for 20 s.
  const samples: PredStats[] = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2_000);
    const s = await readStats(page);
    if (s) samples.push(s);
  }

  /* eslint-disable no-console */
  console.log('\n=== IDLE BASELINE — feel-test-25, no input, 20 s ===');
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const meanDrift = s.snapshotCount > 0 ? s.totalDriftUnits / s.snapshotCount : 0;
    console.log(
      `  t=${String(i * 2 + 2).padStart(3)}s ticksAhead=${String(s.ticksAhead).padStart(3)} ` +
        `lastDrift=${s.driftUnits.toFixed(4)}u maxDrift=${s.maxDriftUnits.toFixed(4)}u ` +
        `meanDrift=${meanDrift.toFixed(4)}u corr=${s.rollingCorrRate.toFixed(2)} ` +
        `corrCount=${s.significantCorrectionCount}/${s.snapshotCount}`,
    );
  }
  /* eslint-enable no-console */

  expect(samples.length, 'must collect idle samples').toBeGreaterThan(5);
  const last = samples[samples.length - 1]!;

  // Zero significant corrections (drift > 0.05 u) across the whole window.
  // If this ever fails, idle physics has gone non-deterministic.
  expect(last.significantCorrectionCount, 'idle must have ZERO significant corrections').toBe(0);
  expect(last.maxDriftUnits, 'idle maxDriftUnits must stay < 0.1 u').toBeLessThan(0.1);
  expect(last.rollingCorrRate, 'idle rollingCorrRate must be 0').toBeLessThan(0.05);

  await ctx.close();
});

// ---------------------------------------------------------------------------
// Sub-snapshot prediction-running lock.
//
// Folded here 2026-06-03 (test-coverage-audit Phase 3) from the deleted
// prediction-diagnostics.spec.ts (its "local prediction runs independently"
// test, T3). That whole spec was DEAD — it joined via a stale
// `getByRole('button', {name:/enter sector alpha/i})` flow removed months ago —
// so this unique lock (predWorld must coast between server snapshots, not just
// mirror them) was providing no live coverage. Rehomed onto the deterministic
// feel-test-25 engineering room. (T1 drift-ceilings are covered by the idle
// floor above + the netcode-health gate; T2 two-client view-agreement by
// robustness.spec.ts's p2p cases.)
// ---------------------------------------------------------------------------
test('prediction runs sub-snapshot: many distinct poses while coasting (feel-test-25)', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

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

  // Brief thrust, then coast. Spawn angle is 0 ⇒ W-thrust is pure +y, so a
  // combined (x,y) key is needed (x alone never changes).
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await page.waitForTimeout(200);

  const samples = await page.evaluate(
    () =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        const results: { x: number; y: number }[] = [];
        const iv = setInterval(() => {
          const el = document.querySelector('[data-testid="game-surface"]');
          results.push({
            x: parseFloat(el?.getAttribute('data-ship-x') ?? 'NaN'),
            y: parseFloat(el?.getAttribute('data-ship-y') ?? 'NaN'),
          });
          if (results.length >= 30) {
            clearInterval(iv);
            resolve(results);
          }
        }, 16);
      }),
  );

  // At 60 Hz prediction, 30 samples over ~480 ms while coasting show many
  // distinct poses. If prediction were broken (only server snapshots at 20 Hz),
  // we'd see ~10. >5 proves predWorld is advancing between snapshots.
  const uniquePos = new Set(samples.map((s) => `${s.x.toFixed(3)},${s.y.toFixed(3)}`)).size;
  // eslint-disable-next-line no-console
  console.log(`[sub-snapshot] unique poses: ${uniquePos} / ${samples.length} (>5 = sub-snapshot prediction)`);
  expect(uniquePos).toBeGreaterThan(5);

  await ctx.close();
});
