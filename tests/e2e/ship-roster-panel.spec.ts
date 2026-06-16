import { test, expect, type Page } from '@playwright/test';

/**
 * Phase A coverage lock — ShipRosterPanel data flow.
 *
 * UNCOVERED PRIOR: `GalaxyTab.roster.test.tsx` mounts the panel in
 * isolation; `ShipRosterCard.test.tsx` (Phase A5) locks the per-card
 * contract. Neither exercises the real `/dev/player-ships` fetch loop +
 * Zustand singleton + card rendering against a live server.
 *
 * COVERS (Phase A4 of `humble-strolling-coral.md`):
 *   1. Fresh user (no eqxPlayerId in localStorage, no spawn yet) →
 *      navigate to galaxy-map-screen → panel mounts with
 *      data-roster-count="0".
 *   2. After spawning in sol-prime, the spawn flow assigns a playerId
 *      and creates a roster row. The drawer Galaxy tab's panel
 *      instance fetches /dev/player-ships and reflects count="1"
 *      plus exactly one `ship-roster-card-*` element.
 *
 * Excluded: 3-second polling refresh. Too timing-sensitive for E2E;
 * the fetch is exercised at unit level via the panel's own roster.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForLocalShip(page: Page, timeoutMs = 20_000): Promise<void> {
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: timeoutMs },
  );
}

test('galaxy-map-screen no longer embeds the floating roster panel (Equinox Phase 7 / Item 4)', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Living Galaxy P5 — the galaxy map is the landing screen on load (no meta CTA).
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

  // Equinox Phase 7 (Item 4) — the floating top-bar roster panel was REMOVED;
  // the per-sector popover's "your ships" sub-list replaces it (the roster is
  // still polled for the popover + RosterCountBadge, just not shown as a panel
  // here). The drawer Galaxy-tab panel remains — see the next test.
  await expect(
    page.locator('[data-testid="galaxy-map-screen"] [data-testid="ship-roster-panel"]'),
  ).toHaveCount(0);
});

test('after spawning in sol-prime, the drawer Galaxy tab panel shows the new ship', async ({ page }) => {
  test.setTimeout(60_000);
  // Spawn via URL escape — the welcome cycle persists eqxPlayerId AND
  // the spawn flow calls bindRosterRow → store.create.
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await waitForLocalShip(page);

  // Verify the server-side row exists. If this fails, the regression
  // is in A3's spawn → bindRosterRow path; the E2E surface is fine.
  const rosterCount = await page.evaluate(async () => {
    const pid = window.localStorage.getItem('eqxPlayerId') ?? '';
    if (pid === '') return -1;
    const res = await fetch(`/dev/player-ships?playerId=${encodeURIComponent(pid)}`);
    if (!res.ok) return -2;
    const body = (await res.json()) as { ships?: unknown[] };
    return Array.isArray(body.ships) ? body.ships.length : -3;
  });
  expect(rosterCount, 'server-side row should exist after spawn').toBe(1);

  // Open the drawer's Galaxy tab (default tab). The ShipRosterPanel
  // mounts there, fetches via the Zustand singleton, and surfaces
  // data-roster-count.
  await page.locator('[data-testid="drawer-toggle"]').click();
  const drawerPanel = page.locator('[data-testid="ship-roster-panel"]').first();
  await expect(drawerPanel).toBeVisible({ timeout: 10_000 });
  await expect(drawerPanel).toHaveAttribute('data-roster-count', '1', { timeout: 7_000 });
  await expect(page.locator('[data-testid^="ship-roster-card-"]').first()).toBeVisible({
    timeout: 5_000,
  });
});
