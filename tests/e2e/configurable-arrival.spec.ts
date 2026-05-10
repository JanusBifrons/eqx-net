import { test, expect, devices } from '@playwright/test';

/**
 * Configurable hyperspace arrival picker (Phase: configurable-arrival, 2026-05-10).
 *
 * The mobile-only picker lives in the right-edge drawer's Galaxy tab.
 * These specs cover the UI surface (mode toggle, per-mode disabled state,
 * blur clamp + toast, persistence). Wire/server behaviour — the optional
 * `arrival` field on `EngageTransitSchema` and the LimboPayload override
 * inside `TransitOrchestrator.commitTransit` — is locked in by the
 * vitest unit suite (`src/server/transit/TransitOrchestrator.test.ts`).
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
// The arrival picker only renders inside the in-game drawer, so we boot
// straight into a sector via the `?room=` deep-link escape hatch the E2E
// suite uses elsewhere. test-sector is an engineering room (sectorKey===null)
// — that's fine for UI assertions; the wire payload is not actually sent
// until the user opens the galaxy map and picks a neighbour, which we do
// not exercise here.
const BOOT_URL = `${BASE_URL}/?room=test-sector`;

async function bootGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BOOT_URL);
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 10_000 });
  await page.locator('[data-testid="ship-stats-card"]').waitFor({ timeout: 10_000 });
}

async function openGalaxyTab(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="drawer-toggle"]').click();
  await expect(page.locator('[data-testid="advanced-drawer"]')).toBeVisible();
  // Galaxy is the default tab; click anyway to be explicit.
  await page.locator('[data-testid="drawer-tab-galaxy"]').click();
  await expect(page.locator('[data-testid="drawer-panel-galaxy"]')).toBeVisible();
}

test.describe('configurable-arrival picker', () => {
  test('mobile: picker renders with three modes and defaults to "same"', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await openGalaxyTab(page);

    const toggle = page.locator('[data-testid="arrival-mode-toggle"]');
    await expect(toggle).toBeVisible();
    // All three pills present.
    await expect(page.locator('[data-testid="arrival-mode-xy"]')).toBeVisible();
    await expect(page.locator('[data-testid="arrival-mode-same"]')).toBeVisible();
    await expect(page.locator('[data-testid="arrival-mode-home"]')).toBeVisible();
    // Default mode is `same` → "Same" pill is selected.
    await expect(page.locator('[data-testid="arrival-mode-same"]')).toHaveAttribute('aria-pressed', 'true');
    // Inputs are present but disabled in `same`.
    await expect(page.locator('[data-testid="arrival-x-input"]')).toBeDisabled();
    await expect(page.locator('[data-testid="arrival-y-input"]')).toBeDisabled();

    await ctx.close();
  });

  test('mobile: switching to X/Y enables the inputs; switching to Home disables them and shows 0/0', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await openGalaxyTab(page);

    // X/Y mode → inputs editable.
    await page.locator('[data-testid="arrival-mode-xy"]').click();
    await expect(page.locator('[data-testid="arrival-x-input"]')).toBeEnabled();
    await expect(page.locator('[data-testid="arrival-y-input"]')).toBeEnabled();

    // Home mode → inputs disabled, value is 0/0.
    await page.locator('[data-testid="arrival-mode-home"]').click();
    const xInput = page.locator('[data-testid="arrival-x-input"]');
    const yInput = page.locator('[data-testid="arrival-y-input"]');
    await expect(xInput).toBeDisabled();
    await expect(yInput).toBeDisabled();
    await expect(xInput).toHaveValue('0');
    await expect(yInput).toHaveValue('0');

    await ctx.close();
  });

  test('mobile: out-of-bounds X/Y blurs to clamped value and shows the toast', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await openGalaxyTab(page);

    await page.locator('[data-testid="arrival-mode-xy"]').click();
    const xInput = page.locator('[data-testid="arrival-x-input"]');
    await xInput.fill('999999');
    // Trigger blur by clicking somewhere else inside the panel.
    await page.locator('[data-testid="drawer-panel-galaxy"]').click({ position: { x: 5, y: 5 } });
    // Clamped to +5000 (SECTOR_PLAYABLE_HALF_EXTENT) — no decimals.
    await expect(xInput).toHaveValue('5000');
    // Toast appears with the warning text.
    const toast = page.locator('[data-testid="arrival-clamp-toast"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/clamped/i);

    await ctx.close();
  });

  test('mobile: in-bounds X/Y is preserved on blur (no toast)', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await openGalaxyTab(page);

    await page.locator('[data-testid="arrival-mode-xy"]').click();
    const xInput = page.locator('[data-testid="arrival-x-input"]');
    const yInput = page.locator('[data-testid="arrival-y-input"]');
    await xInput.fill('123');
    await yInput.fill('-456');
    await page.locator('[data-testid="drawer-panel-galaxy"]').click({ position: { x: 5, y: 5 } });
    await expect(xInput).toHaveValue('123');
    await expect(yInput).toHaveValue('-456');
    // Toast must NOT appear — there was nothing to clamp.
    await expect(page.locator('[data-testid="arrival-clamp-toast"]')).toHaveCount(0);

    await ctx.close();
  });

  test('mobile: arrival mode + X/Y values persist across reload (per-user localStorage)', async ({ browser }) => {
    const iPhone = devices['iPhone SE'];
    const ctx = await browser.newContext({ ...iPhone, viewport: { width: 375, height: 667 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await openGalaxyTab(page);

    await page.locator('[data-testid="arrival-mode-xy"]').click();
    await page.locator('[data-testid="arrival-x-input"]').fill('250');
    await page.locator('[data-testid="arrival-y-input"]').fill('-750');
    // Blur to commit + persist.
    await page.locator('[data-testid="drawer-panel-galaxy"]').click({ position: { x: 5, y: 5 } });

    // Reload, re-open the tab, confirm state is restored.
    await page.reload();
    await page.waitForSelector('[data-testid="game-surface"]', { timeout: 10_000 });
    await page.locator('[data-testid="ship-stats-card"]').waitFor({ timeout: 10_000 });
    await openGalaxyTab(page);

    await expect(page.locator('[data-testid="arrival-mode-xy"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="arrival-x-input"]')).toHaveValue('250');
    await expect(page.locator('[data-testid="arrival-y-input"]')).toHaveValue('-750');

    await ctx.close();
  });

  test('desktop: drawer Galaxy tab also surfaces the picker (PC users may flip it too)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await bootGame(page);
    await openGalaxyTab(page);

    // Picker is part of the Galaxy tab, not gated by mobile breakpoint.
    await expect(page.locator('[data-testid="arrival-mode-toggle"]')).toBeVisible();
    // Default is `same` (the legacy departure-pose behaviour). PC users
    // get the picker if they want to use it, but the wire-default keeps
    // PC unchanged unless they intentionally switch modes.
    await expect(page.locator('[data-testid="arrival-mode-same"]')).toHaveAttribute('aria-pressed', 'true');

    await ctx.close();
  });
});
