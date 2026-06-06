import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Structures plan, Phase 3 — the grid, CLIENT half (UI → wire → mirror → HUD).
 *
 * Placing the pre-built Capital instantly yields a powered grid (the Capital is
 * born built + is its own powered component), so the `grid-power` HUD readout
 * shows positive net power within a snapshot or two — NO multi-second
 * construction wait (which would violate the test-harness philosophy). Adding a
 * Connector in range auto-links it (the web edge appears in the structures
 * slice) and raises the swarm count.
 *
 * The server-side grid maths (construction flow, dead-end, repair, power
 * aggregation) is locked by tests/integration/sectorRoom/structure{Grid,
 * Construction}.test.ts; the connector visuals by
 * src/client/render/pixi/connectorVisual.test.ts. This is the end-to-end lock
 * that the slice + grid_pulse actually reach the client.
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

async function build(page: Page, kind: string): Promise<void> {
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  await page.locator(`[data-testid="build-${kind}"]`).click();
  await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-testid="placement-confirm"]').click();
}

test('placing a Capital lights the grid-power HUD with positive net power', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    // No grid yet → readout hidden.
    await expect(page.locator('[data-testid="grid-power"]')).toHaveCount(0);

    await build(page, 'capital');

    // The Capital is pre-built + powered → readout appears with net power > 0.
    const readout = page.locator('[data-testid="grid-power"]');
    await expect(readout).toBeVisible({ timeout: 10_000 });
    const net = await readout.getAttribute('data-net-power');
    expect(Number(net)).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test('a Connector placed near the Capital joins the web (swarm count climbs)', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const swarmCount = (): Promise<number> =>
      page.locator('[data-testid="swarm-count"]').textContent()
        .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));

    await build(page, 'capital');
    await expect(page.locator('[data-testid="grid-power"]')).toBeVisible({ timeout: 10_000 });
    const before = await swarmCount();

    await build(page, 'connector');
    await page.waitForFunction(
      (b) => {
        const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
        return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
      },
      before,
      { timeout: 10_000 },
    );
    expect(await swarmCount()).toBeGreaterThan(before);
  } finally {
    await ctx.close();
  }
});
