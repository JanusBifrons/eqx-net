/**
 * Phase 6 sub-phase B — diegetic Temporal Anomaly surface.
 *
 * Joins the `swarm-tidi-burn` room (4000 entities + 12 ms synthetic tick burn,
 * defined in `src/server/index.ts`) and asserts that the MUI Alert banner reads
 * "Temporal Anomaly" and the HUD's clockRate falls below 0.99 within 15 s.
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/tidi-overlay.spec.ts
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test.describe('Phase 6 — Temporal Anomaly overlay', () => {
  test.setTimeout(45_000);

  test('TiDi engages: data-sector-alert reads "Temporal Anomaly" and clockRate < 0.99 within 15 s', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE_URL}?room=swarm-tidi-burn`);

      // Wait for first snapshot to populate the debug attributes.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="game-surface"]');
          return el && el.getAttribute('data-clock-rate') !== null;
        },
        { timeout: 15_000 },
      );

      // Within 15 s of joining the burn room, TiDi should engage.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="game-surface"]');
          if (!el) return false;
          const alert = el.getAttribute('data-sector-alert') ?? '';
          const rate = parseFloat(el.getAttribute('data-clock-rate') ?? '1');
          return alert === 'Temporal Anomaly' && rate < 0.99;
        },
        { timeout: 15_000 },
      );

      const finalRate = parseFloat(
        (await page.locator('[data-testid="game-surface"]').getAttribute('data-clock-rate')) ?? '1',
      );
      expect(finalRate).toBeLessThan(0.99);
    } finally {
      await ctx.close();
    }
  });
});
