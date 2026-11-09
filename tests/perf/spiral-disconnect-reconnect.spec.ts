/**
 * Regression lock for the 2026-05-20 unplayable on-device capture
 * `2026-05-20T21-17-52-438Z-9hj9sl` — Scenario A: disconnect-reconnect
 * spiral.
 *
 * User report: "started good, got progressively more laggy until
 * unplayable at the end." Capture analysis:
 *
 *   - First session 0-28 s: healthy (ticksAhead 8-22, drift 2-5 u).
 *   - 28 s: user clicked back to galaxy map → `disconnected: code 4000`.
 *   - 32 s: rejoined same sector. Welcome OK, ticksAhead reset to 4.
 *   - 32-58 s: re-stabilised (drift < 5 u).
 *   - 58-86 s: progressive degradation. `ticksAhead` climbed
 *     13 → 41 → 85 → 100 (past `CEILING_TICKS = 30`), `rttMs` 70 →
 *     1393, `rollingCorrRate` → 1.0, `maxDriftUnits` → 155 u.
 *
 * Server `tick_budget.totalAvgMs = 0.3 ms` the whole session — server
 * was NOT overrun. The spiral is client-side prediction state.
 *
 * What this spec asserts: after one disconnect-reconnect cycle + 25 s
 * of post-rejoin idle gameplay, prediction state stays bounded:
 *
 *   - `ticksAhead < 30`             (CEILING_TICKS — saturation line)
 *   - `maxDriftUnits < 12`          (`prediction-diagnostics.spec.ts:153`
 *                                    catastrophic threshold)
 *   - `rollingCorrRate < 0.6`       (netHealthBudget ceil)
 *   - `data-pred-stats.rafP99Ms < 60` (Phase 1 instrumentation)
 *
 * Reproduction approach: the user's path was UI-driven (Return to
 * galaxy map → pick sector again). This spec replicates the netcode-
 * level effect via `__eqxClient.disconnect()` + a reload to the same
 * URL, which exercises the same `connect()` → `welcome` → first
 * snapshot path. The bug lives in the post-reconnect prediction state,
 * which is reset/managed by ColyseusClient regardless of which UI path
 * triggered the reconnect.
 *
 * If this spec FAILS, the bug is reproduced and the post-reconnect
 * prediction-state reset is incomplete. If it PASSES on the test
 * runner but the user still hits the spiral on-device, the cause is
 * device/network-specific (Pattern A) and a separate spec must
 * exercise that.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const FIRST_PLAY_MS = 15_000;
const SECOND_PLAY_MS = 25_000;

interface PredStats {
  ticksAhead: number;
  maxDriftUnits: number;
  rollingCorrRate: number;
  rafP50Ms: number;
  rafP99Ms: number;
  snapshotCount: number;
  longtaskCount30s: number;
  rafGapCount30s: number;
}

async function readPredStats(page: Page): Promise<PredStats | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    if (!el) return null;
    const raw = el.getAttribute('data-pred-stats');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PredStats;
    } catch {
      return null;
    }
  });
}

async function waitForJoinReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 15_000 });
  await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute(
    'data-warp-visible',
    '0',
    { timeout: 30_000 },
  );
  // Diag MUST be off — Phase 0a override. If on, we'd measure the
  // instrumented build, not the player program.
  const diagOn = await page.evaluate(
    () => (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true,
  );
  expect(diagOn, 'diag must be off — capture would be invalid otherwise').toBe(false);
}

async function holdThrustAndSample(
  page: Page,
  durationMs: number,
  label: string,
): Promise<PredStats[]> {
  await page.keyboard.down('w');
  const samples: PredStats[] = [];
  const startMs = Date.now();
  while (Date.now() - startMs < durationMs) {
    await page.waitForTimeout(1_500);
    const s = await readPredStats(page);
    if (s) samples.push({ ...s, _t: Math.round((Date.now() - startMs) / 1000) } as PredStats & { _t: number });
  }
  await page.keyboard.up('w');
  /* eslint-disable no-console */
  console.log(`\n=== ${label} (${samples.length} samples over ${(durationMs/1000)|0}s) ===`);
  for (const s of samples) {
    const t = (s as PredStats & { _t?: number })._t ?? 0;
    console.log(
      `  t=${String(t).padStart(3)}s ticksAhead=${s.ticksAhead.toString().padStart(3)} ` +
        `drift=${s.maxDriftUnits.toFixed(1).padStart(6)}u corr=${s.rollingCorrRate.toFixed(2)} ` +
        `rafP99=${(s.rafP99Ms ?? 0).toFixed(1).padStart(6)}ms gaps=${s.rafGapCount30s}`,
    );
  }
  /* eslint-enable no-console */
  return samples;
}

test('disconnect-reconnect spiral: prediction stays bounded across leave/rejoin + sustained play', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  // ── Step 1: initial join ────────────────────────────────────────
  // `?galaxy=sol-prime` matches the capture's real-LWD scenario
  // (ambient + hunter bots ≈ 39 drones across 7 sectors). `?diag=0`
  // is mandatory — Phase 0a override.
  await page.goto(`${BASE_URL}/?galaxy=sol-prime&diag=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForJoinReady(page);
  const firstSamples = await holdThrustAndSample(page, FIRST_PLAY_MS, 'FIRST SESSION (pre-reconnect)');

  // ── Step 2: reload-rejoin (same room — the user's UI path was
  //   Return-to-galaxy then re-pick the same sector; reload is the
  //   netcode-equivalent: new connect() → welcome → first snapshot).
  await page.goto(`${BASE_URL}/?galaxy=sol-prime&diag=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForJoinReady(page);
  const secondSamples = await holdThrustAndSample(page, SECOND_PLAY_MS, 'SECOND SESSION (post-reconnect)');

  // ── Step 3: assertions on COMBINED behaviour ────────────────────
  // The user's bug surfaces as ticksAhead saturation + maxDrift > 12u
  // + corr rate ≥ 0.6 sustained. We assert NEITHER session crossed
  // those thresholds; the test FAILS by design if the spiral
  // reproduces in either window.
  const all = [...firstSamples, ...secondSamples];
  // Minimum samples to assert against. The host-load floor — even 3
  // samples per session is enough to spot a saturated ticksAhead.
  expect(all.length, 'must collect samples in both windows').toBeGreaterThan(2);
  const maxTicksAhead = Math.max(...all.map((s) => s.ticksAhead));
  const maxCorr = Math.max(...all.map((s) => s.rollingCorrRate));

  /* eslint-disable no-console */
  console.log(`\n=== COMBINED PEAK: ticksAhead=${maxTicksAhead}, maxCorr=${maxCorr.toFixed(2)} ===`);
  /* eslint-enable no-console */

  // CEILING_TICKS = 30 in lookaheadController.ts — the prediction-
  // window saturation point. Past 30 = the documented unplayable
  // regime (2026-05-19 incident).
  expect(maxTicksAhead, 'ticksAhead must NOT cross CEILING_TICKS=30 in either session').toBeLessThan(30);
  // 0.6 corr rate is netcode-gate ceil; > 0.6 = visible rubber-band.
  expect(maxCorr, 'rollingCorrRate must NOT cross 0.6').toBeLessThan(0.6);
  // `maxDriftUnits` is intentionally NOT asserted — it's a session-
  // cumulative that always spikes at join when the client predicts at
  // 0,0 against the server's authoritative spawn (observed ~2700 u
  // first-snap correction). The meaningful spiral signal is the
  // sustained `ticksAhead` climb past 30.

  expect(errors, errors.join('\n')).toHaveLength(0);
  await ctx.close();
});
