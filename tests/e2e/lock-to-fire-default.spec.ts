/**
 * Lock-to-fire is the DEFAULT for every pilot (2026-11-09: the `?ui=d` opt-in
 * and the legacy HUDs are gone). A plain join — no `?ui=`, no `instantLock` —
 * shows the fire-control HUD, and the server refuses fire without a completed
 * lock on the group's target:
 *   - the weapon strip chips render, the legacy auto-fire toggle does not;
 *   - a MAN group with no lock: Space held → no beam, no hit on the drone;
 *   - LOCK the drone from its info box → Space now fires and damage lands.
 *
 * `auto-fire-test` room, NO `startHostile`: the parked fighter is neutral, so
 * the AUTO pick never takes it and the only lock is the one this spec makes.
 * The group is put in MAN anyway so the Space path (not AUTO) is under test.
 * The LOCK wait is real lock time (a neutral target runs the failsafe ring).
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getBeamActive, waitForInPlay } from './helpers/gameScenario';
import { fcChips, lockOn, toManual, waitForFireControlHud } from './helpers/fireControl';
import { DEFAULT_BASE_URL, DEFAULT_SERVER_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? DEFAULT_SERVER_URL;

test.describe.configure({ timeout: 60_000 });

async function ourEvents(page: Page, tag: string): Promise<number> {
  const localId = (await page.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id')) ?? '';
  const res = await fetch(`${SERVER_URL}/dev/events?limit=500`);
  const body = (await res.json()) as { events?: Array<{ tag: string; data: Record<string, unknown> }> };
  return (body.events ?? []).filter((e) => e.tag === tag && e.data['shooterId'] === localId).length;
}
const ourHits = (page: Page) => ourEvents(page, 'damage_applied');

test('default join: fire-control HUD, no fire before LOCK, fires after LOCK', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/?room=auto-fire-test&shipKind=interceptor&initialHull=5000&testId=${randomUUID()}`);
    await waitForInPlay(page);
    await waitForFireControlHud(page);
    expect(await fcChips(page).count()).toBeGreaterThan(0);
    await expect(page.locator('[data-testid="auto-fire-toggle"]')).toHaveCount(0);

    const gid = await toManual(page);
    const chip = page.locator(`[data-testid="fc-chip-${gid}"]`);

    // No lock → Space held fires nothing.
    await page.keyboard.down('Space');
    await page.waitForTimeout(1500);
    expect(await getBeamActive(page)).toBe(false);
    await page.keyboard.up('Space');
    await expect(chip).toHaveAttribute('data-locked', '0');
    expect(await ourEvents(page, 'fire_received')).toBe(0);
    expect(await ourHits(page)).toBe(0);

    // LOCK the drone → Space fires and lands.
    await lockOn(page, 'first-drone');
    await page.keyboard.down('Space');
    await expect.poll(() => ourHits(page), { timeout: 5_000, intervals: [100] }).toBeGreaterThan(0);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});
