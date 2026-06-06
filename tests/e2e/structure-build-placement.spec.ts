import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * Structures plan, Phase 2 — Build → place flow (CLIENT half) regression lock.
 *
 * The speed-dial "Build ▸" sub-menu lets the player pick a structure kind,
 * which raises the placement confirm banner; confirming sends `place_structure`
 * (a drop a fixed clearance ahead of the ship — the Phase 2 fallback coordinate
 * model). The new structure then rides the existing kind=2 swarm path and shows
 * up in the client's swarm mirror (`data-swarm-count`).
 *
 * The server half (validation, blueprint vs pre-built, damage/destroy) is locked
 * by tests/integration/sectorRoom/structureEntity.test.ts; the placement
 * geometry by src/client/structures/structurePlacementClient.test.ts. This spec
 * is the end-to-end UI → wire → mirror lock.
 *
 * Boot uses the controlled `test-sector-fast` engineering room (no drones) so
 * the swarm count starts at a stable baseline.
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

function swarmCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid="swarm-count"]')
    .textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
}

test('Build ▸ Capital → confirm places a structure that appears in the swarm mirror', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const before = await swarmCount(page);

    // Open the dial → enter the Build sub-menu → pick Capital.
    await page.locator('[data-testid="speed-dial-fab"]').click();
    await page.locator('[data-testid="speed-dial-build"]').click();
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // The placement confirm banner appears; confirm sends place_structure.
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="placement-confirm"]').click();

    // The structure rides the kind=2 swarm path → swarm count climbs by ≥ 1.
    await page.waitForFunction(
      (b) => {
        const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
        return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
      },
      before,
      { timeout: 10_000 },
    );
    expect(await swarmCount(page)).toBeGreaterThan(before);

    // Banner dismisses after confirm.
    await expect(page.locator('[data-testid="placement-banner"]')).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test('placement Cancel exits placement mode without placing', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    const before = await swarmCount(page);

    await page.locator('[data-testid="speed-dial-fab"]').click();
    await page.locator('[data-testid="speed-dial-build"]').click();
    await page.locator('[data-testid="build-solar"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="placement-cancel"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeHidden();

    // Give it a moment; nothing should have been placed.
    await page.waitForTimeout(500);
    expect(await swarmCount(page)).toBe(before);
  } finally {
    await ctx.close();
  }
});
