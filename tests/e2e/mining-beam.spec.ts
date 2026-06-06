import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Structures plan, Phase 4 — mining, CLIENT half (UI → wire → HUD).
 *
 * Two assertions, both designed to be FAST (test-harness philosophy — bespoke
 * trigger, not a bumped timeout):
 *   1. Placing a Capital instantly shows the mineral readout (the Capital is
 *      born with a starting bank) — proves the `minerals` wire→HUD path with no
 *      construction wait.
 *   2. With `?structureGridPulseMs=50` (the testMode bespoke trigger that
 *      fast-forwards the wall-clock grid pulse — `testTimeScale` can't, it's
 *      physics-tick-only), building a Solar + Miner near the default-room
 *      asteroids makes the bank GROW past its starting value (mining → haul →
 *      bank, end-to-end through the client).
 *
 * The mining maths is locked by tests/integration/sectorRoom/structureMining.
 * test.ts; this is the end-to-end lock that minerals reach the client HUD.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser, query = ''): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout${query}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  await page.locator('[data-testid="speed-dial-fab"]').waitFor({ timeout: 10_000 });
  return { ctx, page };
}

async function build(page: Page, kind: string): Promise<void> {
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  await page.locator(`[data-testid="build-${kind}"]`).click();
  await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-testid="placement-confirm"]').click();
}

function minerals(page: Page): Promise<number> {
  return page.locator('[data-testid="grid-minerals"]').getAttribute('data-minerals').then((v) => Number(v ?? 0));
}

test('placing a Capital shows the mineral bank in the HUD', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await expect(page.locator('[data-testid="grid-minerals"]')).toHaveCount(0);
    await build(page, 'capital');
    await expect(page.locator('[data-testid="grid-minerals"]')).toBeVisible({ timeout: 10_000 });
    expect(await minerals(page)).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test('a powered miner grows the mineral bank (fast-pulse)', async ({ browser }) => {
  // 50 ms pulse so construction + mining resolve in a couple of seconds.
  const { ctx, page } = await joinClient(browser, '&structureGridPulseMs=50');
  try {
    await build(page, 'capital');
    await expect(page.locator('[data-testid="grid-minerals"]')).toBeVisible({ timeout: 10_000 });
    // Solar offsets the miner's power draw; miner near the capital + the
    // default-room asteroids.
    await build(page, 'solar');
    await build(page, 'miner');

    // After construction the miner mines + hauls → bank climbs ABOVE the
    // post-construction dip. Wait for net growth past the starting bank.
    const start = await minerals(page);
    await page.waitForFunction(
      (s) => {
        const v = document.querySelector('[data-testid="grid-minerals"]')?.getAttribute('data-minerals');
        return Number(v ?? 0) > s;
      },
      start,
      { timeout: 25_000 },
    );
    expect(await minerals(page)).toBeGreaterThan(start);
  } finally {
    await ctx.close();
  }
});
