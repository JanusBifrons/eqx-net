/**
 * Energy bar E2E suite (weapons/energy/AI overhaul §3 + §5.1).
 *
 * Asserts the top-center energy readout reflects the predicted/authoritative
 * pool:
 *   1. `data-energy-pct` starts full (≈100) and DROPS under sustained fire.
 *   2. It RECOVERS (regen) once firing stops.
 *   3. Boosting drains it.
 *
 * The bar is driven by `ColyseusClient.getPredictedEnergy()` (RAF + direct
 * DOM) and reconciled from the per-recipient snapshot `states[id].energy`.
 * The deterministic energy math is unit-locked in
 * src/core/combat/Energy.test.ts.
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/energy-bar.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchTestClient } from './helpers/gameScenario';
import { lockOn, toManual } from './helpers/fireControl';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// The join waits for the loading curtain (infrastructural: art + spawn
// handshake, up to ~16 s under suite load), so the default 30 s is too tight.
test.describe.configure({ timeout: 90_000 });

async function joinClient(browser: Browser, shipKind = 'scout', room = 'test-sector-fast') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=${room}&shipKind=${shipKind}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    }, undefined,
    { timeout: 12000 },
  );
  // The HUD (and the bar) mount when the loading curtain lifts; under suite
  // load that can take well over 5 s.
  await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: 60_000 });
  return { ctx, page };
}

async function energyPct(page: Page): Promise<number> {
  const v = await page.locator('[data-testid="hud-energy"]').getAttribute('data-energy-pct');
  return parseInt(v ?? '100', 10);
}

/**
 * Bug (perf-plan test audit, 2026-11-06): when the curtain lifted the bar
 * started EMPTY and climbed (0 → 2 → 9 → 14 %) for ~2.5 s, then jumped to
 * full. The server spawns ships full, but only sends the own-ship energy once
 * the ship goes active (a beat after the curtain); the client's predicted pool
 * started at 0 and regenerated locally until then. Read the bar the moment it
 * appears: it must already be full.
 */
test('energy bar is visible and full on spawn', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await expect(page.locator('[data-testid="hud-energy"]')).toBeVisible({ timeout: 5000 });
    expect(await energyPct(page), 'the bar must be full the moment it appears').toBeGreaterThan(80);
  } finally {
    await ctx.close();
  }
});

test('sustained fire drains the pool, then it recovers when firing stops', async ({ browser }) => {
  // Interceptor in the REAL-TIME `test-sector` (2026-11-08 fix). The old scout
  // in `test-sector-fast` could never drain: testTimeScale=10 runs the server's
  // per-tick regen 10× faster (scout 0.2/tick → 120/s) while fire stays at the
  // client's wall-clock 6 Hz (2 × 6 = 12/s), so the snapshot re-filled the bar
  // to 97–100 % under held fire. (Even at 1× a scout's bolts only break even:
  // 12/s drain vs 12/s regen.) The interceptor's beam drains 5 × 6 = 30/s
  // against 0.4 × 60 = 24/s regen — a net −6/s, so −15 % of 180 takes ~4.5 s.
  //
  // Lock-to-fire (2026-11-09): there is no free fire any more, so the beam
  // needs a locked target for the whole drain window. A second pilot parked
  // 150 u dead ahead with a huge hull is that target (a drone would die
  // before the pool drains); the shooter locks it with `instantLock` and
  // holds Space on its MAN group.
  const testId = randomUUID();
  const [{ ctx, page }, victim] = await Promise.all([
    launchTestClient(browser, { spawnX: 0, spawnY: 0, initialAngle: 0, shipKind: 'interceptor', testId, instantLock: true }),
    launchTestClient(browser, { spawnX: 0, spawnY: 150, shipKind: 'fighter', testId, initialHull: 100_000 }),
  ]);
  try {
    const victimId = (await victim.page.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id')) ?? '';
    await toManual(page);
    await lockOn(page, { kind: 'ship', playerId: victimId });
    const before = await energyPct(page);

    // Hold fire long enough to draw the pool down.
    await page.keyboard.down('Space');
    // Relative to the start: this used to wait for "< 60 %", which only held
    // because the pool wrongly started near-empty (fixed alongside). And pass
    // the start value as the arg: `waitForFunction(fn, { timeout })` treats the object
    // as the ARGUMENT, so the 8 s deadline never applied.
    await page.waitForFunction(
      (b: number) => parseInt(document.querySelector('[data-testid="hud-energy"]')?.getAttribute('data-energy-pct') ?? '100', 10) < b - 15,
      before,
      { timeout: 8000 },
    );
    await page.keyboard.up('Space');
    const drained = await energyPct(page);
    expect(drained).toBeLessThan(before);

    // Stop firing → steady regen brings it back up.
    await page.waitForFunction(
      (low: number) => parseInt(document.querySelector('[data-testid="hud-energy"]')?.getAttribute('data-energy-pct') ?? '0', 10) > low + 10,
      drained,
      { timeout: 8000 },
    );
    expect(await energyPct(page)).toBeGreaterThan(drained);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await Promise.all([ctx.close(), victim.ctx.close()]);
  }
});

test('boosting drains the energy pool', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await page.waitForTimeout(400);
    const before = await energyPct(page);
    // Thrust + boost (Shift) — boost drains only while thrusting.
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ShiftLeft');
    await page.waitForFunction(
      (b: number) => parseInt(document.querySelector('[data-testid="hud-energy"]')?.getAttribute('data-energy-pct') ?? '100', 10) < b - 10,
      before,
      { timeout: 8000 },
    );
    expect(await energyPct(page)).toBeLessThan(before);
  } finally {
    await page.keyboard.up('ShiftLeft').catch(() => undefined);
    await page.keyboard.up('ArrowUp').catch(() => undefined);
    await ctx.close();
  }
});
