import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Structures plan, Phase 3 — the grid, CLIENT half via the BUILD UI (single
 * placement). Placing the pre-built Capital instantly yields a powered grid with
 * a mineral bank, so the grid-power + minerals HUD readouts light up within a
 * snapshot — NO multi-second construction wait, and a SINGLE placement (the
 * place-ahead UI stacks/overlaps multiple placements, so multi-structure grids
 * are exercised by the scenario room in structure-scenario.spec.ts instead).
 *
 * Server grid maths is locked by tests/integration/sectorRoom/structure{Grid,
 * Construction}.test.ts.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout`);
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

test('Build ▸ Capital lights the grid-power + minerals HUD', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await expect(page.locator('[data-testid="grid-power"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="grid-minerals"]')).toHaveCount(0);

    // Open dial → Build ▸ → Capital → confirm.
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await page.locator('[data-testid="speed-dial-build"]').click();
    await page.locator('[data-testid="build-capital"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="placement-confirm"]').click();

    // Capital is pre-built + powered + has a starting bank.
    const power = page.locator('[data-testid="grid-power"]');
    await expect(power).toBeVisible({ timeout: 10_000 });
    expect(Number(await power.getAttribute('data-net-power'))).toBeGreaterThan(0);

    const minerals = page.locator('[data-testid="grid-minerals"]');
    await expect(minerals).toBeVisible({ timeout: 10_000 });
    expect(Number(await minerals.getAttribute('data-minerals'))).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
