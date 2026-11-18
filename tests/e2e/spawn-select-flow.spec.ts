import { test, expect } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Regression: clicking a sector on the spawn-select Galaxy Overview screen
 * (post-auth, mode='spawn') must transition into the gameplay phase and
 * mount the in-game HUD. Symptom of the bug: the screen goes black after
 * sector selection — gameplay never mounts.
 *
 * The first test opens the dev test-sector by direct link (`?room=`; the
 * homepage has no dev buttons), so it locks the phase transition and
 * GameSurface bootstrap without canvas interaction. The second drives a real
 * galaxy sector pick through the focus view and ship picker.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

test('post-auth direct room link → game surface mounts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}/?room=test-sector`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Ship stats card mounts only when the game surface has actually
  // connected and welcomed; if we hit a black-screen regression, this
  // assertion times out.
  await expect(page.locator('[data-testid="hud-sector"]')).toBeVisible({ timeout: 20_000 });

  // Sanity: no JS runtime errors fired during the transition.
  expect(errors, errors.join('\n')).toEqual([]);
});

// The galaxy-sector variant drives a real galaxy room via the
// deterministic `__eqxGalaxyPick(sectorKey)` DEV hook — the programmatic
// path the prior `fixme` comment was waiting for (landed with the
// single-canvas refactor). It mirrors a real selector-layer tap on the
// shared canvas (incl. the 200 ms tap-shield) without hex-pixel math,
// then confirms the Hangar → Launch → game-surface round-trip.
test('post-auth spawn-select → pick galaxy sector → game surface mounts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Living Galaxy P5 — the galaxy map is the landing screen on load (no meta CTA).
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

  // Drive a deterministic sector pick (Sol Prime) via the DEV hook
  // installed by GameSurface in idle mode.
  await page.waitForFunction(
    () => typeof (window as unknown as { __eqxGalaxyPick?: unknown }).__eqxGalaxyPick === 'function',
    null,
    { timeout: 8_000 },
  );
  await page.evaluate(() => {
    (window as unknown as { __eqxGalaxyPick?: (k: string) => void }).__eqxGalaxyPick?.('sol-prime');
  });

  // Equinox Phase 7 (Item 4) — a sector pick now opens the interactive popover;
  // "Join the fight" opens the Hangar (no longer one-click).
  await expect(page.getByTestId('sector-drawer-join')).toBeVisible({ timeout: 8_000 });
  await page.getByTestId('sector-drawer-join').click();
  // The picker ("Spawn in {sector}") accepts the default ship (last choice, or
  // Fighter on fresh state) via Spawn — that fires the real
  // `onSpawnNewShip` -> `handleSelectRoom` round-trip.
  await expect(page.getByTestId('hangar-window')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('hangar-launch').click();

  await expect(page.locator('[data-testid="hud-sector"]')).toBeVisible({ timeout: 20_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});
