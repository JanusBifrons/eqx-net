// @diag (manual-only): see docs/architecture/e2e-framework.md
// Run: pnpm e2e:diag tests/diag/drawer-keepmounted-probe.spec.ts
import { test, expect } from '@playwright/test';

/**
 * 2026-05-14 — Hypothesis 1 probe for the drawer-keepMounted contract.
 *
 * AdvancedDrawer uses `ModalProps.keepMounted: true` (commit `2aa7d4f`)
 * + `SlideProps.mountOnEnter: false` (commit `f81e129`). The intent is
 * that the active tab's content lives in DOM from page-load, not from
 * first-drawer-open. This probe verifies that contract WITHOUT clicking
 * the drawer toggle.
 *
 * Read result via the spec's stdout (the `HYP1:` log line) OR the
 * Playwright HTML report's expectation messages:
 *
 *   - Both assertions pass: keepMounted is doing its job. The failure
 *     in `drawer-galaxy-overview-spawn.spec.ts` is something downstream
 *     (Pixi tick starving Playwright's CDP loop — Hypothesis 2). Next
 *     step: profile a steady-state frame to confirm `update` >8 ms,
 *     try `app.ticker.maxFPS = 30` as a diagnostic.
 *
 *   - panelCount=0: the tabpanel host isn't in DOM at all → either the
 *     Modal's keepMounted isn't being honoured or the active panel
 *     mount is gated on `open`. Investigate MUI's Drawer source.
 *
 *   - panelCount=1, childCount=0: tabpanel host exists but its child
 *     subtree is deferred → MUI Slide's internal `<Transition>` is
 *     still deferring child mount despite `mountOnEnter: false`.
 *     Read `node_modules/@mui/material/Slide/Slide.js` for the `appear`/
 *     `enter`/`exit` chain. Hypothesis 3.
 *
 * See `docs/HANDOFF-drawer-perf-2026-05-13.md` for hypothesis priority
 * order. Marathon-recovery plan Phase 3 step 2.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('keepMounted contract: drawer-panel-galaxy is in DOM before any drawer click', async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // Auto-spawned via ?galaxy URL param. Wait for proof we're in game.
  await expect(page.locator('[data-testid="sector-info-panel"]')).toBeVisible({
    timeout: 25_000,
  });

  // CRITICAL: do NOT click the drawer toggle here.
  //
  // With `ModalProps.keepMounted=true` on the AdvancedDrawer, the Modal
  // infrastructure (incl. the active tabpanel) should already be in the
  // DOM. The Modal is hidden via CSS (`visibility: hidden`) when
  // `open={false}`, but its children remain queryable by testid.
  const panelCount = await page
    .locator('[data-testid="drawer-panel-galaxy"]')
    .count();
  const childCount = await page
    .locator('[data-testid="galaxy-tab-show-map"]')
    .count();

  // eslint-disable-next-line no-console
  console.log(
    `HYP1 RESULT: drawer-panel-galaxy=${panelCount}, galaxy-tab-show-map=${childCount}`,
  );

  expect(
    panelCount,
    'drawer-panel-galaxy not in DOM at page-load — keepMounted is NOT pre-mounting the tabpanel',
  ).toBe(1);
  expect(
    childCount,
    'galaxy-tab-show-map not in DOM at page-load — Slide is deferring child mount despite mountOnEnter:false',
  ).toBe(1);
});
