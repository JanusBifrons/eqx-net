import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './helpers/ports';

/**
 * Regression lock for the Phase 1 (2026-05-12) galaxy polish.
 *
 * SHIPPED BEHAVIOUR THIS SPEC LOCKS:
 *  1. The Galaxy Map screen (`galaxy-map-screen`, the homepage) carries no
 *     old splash-style "Equinox" banner / hero copy over the map (the
 *     standalone splash screen was deleted when the map became the homepage).
 *  (The former FullscreenCTA lock was retired when the component was
 *   deleted: full screen is offered only by FullscreenToggle, whose
 *   "Tap for full screen" label shows briefly when a phone turns sideways.)
 *
 * (The former "default zoom is 0.7 via data-galaxy-zoom" lock was
 *  retired with the single-canvas refactor: the spawn picker now renders
 *  on the shared gameplay canvas via GalaxyMapLayer's selector mode — a
 *  static screen-space fit with no free-pan/zoom viewport, so there is no
 *  zoom attribute to assert.)
 *
 * WHAT CHANGING WOULD RE-FAIL THIS:
 *  - Putting the marketing banner back on the post-auth landing.
 *
 * This is a UNCOVERED→COVERED test: there is no user bug report behind
 * it. Smoke-testing the marketing-text-on-spawn case would feel obvious
 * to a human; this lock keeps it that way.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

async function goToGalaxyMap(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Living Galaxy P5 — the galaxy map is the landing screen on load (no meta CTA).
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({
    timeout: 15_000,
  });
}

test('galaxy-map-screen: no Equinox banner inside the spawn-mode landing', async ({ page }) => {
  test.setTimeout(25_000);
  await goToGalaxyMap(page);

  const screen = page.locator('[data-testid="galaxy-map-screen"]');
  // No splash heading (h2 "Equinox") over the map.
  await expect(
    screen.locator('h2', { hasText: 'Equinox' }),
    'Equinox marketing banner must not appear on the galaxy-map screen. ' +
      'Check any new <Typography variant="h2"> added under `GalaxyPickerChrome`.',
  ).toHaveCount(0);

  // The body text inside index.html `<title>Equinox</title>` is fine —
  // we only assert there's no rendered marketing heading in the map screen.
  const innerText = await screen.innerText();
  expect(
    innerText.toLowerCase(),
    'Galaxy-map-screen body must not contain "multiplayer space combat" tagline. ' +
      'Source of regression: the old splash tagline copied onto the map.',
  ).not.toContain('multiplayer space combat');
});
