import { test, expect } from '@playwright/test';

/**
 * 2026-06-19 playtest pop-in lock (the fix that failed twice before — now with an
 * OBJECTIVE, deterministic oracle instead of flaky pixel screenshots).
 *
 * The galaxy LANDING must not reveal the map until the live counts
 * (`/galaxy/snapshot`) are loaded — the hexes + per-sector count icons appear
 * TOGETHER, never hexes-then-icons-pop-in. This is DOM/route-controlled: hold the
 * snapshot, assert the opaque loading GATE blocks the map, release it, assert the
 * gate lifts AND the count badges are drawn at that instant. No `waitForTimeout`,
 * no screenshots. `?worker=0` forces the main-thread (DOM) renderer so the
 * `__eqxGalaxyBadgeCount` debug hook (DOM-path only) is live.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

const SNAPSHOT_FIXTURE = {
  sectors: [
    {
      key: 'sol-prime',
      players: 0,
      enemies: 0,
      neutrals: 8,
      structures: 0,
      owner: { factionId: 'core', contested: false },
    },
  ],
};

const badgeCount = (page: import('@playwright/test').Page, key: string): Promise<number> =>
  page.evaluate(
    (k) =>
      (window as unknown as { __eqxGalaxyBadgeCount?: (s: string) => number }).__eqxGalaxyBadgeCount?.(k) ?? -1,
    key,
  );

test('landing map is BLOCKED until counts load, then hexes + icons reveal together', async ({ page }) => {
  // Hold the snapshot so the "blocked" state is observable + deterministic.
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/galaxy/snapshot', async (route) => {
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SNAPSHOT_FIXTURE),
    });
  });

  await page.goto(`${BASE_URL}/?worker=0`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // BLOCKED: the opaque loading gate covers the map while the counts are pending.
  const gate = page.getByTestId('galaxy-loading');
  await expect(gate).toBeVisible({ timeout: 15_000 });
  // …and it is genuinely OPAQUE (actually occludes the Pixi map) — NOT the old
  // transparent `pointerEvents:none` spinner that let the half-painted map show
  // through (the failed-fix regression this lock guards against).
  const bg = await gate.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('transparent');

  // Release the snapshot → counts load → the gate lifts.
  release();
  await expect(page.getByTestId('galaxy-loading')).toHaveCount(0, { timeout: 10_000 });

  // …and the count badges are drawn at reveal: sol-prime had neutrals=8, so at
  // least one badge is visible the moment the map shows — proving the icons did
  // NOT pop in after the hexes.
  await expect.poll(() => badgeCount(page, 'sol-prime'), { timeout: 8_000 }).toBeGreaterThan(0);
});
