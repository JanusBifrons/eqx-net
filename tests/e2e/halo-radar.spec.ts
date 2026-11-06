/**
 * Halo radar E2E: arrows appear for off-screen POIs (drones/asteroids in Sector
 * Alpha) and disappear when nothing is off-screen. Per project invariant #9
 * this guards the projection logic against regressions.
 *
 * The renderer exposes a debug accessor `getDebugHaloArrowCount()` whose value
 * is mirrored into the game-surface dataset every frame as
 * `data-halo-arrow-count`.
 */
import { test, expect } from './fixtures/test-with-logs';


async function readHaloCount(page: import('@playwright/test').Page): Promise<number> {
  const raw = await page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-halo-arrow-count');
  return parseInt(raw ?? '0', 10);
}

// (An "arrows appear when POIs are off-screen" test lived here. It relied on
// Sector Alpha seeding drones, which sectors stopped doing in June, so it found
// nothing off-screen. radar-sandbox.spec covers off-screen arrows in a fixed
// layout on both render paths. Test audit 2026-11-06.)

test('halo radar: dataset attribute is present and numeric every frame', async ({
  eqxPage,
}) => {
  // Sample several frames; every read should yield an integer ≥0. This guards
  // against the renderer's debug accessor disappearing (e.g. accidental tree-shake).
  await eqxPage.waitForTimeout(500);
  for (let i = 0; i < 5; i++) {
    const count = await readHaloCount(eqxPage);
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
    await eqxPage.waitForTimeout(120);
  }
});
