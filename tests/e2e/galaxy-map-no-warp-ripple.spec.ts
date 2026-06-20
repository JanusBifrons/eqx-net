import { test, expect } from '@playwright/test';

/**
 * #7 — the remote-warp ripple must NOT bleed onto the galaxy map.
 *
 * The WarpFilterChain is attached to the shared `app.stage`; the GalaxyMapLayer
 * (full-screen selector OR in-game additive overlay) is a child of that same
 * stage, so a stage-level warp filter distorts the hexes the player is reading
 * whenever a remote ship warps in/out. The `pendingWarpEvents` drain in
 * `PixiRenderer.update` now guards `triggerWarpIn` on the pure
 * `shouldFireRemoteWarpVisual` decision — skipping the cosmetic visual entirely
 * while the map is open.
 *
 * This spec asserts the production gate deterministically via the
 * `__eqxRemoteWarpVisualWouldFire()` DEV hook (the EXACT decision the drain
 * applies against the live `_galaxyLayer.visible`): the galaxy map is the
 * landing screen, so the gate must report `false` (suppressed) while it's up.
 *
 * `?worker=0` forces the MAIN-THREAD PixiRenderer (the hook is DOM-path only).
 *
 * NOTE (orchestrator): WRITTEN-NOT-RUN in the worktree — E2E/dev-server are not
 * run here (parallel agents collide on ports). Runs in CI.
 *
 * FAIL on pre-#7 code: the drain fired `triggerWarpIn` unconditionally, so the
 * gate would report `true` even with the map open (no hook existed; this spec is
 * the regression lock for the wiring).
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

declare global {
  interface Window {
    __eqxRemoteWarpVisualWouldFire?: () => boolean;
  }
}

test('remote-warp ripple is suppressed while the galaxy map is open (#7)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE_URL}?worker=0`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  // Living Galaxy P5 — the galaxy map is the landing screen on load.
  await expect(page.locator('[data-testid="galaxy-map-screen"]')).toBeVisible({ timeout: 12_000 });

  await page.waitForFunction(
    () => typeof window.__eqxRemoteWarpVisualWouldFire === 'function',
    null,
    { timeout: 6_000 },
  );
  // Let the layer become visible + paint a few frames.
  await page.waitForTimeout(400);

  // The galaxy map is up → a remote-warp event must NOT fire its ripple.
  const wouldFire = await page.evaluate(() => window.__eqxRemoteWarpVisualWouldFire!());
  expect(wouldFire, 'remote-warp ripple must be suppressed while the galaxy map is open').toBe(false);

  expect(errors, errors.join('\n')).toEqual([]);
});
