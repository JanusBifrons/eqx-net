/**
 * v4 T1 — teleporters through the real UI. The `teleport-test` room seeds a
 * powered Capital (50 alloy) with a teleporter on each side, already paired,
 * owned by a fixed id this test joins as. Cycles run 10× fast and the grid
 * pulses every 100 ms (bespoke triggers), so the whole flow takes seconds.
 *
 * Select the west teleporter → its panel shows it paired → wait for the
 * capacitor → load 10 alloy onto the pad → Fire → the cycle runs and the pad
 * empties (its hold swapped to the partner, which unloads into storage).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OWNER = 'face0000-0000-4000-8000-000000000002';

type EqxWindow = { __eqxSelectAtWorld?: (x: number, y: number) => string | null };

test('pair, charge, load and fire a teleporter from the inspector', async ({ browser }) => {
  test.setTimeout(120_000); // infrastructural: a cold server + Vite join
  const ctx = await browser.newContext();
  await ctx.addInitScript((pid) => {
    try { localStorage.setItem('eqxPlayerId', pid as string); } catch { /* ignore */ }
  }, OWNER);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=teleport-test&testId=${randomUUID()}&worker=0&spawnX=0&spawnY=900`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 90_000 },
  );

  // Select the west teleporter; its panel is in the inspector.
  await expect.poll(() => page.evaluate(() => (window as unknown as EqxWindow).__eqxSelectAtWorld?.(-1300, 0) ?? null), { timeout: 10_000 }).not.toBeNull();
  const panel = page.getByTestId('tp-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toHaveAttribute('data-paired', '1');

  // Spare power fills the capacitor.
  await expect(panel).toHaveAttribute('data-charge-pct', '100', { timeout: 30_000 });

  // Load 10 alloy from base storage onto the pad.
  await page.getByTestId('tp-load-good').selectOption('alloy');
  await page.getByTestId('tp-load').click();
  const pad = page.getByTestId('tp-pad');
  await expect.poll(async () => Number(await pad.getAttribute('data-pad-weight')), { timeout: 5_000 }).toBeGreaterThan(0);

  // Fire: the cycle runs, then the pad is empty (its hold went to the partner).
  await page.getByTestId('tp-fire').click();
  await expect.poll(async () => Number(await panel.getAttribute('data-phase')), { timeout: 5_000 }).toBeGreaterThan(0);
  await expect(panel).toHaveAttribute('data-phase', '0', { timeout: 10_000 });
  await expect(pad).toHaveAttribute('data-pad-weight', '0', { timeout: 5_000 });
  // The firing end spent its charge.
  await expect.poll(async () => Number(await panel.getAttribute('data-charge-pct')), { timeout: 2_000 }).toBeLessThan(100);
  await ctx.close();
});
