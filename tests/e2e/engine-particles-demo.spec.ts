import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient, getShipX, getShipY, surface } from './helpers/gameScenario';
import { captureGameScene } from './helpers/screenshot';

/**
 * Engine-exhaust DEMONSTRATION + side/quality verification (real pipeline,
 * zoomed). Drives the full ColyseusClient → mirror → main-thread PixiRenderer
 * path in the galaxy-test room at zoom 2 so the particles read clearly, and
 * captures a flight progression: idle → low speed → cruise → boost. The real
 * game (not the probe, whose hand-rolled camera-follow misplaces the moving
 * plume) is the authority on which SIDE the exhaust sits and how it looks at
 * speed. Captures → diag/e2e-screenshots/engine-particles/demo-*.
 */
test('engine exhaust demo — idle → low → cruise → boost', async ({ browser }) => {
  test.setTimeout(45_000); // galaxy-room physics-worker cold-boot (infrastructural)
  const testId = randomUUID();
  const { ctx, page } = await launchGalaxyTestClient(browser, { testId, shipKind: 'fighter', zoom: 2 });
  try {
    // Idle — no thrust, clean ship (no exhaust expected).
    await captureGameScene(page, 'demo-1-idle', 'engine-particles');

    // Low speed — thrust just engaged.
    const startX = await getShipX(page);
    const startY = await getShipY(page);
    await page.keyboard.down('w');
    await page.waitForFunction(
      ([sx, sy]: [number, number]) => {
        const el = document.querySelector('[data-testid="game-surface"]');
        const x = parseFloat(el?.getAttribute('data-ship-x') ?? '0');
        const y = parseFloat(el?.getAttribute('data-ship-y') ?? '0');
        return Math.hypot(x - sx, y - sy) > 20;
      },
      [startX, startY] as [number, number],
      { timeout: 6_000 },
    );
    await captureGameScene(page, 'demo-2-low', 'engine-particles');

    // Cruise — keep thrusting until genuinely fast.
    await page.waitForFunction(
      ([sx, sy]: [number, number]) => {
        const el = document.querySelector('[data-testid="game-surface"]');
        const x = parseFloat(el?.getAttribute('data-ship-x') ?? '0');
        const y = parseFloat(el?.getAttribute('data-ship-y') ?? '0');
        return Math.hypot(x - sx, y - sy) > 250;
      },
      [startX, startY] as [number, number],
      { timeout: 8_000 },
    );
    await captureGameScene(page, 'demo-3-cruise', 'engine-particles');

    // Boost — blue-white boost plume on top of thrust.
    await page.keyboard.down('Shift');
    await page.waitForTimeout(500);
    await captureGameScene(page, 'demo-4-boost', 'engine-particles');
    await page.keyboard.up('Shift');
    await page.keyboard.up('w');

    await expect(surface(page)).toHaveAttribute('data-ship-x', /.+/);
  } finally {
    await ctx.close();
  }
});
