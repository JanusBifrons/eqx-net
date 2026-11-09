/**
 * Auto-fire (weapon-autofire-boost-mechanics, Part B).
 *
 * With auto-fire ON (the default), the active weapon fires automatically at an
 * in-range HOSTILE target with NO player input. Locks:
 *   1. Hostile in range  → auto-fires (beam goes active) with zero input.
 *   2. NEUTRAL drone      → does NOT auto-fire (hostile-only decision), but
 *      manual fire (Space) still works as an override.
 *   3. Neutral → fire ONCE manually to damage it → it becomes hostile →
 *      auto-fire takes over with NO further input (the realistic galaxy flow).
 *
 * Uses the dedicated `auto-fire-test` room: one peaceful, hull-exposed drone
 * 150 u ahead of the spawn (within beam range 250). `?startHostile=1` flags it
 * hostile to the joining player. Interceptor fires the hitscan beam so the
 * `data-beam-active` HUD attribute is the fire signal.
 *
 * Why this is the right level (smoke handoff 2026-06-06, Issue 4): the user
 * reported "auto-fire doesn't work" — but the code is hostile-only BY DESIGN
 * (it won't engage a neutral drone the player has never shot; matches
 * docs/features/auto-fire-and-boost.md). The report was a quiet sector, not a
 * bug. These cases LOCK that contract: B proves neutral-holds (the reported
 * symptom is correct behaviour) and C proves the engage-after-first-contact
 * flow the player actually expects. No fire-path change.
 *
 * The toggle-OFF UI path is covered in the AutoFireToggleButton commit.
 */
import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getBeamActive, waitForInPlay } from './helpers/gameScenario';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

async function joinAutoFire(browser: Browser, opts: { startHostile: boolean }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'auto-fire-test',
    shipKind: 'interceptor', // fires the hitscan beam → data-beam-active
    initialHull: '5000', // survive the drone's return fire long enough to auto-fire
    testId: randomUUID(),
  });
  if (opts.startHostile) params.set('startHostile', '1');
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    }, undefined,
    { timeout: 12000 },
  );
  // Input and auto-fire only run once the loading curtain lifts.
  await waitForInPlay(page);
  return { ctx, page };
}

test('auto-fires at an in-range hostile with NO input (default ON)', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: true });
  try {
    // No keyboard / touch input at all — the beam must go active on its own
    // once the hostile drone (150 u ahead) is acquired.
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 8000 },
    );
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await ctx.close();
  }
});

test('toggling AUTO off stops auto-fire at a hostile (manual override still works)', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: true });
  try {
    // Confirm it auto-fires first (AUTO defaults ON).
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 8000 },
    );
    // Turn AUTO off via the toggle — auto-fire must stop.
    await page.locator('[data-testid="auto-fire-toggle"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '0',
      undefined,
      { timeout: 5000 },
    );
    expect(await getBeamActive(page)).toBe(false);

    // Manual fire still works with AUTO off.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 5000 },
    );
    await page.keyboard.up('Space');
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

test('does NOT auto-fire at a NEUTRAL drone, but manual fire still works', async ({ browser }) => {
  const { ctx, page } = await joinAutoFire(browser, { startHostile: false });
  try {
    // Give auto-fire ample time to (wrongly) engage the non-hostile drone.
    await page.waitForTimeout(1500);
    expect(await getBeamActive(page)).toBe(false);

    // Manual fire override still works even with auto-fire on.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 5000 },
    );
    await page.keyboard.up('Space');
    expect(await getBeamActive(page)).toBe(true);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

test('neutral drone: fire once → it turns hostile → auto-fire takes over with no further input', async ({ browser }) => {
  // The realistic galaxy flow (smoke handoff 2026-06-06, Issue 4): a player
  // flies up to a neutral drone, fires once to make first contact, and from
  // then on auto-fire should keep engaging it without holding the button.
  const { ctx, page } = await joinAutoFire(browser, { startHostile: false });
  try {
    // 1) Neutral + no input → auto-fire correctly holds (hostile-only).
    await page.waitForTimeout(1200);
    expect(await getBeamActive(page)).toBe(false);

    // 2) Make first contact: a manual burst lands a hit on the drone 150 u
    //    ahead → the `damage` handler calls markHostile → the drone is now
    //    hostile to this player. Release on the FIRST server-confirmed hit.
    const localId = (await page.locator('[data-testid="game-surface"]').getAttribute('data-local-player-id')) ?? '';
    type Ev = { ts: number; tag: string; data: Record<string, unknown> };
    const ourEvents = async (tag: string): Promise<Ev[]> => {
      const res = await fetch(`${SERVER_URL}/dev/events?limit=500`);
      const body = (await res.json()) as { events?: Ev[] };
      return (body.events ?? []).filter((e) => e.tag === tag && e.data['shooterId'] === localId);
    };
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 5000 },
    );
    await expect
      .poll(async () => (await ourEvents('damage_applied')).length > 0,
        { timeout: 5000, intervals: [50], message: 'the manual burst should land a hit on the drone' })
      .toBe(true);
    await page.keyboard.up('Space');
    const releasedAt = Date.now();

    // 3) With NO further input, auto-fire keeps shooting: the server keeps
    //    receiving our fire after the release. (Read on the server, not off
    //    `data-beam-active`: the fighter has 150 hull and the twin beam deals
    //    26 a trigger at 6 Hz, so auto-fire takes over within a frame or two
    //    of the first hit and kills the drone in about a second. The old
    //    "beam drops to 0, then comes back to 1" check only ever saw the
    //    drop: by then the drone was scrap — 2026-11-08 probe.) The 150 ms
    //    margin keeps a manual shot already in flight at the release out.
    await expect
      .poll(async () => (await ourEvents('fire_received')).filter((e) => e.ts > releasedAt + 150).length,
        { timeout: 5000, intervals: [100], message: 'auto-fire should keep firing at the now-hostile drone with no input' })
      .toBeGreaterThan(0);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});
