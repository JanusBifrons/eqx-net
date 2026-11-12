/**
 * Game time scale (stream step 4d): a sector's speed reaches the player.
 * Joining a test sector with `?timeScale=2` sets that sector's speed (room-
 * wide, testMode). The snapshot keyframe carries it, and the HUD shows "2×"
 * inside the status capsule (`data-time-scale` on the capsule). A plain join
 * shows no chip. Per-test rooms (`testId`) keep the speed from leaking.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

test.describe.configure({ timeout: 60_000 });

test('a 2× sector shows the speed chip; a 1× sector shows none', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const fast = await ctx.newPage();
    await fast.goto(`${BASE_URL}/?room=test-sector&timeScale=2&testId=${randomUUID()}`);
    await waitForInPlay(fast);
    const status = fast.locator('[data-testid="hud-status"]');
    await expect(status).toHaveAttribute('data-time-scale', '2', { timeout: 10_000 });
    await expect(fast.locator('[data-testid="hud-time-scale"]')).toHaveText('2×');

    const normal = await ctx.newPage();
    await normal.goto(`${BASE_URL}/?room=test-sector&testId=${randomUUID()}`);
    await waitForInPlay(normal);
    await expect(normal.locator('[data-testid="hud-status"]')).toHaveAttribute('data-time-scale', '1');
    await expect(normal.locator('[data-testid="hud-time-scale"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
