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

// The galaxy-sector variant uses a canvas-centre click to target Sol Prime.
// Post-refactor the renderer centers on the bbox of ALL sectors (not Sol
// Prime), so canvas-centre is between hexes — the click doesn't reliably
// land on one. Plus the click now opens the ShipPickerModal (a new
// confirmation step) before spawning. Marked `fixme` until either:
//   (a) the renderer exposes a debug hook to programmatically open the
//       picker for a given sectorKey (clean), OR
//   (b) the spec computes the hex's actual on-screen position from the
//       renderer's published axial layout (more brittle).
// The engineering-sector variant above passes and exercises the same
// post-`handleSelectRoom` server flow.
// (e2e-rebuild Phase 5 repair queue, 2026-05-20.)
test.fixme('post-auth spawn-select → click galaxy sector → game surface mounts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('text=Join the fight').first().click();
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

  // Drive into a real galaxy room. The Pixi hex click is the only
  // page-reachable path — there's no programmatic shortcut to
  // `handleSelectRoom('galaxy-${key}')`. Sol Prime sits at world (0,0)
  // and the renderer's default centre is also (0,0), so the canvas
  // centre is its on-screen position.
  const canvas = page.locator('[data-testid="galaxy-map-screen"] canvas').first();
  await expect(canvas).toBeVisible({ timeout: 5_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // 2026-05-10 refactor: clicking a sector hex now opens the
  // ShipPickerModal ("Spawn in {sector}"). Accept the default ship
  // (the picker pre-selects the user's last choice, or Fighter on
  // fresh state) by clicking Spawn — that's what fires the actual
  // `onSpawnNewShip` -> `handleSelectRoom` round-trip.
  await expect(page.getByTestId('ship-picker-modal')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('ship-picker-spawn').click();

  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 20_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});
