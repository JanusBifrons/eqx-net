/**
 * Weapon switching E2E suite — verifies weapon selector UI, keyboard hotkeys,
 * and that the laser weapon fires projectiles (not hitscan beams).
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/weapon-switching.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=sector`);
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
// 1. Weapon selector is visible in game
// ---------------------------------------------------------------------------
test('weapon selector boxes are visible', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(500);
    // WeaponSelector renders two boxes with text 'Beam' and 'Laser'.
    const beam = page.getByText('Beam');
    const laser = page.getByText('Laser');
    await expect(beam).toBeVisible({ timeout: 3000 });
    await expect(laser).toBeVisible({ timeout: 3000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Pressing 2 switches to laser and fires projectiles (no hitscan beam)
// ---------------------------------------------------------------------------
test('pressing 2 switches to laser — fire produces projectiles, not beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(500);

    // Switch to laser.
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(100);

    // Hold fire.
    await page.keyboard.down('Space');
    await page.waitForTimeout(600); // enough for cooldown + ghost spawn

    // Beam should NOT be active (laser is projectile mode).
    expect(await getBeamActive(page)).toBe(false);

    // At least one projectile should have spawned (ghost or server-authoritative).
    const count = await getProjectileCount(page);
    expect(count).toBeGreaterThan(0);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Pressing 1 switches back to hitscan — beam reappears
// ---------------------------------------------------------------------------
test('pressing 1 switches back to hitscan beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(500);

    // Switch to laser then back to hitscan.
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(100);
    await page.keyboard.press('Digit1');
    await page.waitForTimeout(100);

    // Hold fire — beam should appear.
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
// 4. Regression: laser ghost sprites do not persist after expiry
// ---------------------------------------------------------------------------
test('laser ghost sprites are cleaned up after expiry — no static duplicates', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(500);

    // Switch to laser.
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(100);

    // Tap fire once (single shot).
    await page.keyboard.down('Space');
    await page.waitForTimeout(50);
    await page.keyboard.up('Space');

    // Wait for ghost to spawn.
    await page.waitForFunction(
      () => parseInt(document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-projectile-count') ?? '0', 10) > 0,
      { timeout: 2000 },
    );

    // Wait for the ghost TTL + server projectile lifetime to elapse.
    // Ghost TTL is 500ms; server projectile maxTicks=240 (4s at 60Hz).
    // 5s ensures both are fully cleaned up regardless of interest-range timing.
    await page.waitForTimeout(5000);

    // All projectiles should be gone (ghost cleaned up, server proj out of range).
    const count = await getProjectileCount(page);
    // Allow 0 — the point is the ghost ISN'T stuck at its spawn position.
    // If the old bug were present, count would be ≥ 1 (the stale ghost).
    expect(count).toBe(0);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Regression: switching from hitscan to laser clears the beam
// ---------------------------------------------------------------------------
test('switching weapon while firing clears the hitscan beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(500);

    // Start firing hitscan.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      { timeout: 1000 },
    );
    expect(await getBeamActive(page)).toBe(true);

    // Switch to laser while still holding space.
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(200);

    // Beam must be gone — laser is projectile mode.
    expect(await getBeamActive(page)).toBe(false);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Q cycles weapons
// ---------------------------------------------------------------------------
test('Q cycles weapon forward', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(500);

    // Default is hitscan. Q should switch to laser.
    await page.keyboard.press('KeyQ');
    await page.waitForTimeout(100);

    // Fire — should NOT produce hitscan beam.
    await page.keyboard.down('Space');
    await page.waitForTimeout(400);
    expect(await getBeamActive(page)).toBe(false);
    await page.keyboard.up('Space');

    // Q again → back to hitscan.
    await page.keyboard.press('KeyQ');
    await page.waitForTimeout(100);
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
