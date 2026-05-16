/**
 * Shield/Hull E2E — tests/e2e artifact for invariant #9 (collision-handling
 * change ⇒ an E2E in tests/e2e/). Deliberately a NON-FLAKY HUD-surface
 * smoke: it asserts the end-to-end client wiring (Zustand shieldPct/hullPct
 * → game-surface data attributes → the ShieldHullBar widget) is present and
 * sane on a fresh join. It does NOT drive cross-client combat aim — that is
 * timing/aim-flaky and, per invariant #13, the shield/hull/collision bug
 * surface lives at core/server where it is exhaustively locked:
 *   - unit: ShieldHull (no-spillover/regen), triangulate (CCW/area/golden),
 *     Weapons polygon (circle-hits-but-polygon-misses), World.setHullExposed
 *     (mass-transparent swap), Ramming (per-pair aggregation).
 *   - real-worker integration: shieldHull.test.ts (absorb→break→hull→regen,
 *     discrete-broadcast no-continuous-traffic), ramming.test.ts.
 *   - bench: weapon-hittest (shield-up == baseline).
 * The deep combat / notch-shot + feel-test-lockstep canary get their
 * authoritative run at the quiet-env green-bars gate (this dev session is
 * too host-loaded for a 6 s real-time AI sim — see docs/LESSONS.md
 * 2026-05-16; baseline-proven not a regression).
 *
 * Run: pnpm e2e --project=chromium tests/e2e/shield-hud.spec.ts
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('shield+hull HUD wiring is live end-to-end on join', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}?room=sector`);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ship-count"]');
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      { timeout: 12000 },
    );

    // Always-mounted contract surface (HudTestAttributes).
    const shieldTestId = page.locator('[data-testid="shield-pct"]');
    const hullTestId = page.locator('[data-testid="hull-pct"]');
    await expect(shieldTestId).toHaveText(/^\d+$/);
    await expect(hullTestId).toHaveText(/^\d+$/);

    // The tiny HUD widget renders with both bars + E2E hooks.
    const bar = page.locator('[data-testid="shield-hull-bar"]');
    await expect(bar).toBeVisible();
    expect(await bar.getAttribute('data-shield-pct')).toMatch(/^\d+$/);
    expect(await bar.getAttribute('data-hull-pct')).toMatch(/^\d+$/);
    await expect(bar.getByText('SHLD')).toBeVisible();
    await expect(bar.getByText('HULL')).toBeVisible();

    // Game-surface mirror (the channel combat.spec.ts reads): a fresh,
    // undamaged ship is full shield AND full hull.
    const surface = page.locator('[data-testid="game-surface"]');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="game-surface"]');
        return el?.getAttribute('data-shield-pct') === '100' && el?.getAttribute('data-hull-pct') === '100';
      },
      { timeout: 8000 },
    );
    expect(await surface.getAttribute('data-shield-pct')).toBe('100');
    expect(await surface.getAttribute('data-hull-pct')).toBe('100');
  } finally {
    await ctx.close();
  }
});
