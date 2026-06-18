/**
 * Phase-1 issue 5 — scrap-collision reconciliation stress (reproduction-first).
 *
 * User report (Equinox Tweaks doc): "There is still a major issue with flying
 * into scrap, it lags and issues many corrections … stress testing is probably
 * worth it, have an engineering room spawn in a bunch of scrap and have the
 * player's ship fly through it causing a cascade of collisions."
 *
 * This is that test. The `scrap-stress-test` room pre-seeds 50 free-floating
 * scrap pieces (the real `restoreScrapFromSnapshot` path → byte-identical to
 * death-spawned scrap) in a dense corridor ahead of spawn; we fly the player
 * straight through at full thrust and read the prediction-reconciliation
 * telemetry off `data-pred-stats`:
 *   - collisionEventsApplied   (proves real contact happened)
 *   - significantCorrectionCount + rollingCorrRate (the "many corrections")
 *   - maxDriftUnits            (how far prediction diverged from authority)
 *
 * The numbers are PRINTED for diagnosis; the assertions lock (a) that the
 * flythrough actually collides and (b) a playable correction/drift ceiling so a
 * future regression that re-introduces the scrap desync fails here.
 *
 * FINDINGS (2026-06-18, measured on this harness):
 *   - The CATASTROPHIC scrap desync the report described ("flies inside / huge
 *     corrections") is ALREADY FIXED (the 2026-06-14 kinematic-follower pivot):
 *     peak drift through a 50-piece cascade is ~18 u, not the old 100 u+.
 *   - The residual is bounded (~22 % correction rate, ~18 u, peak rolling 0.40)
 *     — the inherent cost of the display-delayed follower colliding with the
 *     player; flying into 7 light dynamic bodies always corrects somewhat.
 *   - The "obvious" fix (feed scrap its wire `angvel` to the follower) was A/B'd
 *     here and FALSIFIED — it nearly DOUBLED corrections (0.40→0.80 rolling,
 *     18→39 u). Reverted; holding the interpolated angle (angvel 0) is correct.
 *   So this spec stands as the REGRESSION LOCK on the already-good state: a
 *   re-break of the desync (or a bad follower change) blows past the ceilings.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.setTimeout(60_000);

interface PredStats {
  snapshotCount: number;
  collisionEventsApplied: number;
  significantCorrectionCount: number;
  rollingCorrRate: number;
  maxDriftUnits: number;
  totalDriftUnits: number;
  ticksAhead: number;
}

function readStats(page: Page): Promise<PredStats> {
  return page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
    const s = JSON.parse(raw ?? '{}') as Partial<PredStats>;
    return {
      snapshotCount: s.snapshotCount ?? 0,
      collisionEventsApplied: s.collisionEventsApplied ?? 0,
      significantCorrectionCount: s.significantCorrectionCount ?? 0,
      rollingCorrRate: s.rollingCorrRate ?? 0,
      maxDriftUnits: s.maxDriftUnits ?? 0,
      totalDriftUnits: s.totalDriftUnits ?? 0,
      ticksAhead: s.ticksAhead ?? 0,
    };
  });
}

test('flying through 50 scrap pieces — corrections + drift stay playable (issue 5)', async ({ browser }) => {
  const testId = randomUUID();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // initialAngle=0 ⇒ forward is +y, straight down the seeded scrap corridor.
  await page.goto(`${BASE_URL}?room=scrap-stress-test&testId=${testId}&initialAngle=0`);

  // Player + the 50 scrap pieces live (allow margin for slot-pool truncation).
  await page.waitForFunction(
    () => {
      const ships = parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace(/\D/g, '') ?? '0', 10);
      const swarm = parseInt(document.querySelector('[data-testid="swarm-count"]')?.textContent?.replace(/\D/g, '') ?? '0', 10);
      return ships >= 1 && swarm >= 40;
    },
    { timeout: 15_000 },
  );

  // Let the initial-spawn lerp settle so it doesn't pollute the drift signal.
  await page.waitForFunction(
    () => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
      try { return (JSON.parse(raw ?? '{}').snapshotCount ?? 0) >= 40; } catch { return false; }
    },
    { timeout: 12_000 },
  );

  const before = await readStats(page);

  // Focus the canvas, then plow forward (thrust + boost) through the corridor.
  // Poll the peak rolling correction rate during the run.
  await page.locator('[data-testid="game-surface"]').click();
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  let peakCorrRate = 0;
  let peakDrift = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500); // ~6 s total flight
    const s = await readStats(page);
    if (s.rollingCorrRate > peakCorrRate) peakCorrRate = s.rollingCorrRate;
    if (s.maxDriftUnits > peakDrift) peakDrift = s.maxDriftUnits;
  }
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(500);

  const after = await readStats(page);

  const collisions = after.collisionEventsApplied - before.collisionEventsApplied;
  const corrections = after.significantCorrectionCount - before.significantCorrectionCount;
  const snapshots = after.snapshotCount - before.snapshotCount;
  const corrPerSnapshot = snapshots > 0 ? corrections / snapshots : 0;

  console.log('\n=== Scrap-collision stress — flythrough of 50 scrap ===');
  console.log(`snapshots during flight : ${snapshots}`);
  console.log(`collisions applied      : ${collisions}`);
  console.log(`significant corrections : ${corrections}  (${(corrPerSnapshot * 100).toFixed(1)}% of snapshots)`);
  console.log(`peak rollingCorrRate    : ${peakCorrRate.toFixed(3)}`);
  console.log(`peak maxDriftUnits      : ${peakDrift.toFixed(2)} u   (final ${after.maxDriftUnits.toFixed(2)} u)`);
  console.log(`ticksAhead (final)      : ${after.ticksAhead}`);
  console.log('=======================================================\n');

  // (a) The flythrough must actually collide — else the test isn't reproducing
  // anything (corridor missed / scrap colliders dead).
  expect(collisions, 'the ship must actually hit scrap (else the repro is invalid)').toBeGreaterThan(0);

  // (b) The GATE is peak prediction DRIFT — the stable, discriminating signal
  // (baseline ~16-18 u across runs; the falsified angvel experiment hit ~39 u; a
  // re-broken desync would be 100 u+). `rollingCorrRate` is PRINT-ONLY: it's
  // run-to-run noisy here (0.40-0.70 on the same baseline as collision timing
  // varies), so gating it would flake — same demote-the-jitter-prone-metric
  // philosophy the netgate uses for snapshotJitterMs.
  expect(peakDrift, `peak prediction drift through the scrap cascade = ${peakDrift.toFixed(1)} u (baseline ~18 u; angvel-regression ~39 u)`).toBeLessThan(30);

  await ctx.close();
});
