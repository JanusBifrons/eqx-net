/**
 * Phase 3a-3 — input-throttle state-change drift lock
 * (plan: e2e-rebuild, master plan i-want-you-to-lively-tulip.md)
 *
 * Per-surface deterministic lock for the bug class documented in
 * `src/client/CLAUDE.md` → "Input Throttling Discipline (2026-05-06)":
 *
 *   "On a fast-moving ship this surfaces as a ~8 unit drift per
 *    state-change event, with `corr` rate sticking around 20–30 %."
 *
 * What this catches:
 *   - Worker FIFO input queue regressing to overwrite-latest.
 *   - The client throttling **held** input states (rule: throttling
 *     is only safe when BOTH current and previously-sent inputs are
 *     fully idle; held thrust must be re-sent every tick).
 *   - Any regression that causes the server's synthesised-ack
 *     max-tick-clamp to jump ahead of physics steps the client's
 *     prediction did apply.
 *
 * The existing `sync-health.spec.ts` measures steady-state drift
 * during continuous thrust (3 s W-hold). What's NEW here is the
 * **rapid state-change** scenario — exactly the pattern the buggy
 * throttling silently dropped. 8 pulses in 1.6 s exercises the
 * worst case for the queue contract.
 *
 * Deterministic environment: `?room=test-sector` (testMode, no
 * drones, no asteroids) — `filterBy(['testId'])` isolates this
 * spec's room from any concurrent spec. Real-time (NOT
 * `test-sector-fast`) because drift measurement is wall-clock
 * anchored: the worker FIFO and the snapshot cadence are
 * unaffected by `testTimeScale`.
 *
 * `?diag=0` forces the production code path (Playwright's
 * `navigator.webdriver=true` would otherwise auto-enable diag —
 * Phase 0a override). The lock should measure code players run.
 *
 * Run with:
 *   pnpm e2e --project=feature tests/e2e/input-throttle-drift.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { PredictionStats } from '../../src/client/net/ColyseusClient';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function getPredStats(page: Page): Promise<PredictionStats> {
  return page.evaluate(() => {
    const raw = document
      .querySelector('[data-testid="game-surface"]')
      ?.getAttribute('data-pred-stats');
    return JSON.parse(raw ?? '{}') as PredictionStats;
  });
}

test('input-throttle state-change drift: 8 rapid W pulses keep drift bounded', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    // Per-test isolated room (no cross-test pollution) + diag forced
    // OFF so the production code path is what's measured.
    const testId = randomUUID();
    await page.goto(
      `${BASE_URL}/?room=test-sector&testId=${testId}&diag=0`,
    );

    // Wait until the game phase is active and at least one ship is
    // in the mirror — the same ship-count gate launchTestClient uses
    // and that 40+ specs rely on. data-pred-stats and friends are
    // only populated once the rAF loop is writing the dataset, which
    // happens after GameSurface mounts AND ships.size > 0.
    await page.waitForFunction(
      () =>
        parseInt(
          document
            .querySelector('[data-testid="ship-count"]')
            ?.textContent?.replace('Ships: ', '') ?? '0',
          10,
        ) > 0,
      { timeout: 12_000 },
    );

    // Diag MUST be off — Phase 0a kill-switch verification.
    const diagEnabled = await page.evaluate(
      () => (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled,
    );
    expect(diagEnabled, '?diag=0 must force diag off (Phase 0a override)').toBe(false);

    // Let connection + reconciler stabilise. 1.5 s is enough for the
    // welford RTT mean to settle past the cold-start first sample
    // (which can be hundreds of ms on a fresh server boot) and for
    // the spawn-period correction to land outside the measurement
    // window — so the all-time `maxDriftUnits` baseline before the
    // pulses reflects steady state.
    await page.waitForTimeout(1500);

    const statsBefore = await getPredStats(page);

    // 8 rapid throttle pulses: W down 100 ms, W up 100 ms each.
    // Total window ≈ 1.6 s wall-clock = ~32 snapshots @ 20 Hz.
    // Each W down/up is a control-bit state change — exactly the
    // event the broken throttling rule silently dropped.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('w');
      await page.waitForTimeout(100);
      await page.keyboard.up('w');
      await page.waitForTimeout(100);
    }

    // Allow the final snapshots after the last state change to land.
    await page.waitForTimeout(300);

    const statsAfter = await getPredStats(page);

    // Window-deltas — the input-throttle bug class is local to the
    // pulse window, so we measure what changed during it, not the
    // all-time monotonic stats (the join-period spawn correction
    // pre-populates `maxDriftUnits` to tens of units before we even
    // start, which is unrelated to the throttling contract this
    // spec locks).
    const deltaSnaps = statsAfter.snapshotCount - statsBefore.snapshotCount;
    const deltaCorrections =
      statsAfter.significantCorrectionCount - statsBefore.significantCorrectionCount;
    const deltaTotalDrift =
      statsAfter.totalDriftUnits - statsBefore.totalDriftUnits;
    const corrRate = deltaSnaps > 0 ? deltaCorrections / deltaSnaps : 1;
    const meanDriftDuringWindow = deltaSnaps > 0 ? deltaTotalDrift / deltaSnaps : 0;
    // If a new max landed during the window, the all-time max grew —
    // that's the worst single-snapshot drift in the window. Otherwise
    // the worst single-event drift in the window was ≤ the pre-existing
    // max (which lives outside this spec's contract).
    const maxNewDriftInWindow = Math.max(
      0,
      statsAfter.maxDriftUnits - statsBefore.maxDriftUnits,
    );

    console.log('\n=== Input-throttle state-change drift ===');
    console.log(`Snapshots (window):       ${deltaSnaps}`);
    console.log(`Corrections (window):     ${deltaCorrections}  (${(corrRate * 100).toFixed(1)}%)`);
    console.log(`Mean drift (window):      ${meanDriftDuringWindow.toFixed(4)} u`);
    console.log(`New max drift (window):   ${maxNewDriftInWindow.toFixed(4)} u`);
    console.log(`Ticks ahead (current):    ${statsAfter.ticksAhead}`);
    console.log(`RTT (current):            ${statsAfter.rttMs} ms`);
    console.log('=========================================\n');

    // Liveness preconditions — distinct from the regression assertions
    // below so a "didn't even run" failure can't masquerade as healthy.
    expect(deltaSnaps, 'window must contain enough snapshots to mean anything')
      .toBeGreaterThan(15);

    // Mean drift during the window. Healthy localhost: ~0.0001 u
    // (float-noise). Documented regression mode: ~8 u per state-change
    // event averaged across 32 snapshots in the window = ~2 u mean.
    // 1.5 u catches the regression at ~10× the noise floor with
    // ample margin for harmless variance.
    expect(
      meanDriftDuringWindow,
      'Mean drift during rapid input transitions should stay near ' +
        'zero. Regression to throttling-held-state or overwrite-latest ' +
        'queue pushes mean drift to ~2 u during the window.',
    ).toBeLessThan(1.5);

    // Worst single new-max drift during the window. Healthy: ~0 u
    // (no new max). Regression mode: each dropped state-change
    // produces an ~8 u single-snapshot drift, which becomes the new
    // all-time max. 5 u catches the first dropped state-change with
    // margin below the netHealthBudget catastrophic ceiling (12 u).
    expect(
      maxNewDriftInWindow,
      'No single new maximum-drift event should occur during the ' +
        'rapid-input window; regression spikes this to ~8 u per dropped ' +
        'state-change.',
    ).toBeLessThan(5.0);

    // Correction rate ceiling. Documented regression mode: 20-30 %.
    // Healthy: 0-10 %. 18 % catches the 20-30 % band squarely with
    // slack for host-load variance.
    expect(
      corrRate,
      'Correction rate during rapid input transitions should stay ' +
        'bounded; regression to overwrite-latest queue spikes this to ~25 %.',
    ).toBeLessThan(0.18);

    // `ticksAhead` is deliberately print-only here. It is dominated by
    // network RTT (input-clock lookahead, not the throttling contract
    // this spec locks). The Phase-1 netcode-health gate exercises it
    // under an injected mobile profile with both relative AND absolute
    // budgets; asserting on it here as a fixed ceiling would conflate
    // host-load variance with the bug class this lock catches.
  } finally {
    await page.keyboard.up('w').catch(() => undefined);
    await ctx.close();
  }
});
