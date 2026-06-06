import { test, expect } from '@playwright/test';

/**
 * Galaxy map pan/zoom restored (2026-06-06). The single-canvas refactor
 * dropped free pan/pinch/wheel-zoom from the spawn/warp picker (selector
 * mode) — the user relies on it. This restores it by driving the screen-space
 * `clusterRoot` with the same hand-rolled `Camera` as the world view.
 *
 * The observable is the REAL drawn transform (`window.__eqxGalaxyTransform()`
 * → `clusterRoot.x/y/scale`), NOT a recompute — per the `data-beam-from`
 * lesson (a recompute would pass even if the rendered map never moved).
 *
 * Touch viewport ⇒ App selects the MAIN-THREAD PixiRenderer (the user's phone
 * path) ⇒ the DOM galaxy layer + the `__eqxGalaxyTransform` hook exist.
 *
 * FAIL on the pre-fix code: the selector was a static screen-space fit, so a
 * drag / wheel left `clusterRoot` unchanged → the deltas below are ~0.
 */
test.use({ hasTouch: true, isMobile: true, viewport: { width: 914, height: 411 } });

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface GalaxyTransform { x: number; y: number; scale: number }
declare global {
  interface Window { __eqxGalaxyTransform?: () => GalaxyTransform }
}

test('galaxy selector supports drag-pan and wheel-zoom', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.locator('text=Join the fight').first().click();
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });

  // The DOM galaxy layer installs this hook in idle/selector mode.
  await page.waitForFunction(() => typeof window.__eqxGalaxyTransform === 'function', null, { timeout: 6_000 });
  // Let the layer fit + paint a couple frames so the baseline is the steady fit.
  await page.waitForTimeout(400);

  const t0 = await page.evaluate(() => window.__eqxGalaxyTransform!());
  expect(t0.scale, 'galaxy fit applied a non-zero scale').toBeGreaterThan(0);

  const box = await page.locator('[data-testid="game-surface"]').boundingBox();
  if (!box) throw new Error('game-surface bounding box not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // ── Drag to PAN ──────────────────────────────────────────────────────────
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx - i * 14, cy - i * 9);
  await page.mouse.up();
  await page.waitForTimeout(250); // momentum/tick settle

  const t1 = await page.evaluate(() => window.__eqxGalaxyTransform!());
  const panDelta = Math.abs(t1.x - t0.x) + Math.abs(t1.y - t0.y);
  expect(
    panDelta,
    `drag should pan clusterRoot (Δx=${(t1.x - t0.x).toFixed(1)}, Δy=${(t1.y - t0.y).toFixed(1)}); ` +
      'pre-fix static fit leaves it unchanged',
  ).toBeGreaterThan(20);

  // ── Wheel to ZOOM ────────────────────────────────────────────────────────
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -600); // zoom in
  await page.waitForTimeout(400); // wheel ease runs in the layer's tick()

  const t2 = await page.evaluate(() => window.__eqxGalaxyTransform!());
  expect(
    t2.scale,
    `wheel should change clusterRoot scale (was ${t1.scale.toFixed(3)}, now ${t2.scale.toFixed(3)})`,
  ).toBeGreaterThan(t1.scale * 1.05);

  expect(errors, errors.join('\n')).toEqual([]);
});
