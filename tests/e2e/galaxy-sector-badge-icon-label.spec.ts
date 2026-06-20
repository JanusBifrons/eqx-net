import { test, expect } from '@playwright/test';

/**
 * #16 — galaxy-map sector badges are ICON + ADJACENT LABEL, not a count knocked
 * out of a shape's centre. The badge ROW shows one small per-type icon (the
 * shared `entityVisuals` shape) with the count as a separate label beside it.
 *
 * Objective lock via the preserved `__eqxGalaxyBadgeCount(sectorKey)` hook (the
 * REAL count of drawn, VISIBLE badge segments for a sector) — no flaky pixel
 * screenshots: inject per-sector stats with 2 present types (hostiles + neutral
 * drones) and assert exactly 2 badges are drawn for that sector; also capture a
 * screenshot for visual sign-off of the icon+label look.
 *
 * `?worker=0` forces the MAIN-THREAD PixiRenderer — the `__eqxGalaxyBadgeCount`
 * and `__eqxSetGalaxyStats` hooks are DOM-path only.
 *
 * NOTE (orchestrator): WRITTEN-NOT-RUN in the worktree — E2E/dev-server are not
 * run here (parallel agents collide on ports). Runs in CI.
 *
 * FAIL on a regression that drops the badge row or breaks the hook: the count
 * would be 0 instead of 2.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface InjectedSectorStat {
  key: string;
  enemies: number;
  neutrals: number;
  players: number;
  structures: number;
  recentCombat?: number | null;
}

declare global {
  interface Window {
    __eqxGalaxyBadgeCount?: (k: string) => number;
    __eqxSetGalaxyStats?: (s: InjectedSectorStat[]) => void;
  }
}

test('sector badges render one icon+label per present type (#16)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });
  await page.waitForFunction(
    () =>
      typeof window.__eqxGalaxyBadgeCount === 'function' &&
      typeof window.__eqxSetGalaxyStats === 'function',
    null,
    { timeout: 6_000 },
  );
  await page.waitForTimeout(300);

  // Inject 2 present types for sol-prime: hostiles (★) + neutral drones (◆).
  await page.evaluate(() => {
    window.__eqxSetGalaxyStats!([
      { key: 'sol-prime', enemies: 3, neutrals: 12, players: 0, structures: 0, recentCombat: null },
    ]);
  });

  // Exactly 2 badges are drawn for sol-prime (one per present type).
  await expect
    .poll(() => page.evaluate(() => window.__eqxGalaxyBadgeCount!('sol-prime')), { timeout: 8_000 })
    .toBe(2);

  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-sector-badges/01-icon-label.png' });

  expect(errors, errors.join('\n')).toEqual([]);
});
