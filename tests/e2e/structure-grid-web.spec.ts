import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Structures plan, Phase 3 — the grid, CLIENT half via the BUILD UI (single
 * placement). Placing the pre-built Capital instantly yields a structure swarm
 * entity, so the Build ▸ Capital ▸ confirm flow is observable within a snapshot
 * (the place-ahead UI stacks/overlaps multiple placements, so multi-structure
 * grids are exercised by the scenario room in structure-scenario.spec.ts).
 *
 * Phase-1 issue 7 removed the ambiguous whole-grid power/minerals HUD readout;
 * per-structure stats now live in-world (capital minerals + battery charge Pixi
 * Text) + the selection inspector. So this spec asserts the structure SPAWNS
 * (swarm count) rather than a HUD readout. Server grid maths is locked by
 * tests/integration/sectorRoom/structure{Grid,Construction}.test.ts.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

async function joinClient(browser: Browser): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  // These tests join as a touch device (the two-step tap → Place flow); the
  // left strip's placing tools show on desktop too (U3-7).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    }, undefined,
    { timeout: 12_000 },
  );
  await page.locator('[data-testid="right-rail"]').waitFor({ timeout: 10_000 });
  return { ctx, page };
}

const swarmCount = (page: Page): Promise<number> =>
  page.locator('[data-testid="swarm-count"]').textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));

test('Build ▸ Capital places a structure', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    // test-sector-fast has no drones/asteroids → the swarm starts empty.
    expect(await swarmCount(page)).toBe(0);

    // Build mode (sidebar) → Core on the rail → Capital tile → confirm.
    // Build mode is the only way to build (owner 2026-11-22): the switch enters it.
    await page.locator('[data-testid="build-toggle"]').click();
    await page.locator('[data-testid="right-rail-build"]').click(); // no auto-open: the rail's Build item opens the panel
    await page.locator('[data-testid="build-cat-core"]').click();
    await page.locator('[data-testid="build-capital"] button').click();
    await expect(page.locator('[data-testid="placement-kind"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="placement-confirm"]').click();
    // Plan then Build (#1385): Place only plans; the Build hex sends it.
    await page.locator('[data-testid="placement-build"]').click();

    // The placed Capital appears as a kind-2 swarm entity within a snapshot.
    await page.waitForFunction(
      () => parseInt((document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0', 10) >= 1,
      undefined,
      { timeout: 10_000 },
    );
    expect(await swarmCount(page)).toBeGreaterThanOrEqual(1);
  } finally {
    await ctx.close();
  }
});
