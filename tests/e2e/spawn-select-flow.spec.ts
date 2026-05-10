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

test('post-auth spawn-select → click galaxy sector → game surface mounts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('text=Join the fight').first().click();
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 15_000 });

  // Drive into a real galaxy room. The fastest non-Pixi path that hits
  // the same `handleSelectRoom('galaxy-${key}')` callback that the hex
  // click feeds is the limbo-resume button, but we don't always have a
  // limbo entry. Instead, dispatch via window.__eqxClient or by directly
  // calling the App's onSelectRoom — but neither is reachable from a
  // page-level test. Fall back to triggering the Pixi click via the
  // canvas's known hex screen position.
  const canvas = page.locator('[data-testid="galaxy-map-screen"] canvas').first();
  await expect(canvas).toBeVisible({ timeout: 5_000 });
  // Sol Prime hex sits at world (0,0) in axialToPixel; with the renderer's
  // default centre on (0,0), it lands at canvas centre. Click there.
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 20_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});
