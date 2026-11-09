/**
 * Factions F3 (plan soft-leaping-truffle v4) — the Factions tab through the
 * real client and server: it lists the factions with standing both ways, and
 * the player's own policy round-trips through `set_faction_policy` →
 * `GET /trade/factions`.
 *
 * Uses the default `page` fixture (the e2e login), so the tab has a player id.
 * The turret effect of a policy is locked in
 * tests/integration/sectorRoom/factionStanding.test.ts.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

test('Factions tab lists standings and saves the player’s policy', async ({ page }) => {
  test.setTimeout(120_000); // infrastructural: a cold server + Vite join
  await page.goto(`${BASE_URL}?room=trade-test&testId=${randomUUID()}&newShip=1`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );

  await page.getByTestId('drawer-toggle').click();
  await page.getByTestId('drawer-tab-factions').click();
  await expect(page.getByTestId('factions-tab')).toBeVisible();
  // The fixed factions are always listed, by name.
  await expect(page.getByTestId('faction-row').filter({ hasText: 'Sol Dominion' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('faction-row').filter({ hasText: 'Traders' })).toBeVisible();

  // Set "turrets fire below −25"; the server stores it and the next fetch shows it.
  await page.getByTestId('faction-policy-hostile-button').click();
  await page.getByRole('option', { name: '-25' }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const id = localStorage.getItem('eqxAccountPlayerId') ?? localStorage.getItem('eqxPlayerId') ?? '';
    const r = await fetch(`/trade/factions?playerId=${encodeURIComponent(id)}`);
    return ((await r.json()) as { policy: { hostileBelow: number | null } }).policy.hostileBelow;
  }), { timeout: 10_000 }).toBe(-25);
  await expect(page.getByTestId('faction-policy-hostile')).toHaveValue('-25');
});
