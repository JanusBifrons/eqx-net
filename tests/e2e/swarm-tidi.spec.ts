/**
 * Phase 6 sub-phase C — full TiDi + LoadShedder acceptance gate.
 *
 * Joins the `swarm-tidi-burn` room (4000 entities + 12 ms synthetic tick burn)
 * and asserts the safety-valve sequence:
 *   Stage 1 (≤ 15 s): TiDi engages — clockRate < 0.99, alert reads "Temporal Anomaly".
 *   Stage 2 (≤ 30 s): clockRate ramps to floor (≤ 0.71).
 *   Stage 3 (≤ 60 s): LoadShedder fires — swarm size visibly drops.
 *   Stage 4: ship remains controllable throughout (a w-keypress moves it).
 *
 * Recovery (rate climbing back to 1.0) is intentionally NOT asserted here:
 * `tickBurnMs=12` is permanent for the room, so the budget stays overrun.
 * Recovery is verified manually by flipping `tickBurnMs` to 0 in the
 * server config (see plan §Risks for rationale).
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/swarm-tidi.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

const surface = (page: Page) => page.locator('[data-testid="game-surface"]');

async function readClockRate(page: Page): Promise<number> {
  const v = await surface(page).getAttribute('data-clock-rate');
  return parseFloat(v ?? '1');
}

async function readSwarmSize(page: Page): Promise<number> {
  const v = await surface(page).getAttribute('data-swarm-size');
  return parseInt(v ?? '0', 10);
}

async function readShipX(page: Page): Promise<number> {
  return parseFloat((await surface(page).getAttribute('data-ship-x')) ?? '0');
}

async function readShipY(page: Page): Promise<number> {
  return parseFloat((await surface(page).getAttribute('data-ship-y')) ?? '0');
}

test.describe('Phase 6 — TiDi + LoadShedder acceptance', () => {
  test.setTimeout(180_000);

  test('engage → floor → shed → ship remains controllable', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}?room=swarm-tidi-burn`);

      // Wait for the first snapshot so debug attrs are populated.
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-clock-rate') !== null,
        { timeout: 20_000 },
      );

      // Stage 1 — TiDi engages within 15 s.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="game-surface"]');
          if (!el) return false;
          const r = parseFloat(el.getAttribute('data-clock-rate') ?? '1');
          const a = el.getAttribute('data-sector-alert') ?? '';
          return r < 0.99 && a === 'Temporal Anomaly';
        },
        { timeout: 15_000 },
      );

      // Stage 2 — rate reaches floor within a further 30 s.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="game-surface"]');
          const r = parseFloat(el?.getAttribute('data-clock-rate') ?? '1');
          return r <= 0.71;
        },
        { timeout: 30_000 },
      );

      // Stage 3 — shedder fires: swarm size drops materially within 60 s.
      // The `swarm-tidi-burn` room seeds 500 entities (80% asteroids / 20%
      // drones = 100 drones eligible for shed). Batch is min(8, ceil(100*0.10))
      // = 8 per tick when conditions hold, but fluctuates as the budget
      // dances around the threshold. Wait for any non-trivial drop.
      const startSwarm = await readSwarmSize(page);
      expect(startSwarm).toBeGreaterThan(400); // sanity: bulk seed delivered
      await page.waitForFunction(
        (start: number) => {
          const el = document.querySelector('[data-testid="game-surface"]');
          const sz = parseInt(el?.getAttribute('data-swarm-size') ?? '0', 10);
          // 16 evictions = ~2 shed-eligible ticks. Below "shedding observed"
          // bar but above noise.
          return sz < start - 16;
        },
        startSwarm,
        { timeout: 60_000 },
      );

      // Stage 4 — ship remains controllable. Press 'w' for a brief moment and
      // assert the local ship position changed by a non-trivial epsilon.
      const x0 = await readShipX(page);
      const y0 = await readShipY(page);
      await page.keyboard.down('w');
      await page.waitForTimeout(800);
      await page.keyboard.up('w');
      const x1 = await readShipX(page);
      const y1 = await readShipY(page);
      const moved = Math.hypot(x1 - x0, y1 - y0);
      expect(moved).toBeGreaterThan(2);

      // Final assertion: rate is still pinned at floor (the burn is still on).
      expect(await readClockRate(page)).toBeLessThanOrEqual(0.72);
    } finally {
      await ctx.close();
    }
  });
});
