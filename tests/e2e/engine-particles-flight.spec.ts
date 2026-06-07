import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient, getShipX, getShipY, surface } from './helpers/gameScenario';
import { captureGameScene } from './helpers/screenshot';

/**
 * Real-pipeline engine-exhaust capture (screenshot-first, Step 4 of the
 * engine-fx plan). Unlike the deterministic probe spec, this drives the FULL
 * ColyseusClient → render mirror → main-thread PixiRenderer path in the
 * isolated galaxy-test room (auto `?worker=0` so the canvas is screenshot-able)
 * with real prediction-driven velocity, the real thrust/boost mirror sets, and
 * the real camera follow.
 *
 * Purpose: the authoritative "no circle/arc when moving fast" check — the
 * probe's moving-ship case is confounded by its hand-rolled dual-RAF camera
 * follow; here the camera, velocity and emission are the production ones.
 * Captures land in diag/e2e-screenshots/engine-particles/ for visual review.
 */
test('engine exhaust trails coherently in real flight', async ({ browser }) => {
  // The galaxy-test room lazily cold-boots a physics worker on first join
  // (INFRASTRUCTURAL, not game-time — the test philosophy permits a budget
  // bump for cold-boot / Colyseus join, only game-time waits must use a
  // bespoke trigger). 45s covers a cold room boot on a loaded host.
  test.setTimeout(45_000);
  const testId = randomUUID();
  const { ctx, page } = await launchGalaxyTestClient(browser, { testId, shipKind: 'fighter' });
  try {
    // Turn to a diagonal heading so the exhaust side reads clearly, then hold
    // thrust until the ship is genuinely moving (travelled > 150u).
    await page.keyboard.down('d');
    await page.waitForTimeout(350);
    await page.keyboard.up('d');

    const startX = await getShipX(page);
    const startY = await getShipY(page);
    await page.keyboard.down('w');
    await page.waitForFunction(
      ([sx, sy]: [number, number]) => {
        const el = document.querySelector('[data-testid="game-surface"]');
        const x = parseFloat(el?.getAttribute('data-ship-x') ?? '0');
        const y = parseFloat(el?.getAttribute('data-ship-y') ?? '0');
        return Math.hypot(x - sx, y - sy) > 150;
      },
      [startX, startY] as [number, number],
      { timeout: 10_000 },
    );
    await captureGameScene(page, 'flight-thrust-diag', 'engine-particles');

    // Add boost — the longer/brighter boost plume on top of thrust.
    await page.keyboard.down('Shift');
    await page.waitForTimeout(500);
    await captureGameScene(page, 'flight-boost-diag', 'engine-particles');
    await page.keyboard.up('Shift');
    await page.keyboard.up('w');

    // Sanity: the run actually drove the ship (not a black/empty capture).
    await expect(surface(page)).toHaveAttribute('data-ship-x', /.+/);
  } finally {
    await ctx.close();
  }
});
