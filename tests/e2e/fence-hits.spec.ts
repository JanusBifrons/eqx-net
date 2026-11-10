/**
 * Fence hits show in the game (bug, user report 2026-11-04: "the fence thing,
 * that's a bug" — shots into a shield fence vanished with no impact).
 *
 * Repro: `gate-test` room; the east gate (x 400, y -900) is owner-only, so a
 * visiting pilot spawned south of it (x 400, y -1150) faces a closed fence.
 * Holding fire sends bolts into it. With the new effects the fence must play
 * ripples (`__eqxArtStats().fxFenceHits`). `?worker=0` so the hook reads the
 * live renderer; a cold join plus the first-visit bake is the only wait.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
test.describe.configure({ timeout: 90_000 });

test('bolts fired into a closed fence ripple on it', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'gate-test', spawnX: '400', spawnY: '-1150', shipKind: 'fighter', testId: randomUUID(),
    worker: '0', art: 'machined', fx: 'new', zoom: '1',
    // Lock-to-fire (2026-11-09): anyTarget lets the AUTO group pick the
    // (non-hostile, not-ours) fence gate ahead; instantLock locks it at once.
    instantLock: '1',
    anyTarget: '1',
  });
  await page.goto(`${BASE_URL}?${params}`);
  type S = { fxFences?: number; fxFenceHits?: number };
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => S }).__eqxArtStats?.().fxFences ?? 0) > 0,
    undefined, { timeout: 60_000 });
  // Fire only counts once the loading curtain lifts: before this the 12
  // presses could all land behind the curtain and no bolt left the ship.
  await waitForInPlay(page);
  // AUTO fires at the locked gate; the presses add the active group if it is MAN.
  await page.locator('canvas').first().click({ position: { x: 640, y: 600 } });
  for (let i = 0; i < 12; i++) await page.keyboard.press('Space', { delay: 30 });
  await page.waitForFunction(() => ((window as unknown as { __eqxArtStats?: () => S }).__eqxArtStats?.().fxFenceHits ?? 0) > 0,
    undefined, { timeout: 20_000 });
  mkdirSync('diag/e2e-screenshots/fence-hits', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/fence-hits/ripple.png' });
  expect(await page.evaluate(() => (window as unknown as { __eqxArtStats: () => S }).__eqxArtStats().fxFenceHits)).toBeGreaterThan(0);
  await ctx.close();
});
