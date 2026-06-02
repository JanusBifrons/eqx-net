/**
 * Weapon loadout E2E suite (weapons/energy/AI overhaul §5.2 — reworked from
 * the old per-weapon-picker suite).
 *
 * The per-weapon picker (Beam/Laser boxes + 1/2/Q hotkeys) is GONE. Each ship
 * fires its catalogue-bound loadout (scout/fighter/heavy/gunship → bolts,
 * interceptor → beams, missile-frigate → missiles) and the pilot selects the
 * active SLOT via the MUI SlotSelector. This suite asserts:
 *   1. No per-weapon picker; a single-slot toggle is present.
 *   2. A bolt ship (scout) fires PROJECTILES, never a hitscan beam.
 *   3. A beam ship (interceptor) fires a hitscan BEAM.
 *   4. The bolt ghost is cleaned up after expiry (no stuck duplicates).
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/weapon-switching.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser, shipKind = 'scout') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // test-sector-fast (testMode, no drones, testTimeScale=10) compresses
  // ghost-TTL + projectile lifetime to a few hundred ms wall-clock.
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=${shipKind}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12000 },
  );
  return { ctx, page };
}

function surface(page: Page) {
  return page.locator('[data-testid="game-surface"]');
}

async function getBeamActive(page: Page): Promise<boolean> {
  return (await surface(page).getAttribute('data-beam-active')) === '1';
}

async function getProjectileCount(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-projectile-count')) ?? '0', 10);
}

// ---------------------------------------------------------------------------
// 1. No per-weapon picker; the slot selector is present
// ---------------------------------------------------------------------------
test('slot selector replaces the per-weapon picker', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await page.waitForTimeout(500);
    // The old per-weapon boxes are gone.
    await expect(page.locator('[data-testid="weapon-selector"]')).toHaveCount(0);
    // The slot selector is mounted (single-slot ships show one toggle).
    await expect(page.locator('[data-testid="slot-selector"]')).toBeVisible({ timeout: 3000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. A bolt ship fires PROJECTILES, never a hitscan beam
// ---------------------------------------------------------------------------
test('a scout (bolt loadout) fires projectiles, not a beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await page.waitForTimeout(500);
    await page.keyboard.down('Space');
    await page.waitForTimeout(600);
    expect(await getBeamActive(page)).toBe(false);
    expect(await getProjectileCount(page)).toBeGreaterThan(0);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 3. A beam ship fires a hitscan BEAM
// ---------------------------------------------------------------------------
test('an interceptor (beam loadout) fires a hitscan beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'interceptor');
  try {
    await page.waitForTimeout(500);
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      { timeout: 1000 },
    );
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Regression: bolt ghost sprites are cleaned up after expiry
// ---------------------------------------------------------------------------
test('bolt ghost sprites are cleaned up after expiry — no static duplicates', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    await page.waitForTimeout(500);
    await page.keyboard.down('Space');
    await page.waitForTimeout(50);
    await page.keyboard.up('Space');
    await page.waitForFunction(
      () => parseInt(document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-projectile-count') ?? '0', 10) > 0,
      { timeout: 2000 },
    );
    await page.waitForTimeout(5000);
    // The point is the ghost ISN'T stuck at its spawn position.
    expect(await getProjectileCount(page)).toBe(0);
  } finally {
    await ctx.close();
  }
});
