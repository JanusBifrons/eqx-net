import { test, expect } from '@playwright/test';

/**
 * Regression: clicking a sector on the spawn-select Galaxy Overview screen
 * (post-auth, mode='spawn') must transition into the gameplay phase and
 * mount the in-game HUD. Symptom of the bug: the screen goes black after
 * sector selection — gameplay never mounts.
 *
 * Uses the engineering-rooms-button path because it exercises the same
 * App.tsx `handleSelectRoom` callback the Pixi hex click feeds, but doesn't
 * require pixel-precise canvas interaction. If this passes but the user
 * still sees black on a Pixi click, the bug is isolated to the Pixi-side
 * onPick wiring; if it fails, the regression is in the phase transition or
 * GameSurface bootstrap.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('post-auth spawn-select → click sector → game surface mounts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Click "Join the fight" CTA on the meta-landing — pre-auth storageState
  // means the app jumps straight to phase='galaxy-map'.
  await page.locator('text=Join the fight').first().click();

  // Spawn-select screen should appear.
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

  // Pick a sector via the engineering-rooms path (deterministic, no Pixi).
  await page.locator('[data-testid="engineering-rooms-button"]').click();
  await page.locator('[data-testid="engineering-room-test-sector"]').click();

  // Ship stats card mounts only when the game surface has actually
  // connected and welcomed; if we hit a black-screen regression, this
  // assertion times out.
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 20_000 });

  // Sanity: no JS runtime errors fired during the transition.
  expect(errors, errors.join('\n')).toEqual([]);
});

// The galaxy-sector variant drives a real galaxy room via the
// deterministic `__eqxGalaxyPick(sectorKey)` DEV hook — the programmatic
// path the prior `fixme` comment was waiting for (landed with the
// single-canvas refactor). It mirrors a real selector-layer tap on the
// shared canvas (incl. the 200 ms tap-shield) without hex-pixel math,
// then confirms the ShipPickerModal → Spawn → game-surface round-trip.
test('post-auth spawn-select → pick galaxy sector → game surface mounts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('text=Join the fight').first().click();
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

  // 2026-05-10 refactor: a sector pick opens the
  // ShipPickerModal ("Spawn in {sector}"). Accept the default ship
  // (the picker pre-selects the user's last choice, or Fighter on
  // fresh state) by clicking Spawn — that's what fires the actual
  // `onSpawnNewShip` -> `handleSelectRoom` round-trip.
  await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('ship-picker-spawn').click();

  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 20_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});
