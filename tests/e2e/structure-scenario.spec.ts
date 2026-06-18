import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Structures plan, Phase 3-5 — the full grid CLIENT-integration lock, via the
 * pre-built `structure-scenario-test` engineering room (a powered Capital + 2
 * Solar + a Miner next to an asteroid + a Turret next to a parked drone). Using
 * a baked scenario avoids the place-ahead UI overlap (stacked placements get
 * rejected) and the multi-second construction wait, so the E2E observes the
 * client-visible end states directly:
 *   - the pre-built grid SPAWNS on the client (Phase 3 slice → swarm mirror),
 *   - a clicked structure's OWNER reaches the inspector (Phase 4 slice → panel),
 *   - the parked drone DIES (Phase 5 turret fires → swarm count drops).
 *
 * Phase-1 issue 7 removed the whole-grid power/minerals HUD readout (per-
 * structure stats now live in-world + the selection inspector), so the former
 * "HUD lights up / climbs" assertions are gone; the mining→bank economy stays
 * locked by the integration + unit suites. The server maths is locked there;
 * this is the "the wire actually reaches the client" lock.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinScenario(browser: Browser): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  // worker=0 keeps rendering on the main thread; testId isolates the room.
  await page.goto(`${BASE_URL}?room=structure-scenario-test&worker=0&testId=${randomUUID()}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  return { ctx, page };
}

function swarmCount(page: Page): Promise<number> {
  return page.locator('[data-testid="swarm-count"]').textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
}

test('the pre-built scenario grid spawns on the client', async ({ browser }) => {
  // The slice → swarm-mirror wire path: the baked grid (Capital + 2 Solar +
  // Miner + Turret = 5 structures) plus the asteroid + parked drone reach the
  // client as swarm entities. (The whole-grid power HUD was removed in issue 7;
  // per-structure power now lives in the inspector, locked by the owner test
  // below + EntityStatsPanel.test.tsx.)
  const { ctx, page } = await joinScenario(browser);
  try {
    await page.waitForFunction(
      () => parseInt((document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0', 10) >= 6,
      undefined,
      { timeout: 12_000 },
    );
    expect(await swarmCount(page)).toBeGreaterThanOrEqual(6);
  } finally {
    await ctx.close();
  }
});

test("clicking another player's structure shows its OWNER in the inspector (not 'you')", async ({ browser }) => {
  // Other players' structures are a core part of the game — the inspector must
  // identify WHOSE base a clicked structure is. The scenario grid is owned by the
  // synthetic seed identity (NOT this freshly-joined player AND not a real DB
  // user), so the Capital reads as another player's base: the owner LABEL is
  // shown (the server-resolved display name, or "Unknown" for this orphaned
  // synthetic owner) and is NEVER "you". Locks the wire path: rebuildStructuresSlice
  // owner/ownerName → slice → mirror → EntityStatsPanel.
  const { ctx, page } = await joinScenario(browser);
  try {
    // Wait for the full scene (5 structures + asteroid + drone).
    await page.waitForFunction(
      () => parseInt((document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0', 10) >= 6,
      undefined,
      { timeout: 12_000 },
    );
    // Select the scenario Capital at world (0,0) — worker=0 makes the
    // deterministic __eqxSelectAtWorld hook available.
    await page.waitForFunction(
      () => {
        const sel = (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => string | null }).__eqxSelectAtWorld;
        return typeof sel === 'function' && sel(0, 0) !== null;
      },
      undefined,
      { timeout: 8_000 },
    );
    const panel = page.locator('[data-testid="entity-stats-panel"]');
    await expect(panel).toBeVisible({ timeout: 8_000 });
    const owner = page.locator('[data-testid="entity-stats-owner"]');
    await expect(owner).toBeVisible({ timeout: 8_000 });
    // It's ANOTHER player's base → an owner id is shown, never "you".
    await expect(owner).not.toHaveText(/you/i);
    expect(((await panel.getAttribute('data-structure-owner')) ?? '').length).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test('the turret destroys the parked drone (swarm count drops)', async ({ browser }) => {
  const { ctx, page } = await joinScenario(browser);
  try {
    // Wait for the full scene to populate (5 structures + 1 asteroid + 1 drone).
    await page.waitForFunction(
      () => parseInt((document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0', 10) >= 6,
      undefined,
      { timeout: 12_000 },
    );
    const peak = await swarmCount(page);
    // The turret kills the parked drone → count drops below the peak.
    await page.waitForFunction(
      (p) => parseInt((document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0', 10) < p,
      peak,
      { timeout: 15_000 },
    );
    expect(await swarmCount(page)).toBeLessThan(peak);
  } finally {
    await ctx.close();
  }
});
