import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

/**
 * Join-health guard — the real spawn flow a player drives: galaxy map landing →
 * pick a sector → Join → ship picker → Spawn → play for a few seconds, asserting
 * NO uncaught page error fires the whole time.
 *
 * Motivation: the smoke-test crash on sector join (capture
 * 2026-06-21T09-10-53Z-ypqf1a) — an Uncaught TypeError in `applyActivatedMounts`
 * (`null.length`) that broke the inbound snapshot loop — shipped through a full
 * green CI because NO E2E asserted on uncaught page errors across a live session.
 * The existing `spawn-select-flow` specs check `pageerror` only once, right after
 * the HUD mounts; this one HOLDS for a few seconds post-spawn so a crash that
 * recurs every snapshot frame (as that one did) is caught.
 *
 * Scope note (honesty): this is a general HYGIENE guard for the join flow, NOT
 * the reproduction of that specific `null`. That exact value only arises in a
 * live-sector state a fresh test sector doesn't recreate (the DB carries no null
 * `mounts`; a fresh galaxy sector emits `undefined`, which is null-safe). The
 * precise regression lock for the crash is the unit test
 * `snapshotRemoteSync.activatedMounts.test.ts` ("notepack undefined→null" / null
 * case). This guard catches the broader CLASS — any uncaught error in the
 * snapshot/render loop during a real spawn — going forward.
 */
test('real spawn flow: galaxy → pick sector → spawn → no uncaught error for 3s', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Galaxy map is the landing screen (Living Galaxy P5).
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

  // Drive a deterministic real-galaxy-sector pick via the DEV hook (the same
  // path a selector-layer tap feeds), then Join → Spawn the default ship.
  await page.waitForFunction(
    () => typeof (window as unknown as { __eqxGalaxyPick?: unknown }).__eqxGalaxyPick === 'function',
    null,
    { timeout: 8_000 },
  );
  await page.evaluate(() => {
    (window as unknown as { __eqxGalaxyPick?: (k: string) => void }).__eqxGalaxyPick?.('sol-prime');
  });
  await page.getByTestId('sector-drawer-join').click();
  await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('ship-picker-spawn').click();

  // HUD mounts only once the room is connected + welcomed + first snapshot applied.
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 20_000 });

  // Hold through ~60 snapshots (20 Hz). The crash this guards recurred every
  // frame, so any uncaught snapshot-loop error surfaces within this window.
  await page.waitForTimeout(3_000);

  // The snapshot loop must still be alive — ship-count stays populated (it would
  // be wiped / frozen if the inbound loop had thrown itself dead).
  const shipCount = await page.evaluate(() =>
    parseInt(
      document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0',
      10,
    ),
  );
  expect(shipCount).toBeGreaterThan(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
