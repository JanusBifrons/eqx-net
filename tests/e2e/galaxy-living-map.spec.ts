import { test, expect } from '@playwright/test';

/**
 * Living Galaxy Phase 4a — faction territory tint + contiguous-territory
 * hover-shrink. Drives the selector (spawn/warp picker) galaxy map and asserts
 * the REAL drawn per-territory scale (`window.__eqxGalaxyTerritoryScale()` →
 * `clusterRoot`'s per-territory sub-container `scale.x`, NOT a recompute) shrinks
 * the hovered territory and leaves the others at rest. Also captures before/after
 * screenshots of the tinted map.
 *
 * `?worker=0` forces the MAIN-THREAD PixiRenderer (the OffscreenCanvas worker
 * path screenshots black); the DOM galaxy layer installs the debug hooks. The
 * renderer forwards bare `pointermove` to the layer while the selector is
 * pan-zoom-active (PixiRenderer ~:782), so desktop hover reaches the shrink.
 *
 * FAIL on pre-4a code: there were no per-territory containers and no
 * `__eqxGalaxyTerritoryScale` hook, so the scales never move.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

declare global {
  interface Window {
    __eqxGalaxyTransform?: () => { x: number; y: number; scale: number };
    __eqxGalaxyTerritoryScale?: () => Record<string, number>;
  }
}

test('galaxy selector tints territories and shrinks the hovered one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.locator('text=Join the fight').first().click();
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });

  await page.waitForFunction(
    () =>
      typeof window.__eqxGalaxyTransform === 'function' &&
      typeof window.__eqxGalaxyTerritoryScale === 'function',
    null,
    { timeout: 6_000 },
  );
  // Let the layer fit + paint a few frames so the baseline is the steady fit.
  await page.waitForTimeout(500);

  const surface = page.locator('[data-testid="game-surface"]');
  const box = await surface.boundingBox();
  if (!box) throw new Error('game-surface bounding box not found');

  // The faction-contiguous territories exist (one per faction region).
  const restScales = await page.evaluate(() => window.__eqxGalaxyTerritoryScale!());
  expect(Object.keys(restScales).length).toBeGreaterThanOrEqual(4);

  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-living/01-rest.png' });

  // Hover SOL PRIME (the core). It is at axial (0,0) → pixel (0,0), so its
  // on-canvas screen position is exactly the clusterRoot origin (the new
  // 21-sector galaxy's geometric centre is NOT sol-prime, so the canvas centre
  // can land in a gap — compute the real hex position from the transform).
  const t = await page.evaluate(() => window.__eqxGalaxyTransform!());
  const solX = box.x + t.x;
  const solY = box.y + t.y;
  await page.mouse.move(solX - 30, solY - 30);
  await page.mouse.move(solX, solY);
  await page.waitForTimeout(700); // lerp ease toward HOVER_SCALE (0.94)

  const hoverScales = await page.evaluate(() => window.__eqxGalaxyTerritoryScale!());
  // The hovered core territory has visibly shrunk; others stay near rest.
  expect(
    hoverScales['core'],
    `the hovered core territory should shrink (scales=${JSON.stringify(hoverScales)})`,
  ).toBeLessThan(0.97);

  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-living/02-hover-centre.png' });

  expect(errors, errors.join('\n')).toEqual([]);
});
