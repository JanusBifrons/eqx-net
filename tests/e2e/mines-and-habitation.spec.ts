/**
 * Mine Layer + habitat stations (plan soft-leaping-truffle v3) through the
 * real client.
 *
 *  1. `npc-base-stronghold`: the NPC stronghold's Mine Layer lays mines from
 *     its stocked munitions, and they reach the client through room state
 *     (`mirror.mines`).
 *  2. `npc-base-colony`: a habitat station's habitation modules reach the
 *     client, and the Build menu's Habitation category offers both modules.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

type Mirror = {
  mines?: Map<string, { x: number; y: number; own: boolean }>;
  swarm?: Map<number, { kind: number; shipKind?: string }>;
};
type EqxWindow = { __eqxClient?: { mirror?: Mirror } };

async function join(page: Page, room: string): Promise<void> {
  await page.goto(`${BASE_URL}?room=${room}&testId=${randomUUID()}&shipKind=scout&worker=0`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-local-player-id') ?? '') !== '', undefined,
    { timeout: 90_000 },
  );
}

test("an NPC stronghold's Mine Layer lays mines that reach the client", async ({ page }) => {
  test.setTimeout(120_000);
  await join(page, 'npc-base-stronghold');
  const mines = (): Promise<Array<{ own: boolean }>> =>
    page.evaluate(() => [...((window as unknown as EqxWindow).__eqxClient?.mirror?.mines?.values() ?? [])].map((m) => ({ own: m.own })));
  await expect.poll(async () => (await mines()).length, { timeout: 20_000 }).toBeGreaterThan(0);
  // They are the NPC base's mines, not the visitor's.
  expect((await mines()).every((m) => m.own === false)).toBe(true);
});

test('a habitat station shows its habitation modules; the Build menu offers both', async ({ page }) => {
  test.setTimeout(120_000);
  await join(page, 'npc-base-colony');
  const kinds = (): Promise<string[]> =>
    page.evaluate(() => {
      const out: string[] = [];
      for (const [, s] of (window as unknown as EqxWindow).__eqxClient?.mirror?.swarm ?? []) if (s.kind === 2 && s.shipKind) out.push(s.shipKind);
      return out;
    });
  await expect.poll(async () => (await kinds()).filter((k) => k === 'habitat_module').length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await kinds()).toContain('tower_module');

  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  await page.locator('[data-testid="build-cat-habitation"]').click();
  await expect(page.locator('[data-testid="build-habitat_module"]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-testid="build-tower_module"]')).toBeVisible();
});
