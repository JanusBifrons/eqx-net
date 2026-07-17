import { test, expect } from '@playwright/test';

/**
 * Living Galaxy Phase 4a + Equinox Phase 9 (item 1) + campaign 4.4 (review
 * A15 / Part D #13) — DYNAMIC contiguous-territory grouping from LIVE
 * ownership. Drives the selector (spawn/warp picker) galaxy map and asserts
 * the REAL drawn per-territory scale (`window.__eqxGalaxyTerritoryScale()` →
 * `clusterRoot`'s per-territory sub-container `scale.x`, NOT a recompute).
 *
 * Campaign 4.4: `resolveSectorOwner` now derives ownership from the live
 * `/galaxy/snapshot` state (v1 producers stamp each sector's REGION faction),
 * so once the landing stats arrive the map groups into the REGION territories
 * (core + the three frontier regions) instead of one flat NEUTRAL blob — the
 * pre-fix state this spec used to lock, in which the map could never show two
 * owners as two territories.
 *
 * With 2+ territories the per-territory hover-shrink ENGAGES (the designed
 * behaviour `hoverShrinkTargetScale` locks at the unit level): hovering the
 * core shrinks ONLY the core territory; the frontier regions stay at rest —
 * the Phase-3 #1 "global flinch" can't recur because the shrink is scoped to
 * one territory. (The "sole territory must not shrink" rule remains
 * unit-locked in `hoverShrinkTargetScale`; it simply no longer describes the
 * live map.)
 *
 * `?worker=0` forces the MAIN-THREAD PixiRenderer (the OffscreenCanvas worker
 * path screenshots black); the DOM galaxy layer installs the debug hooks. The
 * renderer forwards bare `pointermove` to the layer while the selector is
 * pan-zoom-active (PixiRenderer ~:782), so desktop hover reaches the shrink.
 *
 * FAIL on pre-4.4 code: the resolver ignored live state, so the only territory
 * key was 'neutral' — the multi-territory wait below timed out.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

declare global {
  interface Window {
    __eqxGalaxyTransform?: () => { x: number; y: number; scale: number };
    __eqxGalaxyTerritoryScale?: () => Record<string, number>;
  }
}

test('galaxy selector groups LIVE region owners into territories; hover shrinks ONLY the hovered one (campaign 4.4)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  // Living Galaxy P5 — the galaxy map is the landing screen on load (no meta CTA).
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });

  await page.waitForFunction(
    () =>
      typeof window.__eqxGalaxyTransform === 'function' &&
      typeof window.__eqxGalaxyTerritoryScale === 'function',
    null,
    { timeout: 6_000 },
  );
  // Campaign 4.4 — once the landing stats poll lands, live ownership re-groups
  // the map into the region territories. Pre-fix this never happened: the only
  // key was 'neutral' and this wait TIMED OUT.
  await page.waitForFunction(
    () => {
      const scales = window.__eqxGalaxyTerritoryScale!();
      return Object.keys(scales).length >= 2 && 'core' in scales;
    },
    null,
    { timeout: 8_000 },
  );
  // Let the layer fit + paint a few frames so the baseline is the steady fit.
  await page.waitForTimeout(500);

  const surface = page.locator('[data-testid="game-surface"]');
  const box = await surface.boundingBox();
  if (!box) throw new Error('game-surface bounding box not found');

  // Every territory sits at rest (~1.0) before any hover.
  const restScales = await page.evaluate(() => window.__eqxGalaxyTerritoryScale!());
  for (const [owner, scale] of Object.entries(restScales)) {
    expect(scale, `territory ${owner} at rest (scales=${JSON.stringify(restScales)})`).toBeGreaterThan(0.97);
  }

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
  // With multiple territories, the hovered CORE territory shrinks…
  expect(
    hoverScales['core'],
    `the hovered core territory shrinks (scales=${JSON.stringify(hoverScales)})`,
  ).toBeLessThan(0.99);
  // …while the un-hovered frontier regions stay at rest (no global flinch).
  for (const owner of ['verdant-reach', 'crimson-expanse', 'azure-deep']) {
    if (hoverScales[owner] === undefined) continue;
    expect(
      hoverScales[owner],
      `un-hovered territory ${owner} stays at rest (scales=${JSON.stringify(hoverScales)})`,
    ).toBeGreaterThan(0.97);
  }

  await page.screenshot({ path: 'diag/e2e-screenshots/galaxy-living/02-hover-centre.png' });

  expect(errors, errors.join('\n')).toEqual([]);
});
