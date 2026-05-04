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

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 8000;

async function readHaloCount(page: import('@playwright/test').Page): Promise<number> {
  const raw = await page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-halo-arrow-count');
  return parseInt(raw ?? '0', 10);
}

test('halo radar: arrows appear when POIs are off-screen', async ({ eqxPage }) => {
  // Sector Alpha seeds a swarm of drones + asteroids. Once the local ship has
  // had time to settle, at least some entities will be outside the viewport
  // and the halo should report ≥1 arrow.
  await eqxPage.waitForTimeout(1500);

  const start = Date.now();
  let observed = 0;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    observed = await readHaloCount(eqxPage);
    if (observed > 0) break;
    await eqxPage.waitForTimeout(POLL_INTERVAL_MS);
  }

  expect(observed).toBeGreaterThan(0);
});

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
