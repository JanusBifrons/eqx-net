/**
 * 2026-06-03 deterministic rewrite (test-coverage-audit Phase 3) — the original
 * joined the LIVE `galaxy-sol-prime` room (persistent cross-run state + Living
 * World bots at non-deterministic positions) with `diag=1`/`autocapture=1`,
 * violating the "engineering room only / no live galaxy" rules.
 *
 * Regression lock for the 2026-05-31 respawn-cascade input-routing bug
 * (captures `7eqj1a` "pinning after respawn" + `hlqxy6` "4 client_constructed
 * / 3 dispose_complete"): after a galaxy-map sector-pick respawn cascade,
 * inputs must still reach the server and MOVE the ship. The capture showed the
 * orphaned-client leak on the SECOND cascade cycle, so we drive TWO cycles and
 * assert thrust moves the ship after each.
 *
 * Determinism strategy:
 *   - Join the engineering `cascade-test` room (4 drones) with `startHostile=1`
 *     so the drones actively attack — reproducing the BOT-PRESSURE the bug
 *     needed (its own docstring: "the no-hostility variant passed in
 *     feel-test-25 — bug only repros under bot pressure").
 *   - Pair it with a huge `initialHull` so the player SURVIVES the pressure:
 *     the hostile fire still drives the damage/aggro state-churn the cascade
 *     cleanup must tolerate, but the player never dies, so the thrust-moves-the-
 *     ship assertion stays deterministic (a dead ship can't move).
 *   - Drive the cascade via the DEV-only `__eqxTriggerRespawnCascade()` hook
 *     (gated on `import.meta.env.DEV`, NOT on diag) — the same App.tsx
 *     game→connecting→game phase cycle a real sector-pick triggers, reachable
 *     without clicking the Pixi-rendered galaxy map. The cascade re-reads the
 *     URL params, so each rejoin keeps startHostile + the survivable hull.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { getShipX, getShipY } from './helpers/gameScenario';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function waitForHandshake(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-loading-active="0"]') !== null,
    { timeout: 15_000 },
  );
  // Settle the join-broadcast grace + first snapshot before sampling.
  await page.waitForTimeout(1000);
}

async function triggerCascade(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __eqxTriggerRespawnCascade?: () => void }).__eqxTriggerRespawnCascade?.();
  });
}

async function thrustDisplacement(page: Page): Promise<number> {
  const startX = await getShipX(page);
  const startY = await getShipY(page);
  await page.keyboard.down('w');
  await page.waitForTimeout(500);
  await page.keyboard.up('w');
  await page.waitForTimeout(150); // drain the input ack
  const endX = await getShipX(page);
  const endY = await getShipY(page);
  return Math.hypot(endX - startX, endY - startY);
}

test('respawn cascade: thrust moves the ship after TWO respawn cycles under bot pressure', async ({
  page,
}) => {
  test.setTimeout(60_000);

  const params = new URLSearchParams({
    room: 'cascade-test',
    startHostile: '1',
    initialHull: '90000', // survive the hostile fire for the whole test
    spawnX: '0',
    spawnY: '0',
    testId: `respawn-cascade-${randomUUID()}`,
  });
  await page.goto(`${BASE_URL}/?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitForHandshake(page);

  // Baseline: thrust moves the ship before any cascade (the original couldn't
  // run this — galaxy-sol-prime bots killed the player first; the survivable
  // hull lets us lock the pre-cascade input path too).
  expect(await thrustDisplacement(page), 'baseline: thrust must move the ship').toBeGreaterThan(1);

  // First respawn cascade.
  await triggerCascade(page);
  await waitForHandshake(page);
  expect(
    await thrustDisplacement(page),
    'thrust must move the ship after the FIRST respawn cascade',
  ).toBeGreaterThan(1);

  // Second respawn cascade — the cycle the capture showed orphaning the
  // ColyseusGameClient (inputs routed to a dead room reference → ship pinned).
  await triggerCascade(page);
  await waitForHandshake(page);
  expect(
    await thrustDisplacement(page),
    'thrust must move the ship after the SECOND respawn cascade (the regression)',
  ).toBeGreaterThan(1);
});
