/**
 * Contacts panel (EVE-style lock list, the right panel opened by the rail's
 * Contacts item or the O key): open the list, tap a contact, see the active
 * weapon group lock it; tap it again to cancel.
 *
 * `fc-duel` room (two fighters and a heavy, idle without `startHostile`),
 * spawned at y 1250 so all three sit ~300-350 u away, inside the guns' reach.
 * `instantLock` completes the lock on the next lock step and
 * `groupMode=manual` keeps AUTO from locking anything on its own, so the only
 * lock is the one the list asks for.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DEFAULT_BASE_URL } from './helpers/ports';
import { activeGroupId, waitForFireControlHud } from './helpers/fireControl';
import { launchGalaxyTestClient } from './helpers/gameScenario';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

// Cold join (Vite compile + Colyseus join + first snapshot) is infrastructure
// cost; the lock itself is instant.
test.describe.configure({ timeout: 60_000 });

async function boot(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/?room=fc-duel&spawnX=0&spawnY=1250&instantLock=1&groupMode=manual&initialHull=100000&testId=${randomUUID()}`);
  await waitForFireControlHud(page);
}

// The weapon chips hide while a right-side panel (Contacts) is open, so each
// chip check runs with the panel closed.
async function lockFromList(page: Page, open: () => Promise<void>, close: () => Promise<void>): Promise<void> {
  const gid = await activeGroupId(page);
  const chip = page.locator(`[data-testid="fc-chip-${gid}"]`);
  await expect(chip).toHaveAttribute('data-locked', '0');

  await open();
  const panel = page.locator('[data-testid="contacts-panel"]');
  await expect(panel).toBeVisible();
  const row = panel.locator('[data-testid^="contact-row-s:"][data-in-reach="active"]').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  // Names, never ids.
  await expect(panel).not.toContainText('s:');
  const key = (await row.getAttribute('data-key'))!;
  const target = page.locator(`[data-testid="contact-row-${key}"]`);

  await target.click();
  await expect(target).toHaveAttribute('data-lock', 'locked', { timeout: 10_000 });
  await expect(target).toHaveAttribute('data-lock-group', gid);
  await close();
  await expect(panel).toBeHidden();
  await expect(chip).toHaveAttribute('data-locked', '1');

  // Tap again: the lock is cancelled.
  await open();
  await target.click();
  await expect(target).toHaveAttribute('data-lock', 'none', { timeout: 10_000 });
  await close();
  await expect(chip).toHaveAttribute('data-locked', '0');
}

test('desktop: O opens the contacts list; a click locks with the active group, again cancels', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  try {
    await boot(page);
    await lockFromList(page, async () => { await page.keyboard.press('o'); }, async () => { await page.keyboard.press('Escape'); });
    await page.screenshot({ path: 'diag/e2e-screenshots/contacts-overview/desktop.png' });
  } finally {
    await ctx.close();
  }
});

/**
 * RTS Part A — another player's ship flown by an AI pilot is a contact and
 * locks like any player's ship. Player B joins in Command view (their hull
 * parks, AI-flown) 300 u ahead of player A; A's list shows it under its
 * `p:<shipInstanceId>` key (the server resolves that key), and a click locks it.
 */
test('another player\'s AI-flown ship is listed and locks like any player\'s ship', async ({ browser }) => {
  test.setTimeout(90_000);
  const testId = randomUUID();
  const b = await launchGalaxyTestClient(browser, { testId, shipKind: 'fighter', spawnX: 0, spawnY: 300, startMode: 'command' });
  const a = await launchGalaxyTestClient(browser, { testId, shipKind: 'fighter', spawnX: 0, spawnY: 0, instantLock: true });
  try {
    const page = a.page;
    await waitForFireControlHud(page);
    const gid = await activeGroupId(page);
    await page.keyboard.press('o');
    const panel = page.locator('[data-testid="contacts-panel"]');
    await expect(panel).toBeVisible();
    const row = panel.locator('[data-testid^="contact-row-p:"]');
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    const key = (await row.getAttribute('data-key'))!;
    // The hull's key is its shipInstanceId, never B's playerId (B flies nothing).
    expect(key).not.toBe(`p:${b.playerId}`);
    await expect(row).toHaveAttribute('data-kind', 'ship');
    await row.click();
    await expect(row).toHaveAttribute('data-lock', 'locked', { timeout: 15_000 });
    // The weapon chips hide while the panel is open.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator(`[data-testid="fc-chip-${gid}"]`)).toHaveAttribute('data-locked', '1');
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("touch landscape: the rail's Contacts item opens the list; a tap locks", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await boot(page);
    // The panel's ✕ closes it (the rightPanel flag clears).
    await lockFromList(page,
      async () => { await page.locator('[data-testid="right-rail-contacts"]').tap(); },
      async () => { await page.locator('[data-testid="contacts-panel-close"]').tap(); });
    await page.screenshot({ path: 'diag/e2e-screenshots/contacts-overview/touch-landscape.png' });
  } finally {
    await ctx.close();
  }
});
