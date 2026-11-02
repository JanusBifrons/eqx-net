/**
 * v4 A — alien gates through the real UI. The `alien-gate-test` room seeds one
 * Ancients' gate at the origin; the pilot spawns inside its zone.
 *
 *  - Selecting the gate shows its owner (The Ancients), and no pairing offer:
 *    alien gates only link to each other.
 *  - Firing inside the zone disables the pilot: the "Systems disabled" chip
 *    appears, driven by the own-ship snapshot's `disabledMs` (#16).
 *
 * The engines-off input gate itself is locked by `tests/unit/disableParity`
 * (both sides use one shared function) and the integration tests.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

type EqxWindow = { __eqxSelectAtWorld?: (x: number, y: number) => string | null };

test('an alien gate disables a pilot who fires in its zone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${BASE_URL}?room=alien-gate-test&testId=${randomUUID()}&worker=0`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '',
    { timeout: 90_000 },
  );

  // The gate: owned by the Ancients, no "ask to pair".
  await expect.poll(() => page.evaluate(() => (window as unknown as EqxWindow).__eqxSelectAtWorld?.(0, 0) ?? null), { timeout: 10_000 }).not.toBeNull();
  await expect(page.getByTestId('entity-stats-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('entity-stats-owner')).toContainText('Ancients');
  await expect(page.getByTestId('tp-foreign-panel')).toHaveCount(0);

  // Fire inside the zone → disabled.
  await page.keyboard.down('Space');
  try {
    await expect(page.getByTestId('ship-disabled')).toBeVisible({ timeout: 10_000 });
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
  }
  expect(Number(await page.getByTestId('ship-disabled').getAttribute('data-seconds'))).toBeGreaterThan(0);
});
