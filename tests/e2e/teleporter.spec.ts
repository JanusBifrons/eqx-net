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
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
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
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
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

/**
 * v4 T2 — the pilot rides. Spawn ON the west pad, fire it: the doors-closing
 * warning shows, the ship arrives on the east pad (x ≈ +1300), and it stays
 * there (the client re-seeds its prediction at the new pose; no snap back).
 */
test('a pilot on the pad is warned, rides the jump, and stays on the far pad', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  await ctx.addInitScript((pid) => {
    try { localStorage.setItem('eqxPlayerId', pid as string); } catch { /* ignore */ }
  }, OWNER);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=teleport-test&testId=${randomUUID()}&worker=0&spawnX=-1300&spawnY=-60`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );
  const shipX = (): Promise<number> => page.evaluate(() => {
    const m = (window as unknown as { __eqxClient?: { mirror?: { localPlayerId?: string; ships: Map<string, { x: number }> } } }).__eqxClient?.mirror;
    return m?.localPlayerId ? (m.ships.get(m.localPlayerId)?.x ?? NaN) : NaN;
  });
  await expect.poll(shipX, { timeout: 10_000 }).toBeLessThan(-900);

  await expect.poll(() => page.evaluate(() => (window as unknown as EqxWindow).__eqxSelectAtWorld?.(-1300, 250) ?? null), { timeout: 10_000 }).not.toBeNull();
  const panel = page.getByTestId('tp-panel');
  await expect(panel).toHaveAttribute('data-charge-pct', '100', { timeout: 30_000 });
  await page.getByTestId('tp-fire').click();

  await expect(page.getByTestId('teleport-warning')).toBeVisible({ timeout: 5_000 });
  await expect.poll(shipX, { timeout: 10_000 }).toBeGreaterThan(900);
  // It stays: sample for a second, never back on the west side.
  for (let i = 0; i < 10; i++) {
    expect(await shipX()).toBeGreaterThan(900);
    await page.waitForTimeout(100);
  }
  await ctx.close();
});

/**
 * v4 T4 — tolls. The owner sets a toll on the west pad from the inspector; a
 * rider (another pilot, with credits) on that pad is offered it when the pad
 * arms, pays, and their wallet goes down.
 *
 * The answer must land before the swap settles the toll, so this uses the
 * half-speed `teleport-toll-test` room (~6 s from arming to the swap), and the
 * rider renders off the main thread (no `worker=0`): two main-thread renderers
 * on one box starved the rider page and its click took up to 11 s.
 */
test('a rider is offered the owner’s toll and pays it', async ({ browser }) => {
  test.setTimeout(150_000);
  const testId = randomUUID();
  const ownerCtx = await browser.newContext();
  await ownerCtx.addInitScript((pid) => {
    try { localStorage.setItem('eqxPlayerId', pid as string); } catch { /* ignore */ }
  }, OWNER);
  const owner = await ownerCtx.newPage();
  await owner.goto(`${BASE_URL}?room=teleport-toll-test&testId=${testId}&worker=0&spawnX=0&spawnY=650`);
  await owner.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );
  await expect.poll(() => owner.evaluate(() => (window as unknown as EqxWindow).__eqxSelectAtWorld?.(-1300, 250) ?? null), { timeout: 10_000 }).not.toBeNull();
  await expect(owner.getByTestId('tp-panel')).toBeVisible({ timeout: 10_000 });
  await owner.getByTestId('tp-toll').selectOption('50');

  const riderCtx = await browser.newContext();
  const rider = await riderCtx.newPage();
  await rider.goto(`${BASE_URL}?room=teleport-toll-test&testId=${testId}&spawnX=-1300&spawnY=-60&initialWallet=1000`);
  await rider.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );
  await expect(rider.getByTestId('wallet-chip')).toHaveAttribute('data-wallet', '1000', { timeout: 10_000 });

  await expect(owner.getByTestId('tp-panel')).toHaveAttribute('data-charge-pct', '100', { timeout: 30_000 });
  await owner.getByTestId('tp-fire').click();
  const prompt = rider.getByTestId('toll-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });
  const credits = Number(await prompt.getAttribute('data-credits'));
  expect(credits).toBeGreaterThan(0);
  await rider.getByTestId('toll-pay').click();
  await expect(rider.getByTestId('wallet-chip')).toHaveAttribute('data-wallet', String(1000 - credits), { timeout: 10_000 });
  await riderCtx.close();
  await ownerCtx.close();
});
