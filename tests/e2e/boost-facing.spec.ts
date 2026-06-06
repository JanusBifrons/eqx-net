/**
 * Boost is a facing-direction thrust, independent of movement input
 * (weapon-autofire-boost-mechanics, Part A).
 *
 * Before: boost only multiplied forward thrust and ONLY applied while also
 * thrusting (`throttle > 0`), so it felt tied to the movement/stick direction.
 * After: holding boost (Shift) ALWAYS pushes the ship along its facing vector,
 * with no thrust held. Forward = (-sin θ, cos θ); spawned at angle 0 ⇒ forward
 * is +Y, so a pure-boost hold must increase the ship's Y with X ~unchanged.
 *
 * Also locks A5: boost now drains the energy pool even without thrust (the
 * client predicts an energy-gated boost mirroring the server's strip), so a
 * boost-only hold visibly drops `data-energy-pct`.
 *
 * No bespoke time-skip needed — we wait on the movement STATE (waitForFunction
 * on data-ship-y), never a wall-clock pace (test-harness philosophy).
 */
import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchTestClient, getShipX, getShipY } from './helpers/gameScenario';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

/** Mirror energy-bar.spec's proven join: direct nav to the fast room, wait for
 *  the LOCAL player id to be established (energy hydrates with it). */
async function joinFast(browser: Browser, shipKind: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
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

test('boost alone (no thrust) accelerates the ship forward along its facing', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, {
    spawnX: 0,
    spawnY: 0,
    initialAngle: 0, // forward = +Y
    shipKind: 'fighter', // boostMultiplier 2.0
    testId: randomUUID(),
  });
  try {
    const x0 = await getShipX(page);
    const y0 = await getShipY(page);

    // Hold boost ONLY (no W). Wait for the ship to travel forward (+Y) past a
    // clear threshold, with a generous deadline — this is the state we're
    // testing, not a paced wait.
    await page.keyboard.down('Shift');
    await page.waitForFunction(
      (startY) => parseFloat(document.querySelector('[data-testid="game-surface"]')
        ?.getAttribute('data-ship-y') ?? '0') > (startY as number) + 40,
      y0,
      { timeout: 8000 },
    );
    await page.keyboard.up('Shift');

    const x1 = await getShipX(page);
    const y1 = await getShipY(page);

    // Moved forward (+Y) under boost-with-no-thrust.
    expect(y1 - y0).toBeGreaterThan(40);
    // Stayed on-axis (no sideways drift from a boost that ignored facing).
    expect(Math.abs(x1 - x0)).toBeLessThan(20);
  } finally {
    await page.keyboard.up('Shift').catch(() => undefined);
    await ctx.close();
  }
});

test('boost without thrust drains the energy pool (A5 energy gate is live)', async ({ browser }) => {
  // Mirror energy-bar.spec: fast room (10x cadence) + a settle so the bar
  // reads its hydrated spawn-full value, not a first-frame transient.
  const { ctx, page } = await joinFast(browser, 'scout');
  try {
    await expect(page.locator('[data-testid="energy-bar"]')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(400);
    const before = parseInt(
      (await page.locator('[data-testid="energy-bar"]').getAttribute('data-energy-pct')) ?? '0',
      10,
    );
    expect(before).toBeGreaterThan(80);

    // Hold boost only — energy must drop because boost now drains regardless
    // of thrust (and the client predicts that drain).
    await page.keyboard.down('Shift');
    const drained = await page.waitForFunction(
      (b) => parseInt(document.querySelector('[data-testid="energy-bar"]')
        ?.getAttribute('data-energy-pct') ?? '100', 10) < (b as number) - 10,
      before,
      { timeout: 8000 },
    );
    await page.keyboard.up('Shift');
    expect(drained).toBeTruthy();
  } finally {
    await page.keyboard.up('Shift').catch(() => undefined);
    await ctx.close();
  }
});
