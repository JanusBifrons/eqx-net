import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * WS-D (#21) — always-on defensive RANGE circles for built turrets. The baked
 * `structure-scenario-test` room ships a built Turret (next to a parked drone),
 * so once the grid spawns on the client the ConnectorRenderer must draw a
 * persistent weapon-range circle for it. Observed via the main-thread DEV hook
 * `__eqxBuiltTurretRangeCount` (a RendererFeedback field would grow the per-frame
 * worker payload + is phase-gated; the unit lock
 * `ConnectorRenderer.turretRange.test.ts` is the primary regression guard — this
 * is the "the wire→render path actually draws it" lock). `?worker=0` so the hook
 * lands on the page window.
 *
 * NOTE (WS-D): WRITTEN but not run in this worktree (parallel agents collide on
 * ports 2567/5173). Run with `pnpm e2e --project=chromium
 * tests/e2e/structure-turret-range.spec.ts --reporter=line`.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('a built scenario turret draws a defensive range circle', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}?room=structure-scenario-test&worker=0&testId=${randomUUID()}`);
    // Wait for the join + the baked grid to spawn (Capital + 2 Solar + Miner +
    // Turret = 5 structures + asteroid + drone → swarm-count ≥ 6).
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="game-surface"]');
        if (!el || el.getAttribute('data-local-player-id') === '') return false;
        const sc = parseInt(
          (document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0',
          10,
        );
        return sc >= 6;
      },
      { timeout: 12_000 },
    );
    // The built Turret's range circle is drawn (count ≥ 1) within a few frames.
    await page.waitForFunction(
      () => ((globalThis as { __eqxBuiltTurretRangeCount?: number }).__eqxBuiltTurretRangeCount ?? 0) >= 1,
      undefined,
      { timeout: 8_000 },
    );
    const count = await page.evaluate(
      () => (globalThis as { __eqxBuiltTurretRangeCount?: number }).__eqxBuiltTurretRangeCount ?? 0,
    );
    expect(count).toBeGreaterThanOrEqual(1);
  } finally {
    await ctx.close();
  }
});
