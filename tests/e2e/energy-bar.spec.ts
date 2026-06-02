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

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser, shipKind = 'scout') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // testTimeScale=10 compresses fire/regen cadence to a second or two.
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=${shipKind}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12000 },
  );
  return { ctx, page };
}

async function energyPct(page: Page): Promise<number> {
  const v = await page.locator('[data-testid="energy-bar"]').getAttribute('data-energy-pct');
  return parseInt(v ?? '100', 10);
}

test('energy bar is visible and full on spawn', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await expect(page.locator('[data-testid="energy-bar"]')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(400);
    expect(await energyPct(page)).toBeGreaterThan(80);
  } finally {
    await ctx.close();
  }
});

test('sustained fire drains the pool, then it recovers when firing stops', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await page.waitForTimeout(400);
    const before = await energyPct(page);

    // Hold fire long enough (testTimeScale=10) to draw the pool down.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => parseInt(document.querySelector('[data-testid="energy-bar"]')?.getAttribute('data-energy-pct') ?? '100', 10) < 60,
      { timeout: 8000 },
    );
    await page.keyboard.up('Space');
    const drained = await energyPct(page);
    expect(drained).toBeLessThan(before);

    // Stop firing → steady regen brings it back up.
    await page.waitForFunction(
      (low: number) => parseInt(document.querySelector('[data-testid="energy-bar"]')?.getAttribute('data-energy-pct') ?? '0', 10) > low + 10,
      drained,
      { timeout: 8000 },
    );
    expect(await energyPct(page)).toBeGreaterThan(drained);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
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
      (b: number) => parseInt(document.querySelector('[data-testid="energy-bar"]')?.getAttribute('data-energy-pct') ?? '100', 10) < b - 10,
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
