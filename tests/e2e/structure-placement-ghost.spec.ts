/**
 * Structure placement: world ghost + world-anchored confirm (smoke handoff
 * 2026-06-06, Issue 5).
 *
 * User report: "buildings don't really work … verify it places a GHOST (it
 * does NOT) and the confirm dialog is visible and clickable (it ISN'T — it's
 * UNDER the UI; I think it should be in WORLD space)."
 *
 * Two distinct defects, two tests:
 *
 *  (A) NO GHOST — `placementKind` had zero render consumers; the world ghost
 *      was the deferred follow-up. Now the renderer draws a translucent
 *      blueprint silhouette at `RenderMirror.pendingPlacementPreview` and
 *      projects it to screen (`RendererFeedback.placementScreenX/Y` →
 *      `data-placement-screen-x/y`). The pipeline running end-to-end is the
 *      ghost being drawn — we read the projected coord (the REAL artifact)
 *      and back it with a screenshot.
 *
 *  (B) CONFIRM OCCLUDED — the confirm banner portaled into `bottom-center` at
 *      `Z.hud` (10), UNDER the `Z.mobileControls` (15) thumb cluster + dial on
 *      a phone. Now it's a `position:fixed` element at z 1450, world-anchored
 *      to the ghost. Test B runs at a MOBILE viewport (390×844) — the existing
 *      `structure-build-placement.spec.ts` passes only because it runs at
 *      1280×800 where bottom-center is clear. A real `.click()` on the confirm
 *      at a phone viewport is the occlusion lock: Playwright's actionability
 *      check IS the occlusion detector (it fails if another element intercepts
 *      the pointer).
 *
 * ⚠️ AUTHORED, UNVERIFIED in the CI container (Playwright browsers blocked).
 * Run on a browser-capable host. `?worker=0` forces the main-thread renderer
 * (the OffscreenCanvas worker path screenshots black).
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinAndOpenBuild(
  browser: Browser,
  opts: { mobile: boolean },
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext(
    opts.mobile
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1280, height: 800 } },
  );
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=scout&worker=0`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  return { ctx, page };
}

function swarmCount(page: Page): Promise<number> {
  return page
    .locator('[data-testid="swarm-count"]')
    .textContent()
    .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
}

test('(A) picking a kind draws + projects the world ghost (data-placement-screen present)', async ({ browser }) => {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: false });
  try {
    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    // The ghost is drawn in the world and its pose projected to screen — the
    // REAL artifact (read what's drawn/projected, not a recompute). A numeric
    // data-placement-screen-x proves: placementKind → pendingPlacementPreview
    // → renderer drew the ghost + projected it → feedback → gameRafLoop.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-screen-x');
        return v !== null && v !== undefined && v !== '' && Number.isFinite(parseFloat(v));
      },
      undefined,
      { timeout: 5_000 },
    );
    const sx = await page.locator('[data-testid="game-surface"]').getAttribute('data-placement-screen-x');
    const sy = await page.locator('[data-testid="game-surface"]').getAttribute('data-placement-screen-y');
    expect(Number.isFinite(parseFloat(sx ?? 'NaN'))).toBe(true);
    expect(Number.isFinite(parseFloat(sy ?? 'NaN'))).toBe(true);

    // Supplementary visual evidence (the user asked for screenshots).
    await expect(page.locator('[data-testid="game-surface"]')).toHaveScreenshot('placement-ghost-capital.png', {
      maxDiffPixelRatio: 0.05,
    });
  } finally {
    await ctx.close();
  }
});

test('(B) confirm is clickable at a MOBILE viewport (world-anchored, not occluded)', async ({ browser }) => {
  const { ctx, page } = await joinAndOpenBuild(browser, { mobile: true });
  try {
    const before = await swarmCount(page);

    await expect(page.locator('[data-testid="build-capital"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="build-capital"]').click();

    const confirm = page.locator('[data-testid="placement-confirm"]');
    await expect(confirm).toBeVisible({ timeout: 5_000 });
    // A REAL click — Playwright's actionability check fails if the thumb
    // cluster / dial intercepts the pointer (the occlusion the user hit).
    await confirm.click();

    // Placement landed → swarm count climbs (kind=2 structure path).
    await page.waitForFunction(
      (b) => {
        const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
        return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
      },
      before,
      { timeout: 10_000 },
    );
    expect(await swarmCount(page)).toBeGreaterThan(before);
  } finally {
    await ctx.close();
  }
});
