/**
 * AUTO weapon groups (lock-to-fire, universal since 2026-11-09).
 *
 * The legacy auto-fire toggle is gone. A weapon group in AUTO mode (the
 * default for most slots) picks + LOCKS a HOSTILE target in reach and inside
 * its arc, then fires on its own; nothing ever fires at an unlocked target.
 * Locks:
 *   1. Hostile in range  → the AUTO group locks it and fires with zero input.
 *   2. NEUTRAL drone     → AUTO does NOT lock it (hostile-only pick), and Space
 *      held does not fire either (no lock, no fire).
 *   3. Neutral → LOCK it from its info box → the finished failsafe lock is the
 *      hostile act (drone turns hostile) → the group fires with no further
 *      input (the realistic "first contact" flow, which used to be one manual
 *      shot).
 *
 * Uses the `auto-fire-test` room: one peaceful, hull-exposed fighter 150 u
 * ahead of spawn. `?startHostile=1` flags it hostile to the joining player.
 * Deliberately NO `instantLock`: this spec is about the real AUTO pick (an
 * instantLock AUTO group would also pick the neutral drone), so lock waits
 * here are real lock time (a few seconds), not pacing.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getBeamActive, waitForInPlay } from './helpers/gameScenario';
import { activeGroupId, lockOn, waitForFireControlHud } from './helpers/fireControl';
import { DEFAULT_BASE_URL, DEFAULT_SERVER_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? DEFAULT_SERVER_URL;
/** Real lock time: a few s hostile; ~10 s neutral (failsafe ring + lock). */
const LOCK_MS = 20_000;

test.describe.configure({ timeout: 60_000 });

async function joinAutoFire(browser: Browser, opts: { startHostile: boolean }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'auto-fire-test',
    shipKind: 'interceptor', // fires the hitscan beam → data-beam-active
    initialHull: '5000',
    testId: randomUUID(),
  });
  if (opts.startHostile) params.set('startHostile', '1');
  await page.goto(`${BASE_URL}?${params}`);
  await waitForInPlay(page);
  await waitForFireControlHud(page);
  return { ctx, page };
}

type Ev = { ts: number; tag: string; data: Record<string, unknown> };
async function ourEvents(page: Page, tag: string): Promise<Ev[]> {
  const localId = (await page.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id')) ?? '';
  const res = await fetch(`${SERVER_URL}/dev/events?limit=500`);
  const body = (await res.json()) as { events?: Ev[] };
  return (body.events ?? []).filter((e) => e.tag === tag && e.data['shooterId'] === localId);
}

test('AUTO group locks an in-range hostile and fires with NO input', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: true });
  try {
    const gid = await activeGroupId(page);
    const chip = page.locator(`[data-testid="fc-chip-${gid}"]`);
    await expect(chip).toHaveAttribute('data-mode', 'auto');
    await expect(chip).toHaveAttribute('data-locked', '1', { timeout: LOCK_MS });
    await expect
      .poll(async () => (await ourEvents(page, 'fire_received')).length, { timeout: 8_000, intervals: [100], message: 'the AUTO group should fire at its lock' })
      .toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test('AUTO does NOT lock a NEUTRAL drone, and Space never fires without a lock', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: false });
  try {
    const gid = await activeGroupId(page);
    const chip = page.locator(`[data-testid="fc-chip-${gid}"]`);
    await page.keyboard.down('Space');
    // Longer than a hostile lock takes: an AUTO pick of the neutral would have
    // started (acquiring) and Space would have fired by now if either were wrong.
    await page.waitForTimeout(2500);
    await page.keyboard.up('Space');
    await expect(chip).toHaveAttribute('data-locked', '0');
    await expect(chip).toHaveAttribute('data-acquiring', '0');
    expect(await getBeamActive(page)).toBe(false);
    expect(await ourEvents(page, 'damage_applied')).toHaveLength(0);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

test('neutral drone: LOCK it → it turns hostile → the AUTO group fires with no further input', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: false });
  try {
    await lockOn(page, 'first-drone', { timeoutMs: LOCK_MS });
    await expect
      .poll(async () => (await ourEvents(page, 'damage_applied')).length, { timeout: 8_000, intervals: [100], message: 'the locked group should fire and hit the drone' })
      .toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
