/**
 * Auto-fire (weapon-autofire-boost-mechanics, Part B).
 *
 * With auto-fire ON (the default), the active weapon fires automatically at an
 * in-range HOSTILE target with NO player input. Locks:
 *   1. Hostile in range  → auto-fires (beam goes active) with zero input.
 *   2. NEUTRAL drone      → does NOT auto-fire (hostile-only decision), but
 *      manual fire (Space) still works as an override.
 *
 * Uses the dedicated `auto-fire-test` room: one peaceful, hull-exposed drone
 * 150 u ahead of the spawn (within beam range 250). `?startHostile=1` flags it
 * hostile to the joining player. Interceptor fires the hitscan beam so the
 * `data-beam-active` HUD attribute is the fire signal.
 *
 * The toggle-OFF UI path is covered in the AutoFireToggleButton commit.
 */
import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getBeamActive } from './helpers/gameScenario';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinAutoFire(browser: Browser, opts: { startHostile: boolean }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'auto-fire-test',
    shipKind: 'interceptor', // fires the hitscan beam → data-beam-active
    initialHull: '5000', // survive the drone's return fire long enough to auto-fire
    testId: randomUUID(),
  });
  if (opts.startHostile) params.set('startHostile', '1');
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12000 },
  );
  return { ctx, page };
}

test('auto-fires at an in-range hostile with NO input (default ON)', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: true });
  try {
    // No keyboard / touch input at all — the beam must go active on its own
    // once the hostile drone (150 u ahead) is acquired.
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 8000 },
    );
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await ctx.close();
  }
});

test('toggling AUTO off stops auto-fire at a hostile (manual override still works)', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: true });
  try {
    // Confirm it auto-fires first (AUTO defaults ON).
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 8000 },
    );
    // Turn AUTO off via the toggle — auto-fire must stop.
    await page.locator('[data-testid="auto-fire-toggle"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '0',
      undefined,
      { timeout: 5000 },
    );
    expect(await getBeamActive(page)).toBe(false);

    // Manual fire still works with AUTO off.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 5000 },
    );
    await page.keyboard.up('Space');
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

test('does NOT auto-fire at a NEUTRAL drone, but manual fire still works', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: false });
  try {
    // Give auto-fire ample time to (wrongly) engage the non-hostile drone.
    await page.waitForTimeout(1500);
    expect(await getBeamActive(page)).toBe(false);

    // Manual fire override still works even with auto-fire on.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 5000 },
    );
    await page.keyboard.up('Space');
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});
