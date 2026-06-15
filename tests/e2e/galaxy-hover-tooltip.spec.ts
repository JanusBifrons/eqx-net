import { test, expect } from '@playwright/test';

/**
 * Living Galaxy Phase 6 (bug-doc galaxy-map polish) — desktop hover affordance:
 * a pointer over a sector hex changes the cursor to a pointer AND shows a sector
 * tooltip (name + faction/status). `?worker=0` forces the main-thread renderer
 * (the DOM hooks + the pointermove-forward path the territory-shrink spec uses).
 *
 * FAIL on pre-Phase-6 code: there is no `__eqxGalaxyHoveredSector` hook, no
 * `galaxy-sector-tooltip`, and the cursor never changes.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

declare global {
  interface Window {
    __eqxGalaxyTransform?: () => { x: number; y: number; scale: number };
    __eqxGalaxyHoveredSector?: () => string | null;
  }
}

test('hovering a sector shows the tooltip + pointer cursor; leaving clears it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });
  await page.waitForFunction(
    () =>
      typeof window.__eqxGalaxyTransform === 'function' &&
      typeof window.__eqxGalaxyHoveredSector === 'function',
    null,
    { timeout: 6_000 },
  );
  await page.waitForTimeout(500); // let the layer settle into its steady fit

  const surface = page.locator('[data-testid="game-surface"]');
  const box = await surface.boundingBox();
  if (!box) throw new Error('game-surface bounding box not found');

  // No tooltip before any hover.
  await expect(page.locator('[data-testid="galaxy-sector-tooltip"]')).toHaveCount(0);

  // Sol Prime sits at axial (0,0) → pixel (0,0) → the clusterRoot origin, so its
  // on-canvas screen position is exactly the transform origin (same trick as
  // galaxy-living-map.spec.ts — the 21-sector bbox centre is NOT sol-prime).
  const t = await page.evaluate(() => window.__eqxGalaxyTransform!());
  const solX = box.x + t.x;
  const solY = box.y + t.y;
  await page.mouse.move(solX - 40, solY - 40);
  await page.mouse.move(solX, solY);

  await expect.poll(() => page.evaluate(() => window.__eqxGalaxyHoveredSector!()), {
    timeout: 4_000,
  }).toBe('sol-prime');

  const tooltip = page.locator('[data-testid="galaxy-sector-tooltip"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-tooltip-sector', 'sol-prime');
  // The canvas container's cursor becomes a pointer over a selectable hex.
  const cursor = await surface.evaluate((el) => (el as HTMLElement).style.cursor);
  expect(cursor).toBe('pointer');

  // Moving to the canvas centre (a DIFFERENT sector than Sol Prime, which sits
  // off-centre in the 21-sector bbox — or a gap) updates the live hover, proving
  // the worker→main hover channel tracks movement and isn't a one-shot. (A clean
  // gap → null clear is structurally guaranteed by the React conditional +
  // unit-covered; this avoids the AppHeader-occluded corner that hid the move.)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.__eqxGalaxyHoveredSector!()), {
    timeout: 4_000,
  }).not.toBe('sol-prime');

  expect(errors, errors.join('\n')).toEqual([]);
});
