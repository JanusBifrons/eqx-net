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
    await page.locator('[data-testid="build-cat-core"]').click();
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

test('no ghost↔structure gap after Confirm — the blueprint never vanishes (playtest 2026-06-10 Issue 7)', async ({
  browser,
}) => {
  // User report: "when you place a structure it just kinda vanishes then
  // appears after a second or two." The client used to clear the placement
  // ghost the instant Confirm sent place_structure, leaving a window where
  // NEITHER the ghost NOR the real structure was visible. The fix keeps a dim
  // "pending" ghost at the sent point until the structure lands.
  //
  // This samples EVERY animation frame from just before Confirm until the
  // structure appears and asserts there was never a frame with neither the
  // ghost (data-placement-world-x) nor the structure (swarm count grown). On
  // the pre-fix code the ghost clears immediately → ≥1 neither-frame → fails.
  const { ctx, page } = await joinClient(browser);
  try {
    const before = await swarmCount(page);

    await page.locator('[data-testid="speed-dial-fab"]').click();
    await page.locator('[data-testid="speed-dial-build"]').click();
    await page.locator('[data-testid="build-cat-core"]').click();
    await page.locator('[data-testid="build-capital"]').click();
    await expect(page.locator('[data-testid="placement-banner"]')).toBeVisible({ timeout: 5_000 });

    // Start a per-RAF sampler in page context BEFORE confirming.
    await page.evaluate((baseSwarm) => {
      const w = window as unknown as { __placeGap: { neither: number; total: number; appeared: boolean } };
      w.__placeGap = { neither: 0, total: 0, appeared: false };
      const surface = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
      const readSwarm = (): number =>
        parseInt(
          (document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0',
          10,
        );
      const loop = (): void => {
        const s = w.__placeGap;
        const ghost = surface?.dataset['placementWorldX'];
        const ghostPresent = ghost != null && ghost !== '';
        const structurePresent = readSwarm() > baseSwarm;
        if (structurePresent) s.appeared = true;
        if (!ghostPresent && !structurePresent) s.neither++;
        s.total++;
        // Sample for a bounded window after the structure appears, then stop.
        if (s.appeared && s.total > 4) return;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }, before);

    await page.locator('[data-testid="placement-confirm"]').click();

    // Wait for the structure to land (the sampler sets `appeared`).
    await page.waitForFunction(
      () => (window as unknown as { __placeGap: { appeared: boolean } }).__placeGap.appeared,
      undefined,
      { timeout: 5_000 },
    );

    const gap = await page.evaluate(
      () => (window as unknown as { __placeGap: { neither: number; total: number } }).__placeGap,
    );
    expect(gap.total, 'sampler should have run some frames').toBeGreaterThan(0);
    expect(
      gap.neither,
      `there were ${gap.neither}/${gap.total} frames with neither the placement ghost nor the structure visible (the vanish gap)`,
    ).toBe(0);
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
    await page.locator('[data-testid="build-cat-economy"]').click();
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
